const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Input, Markup } = require('telegraf');
const { adminAuth } = require('../middleware/adminAuth');
const logger = require('../utils/logger');

function registerAdminHandlers(bot, db) {
  const authorize = adminAuth(db);

  bot.command('admin', authorize, async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    const parts = ctx.message.text
      .replace(/^\/admin(?:@\w+)?\s*/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) {
      await ctx.reply([
        '<b>Administrator commands</b>',
        '/admin groups — list groups (global administrators)',
        '/admin global_stats — all-group totals (global administrators)',
        '/admin group_admin_add &lt;group_id&gt; &lt;user_id&gt; — grant access',
        '/admin group_admin_remove &lt;group_id&gt; &lt;user_id&gt; — revoke access',
        '/admin global_admin_add &lt;user_id&gt; / /admin global_admin_remove &lt;user_id&gt;',
        '/admin stats [group_id] — group and referral totals',
        '/admin users [page] [group_id] — registered group members',
        '/admin search &lt;ID|username&gt; [group_id] — find a group member',
        '/admin user &lt;ID|username&gt; [group_id] — member referral details',
        '/admin top [group_id] — top inviters',
        '/admin claims [group_id] — pending group reward claims',
        '/admin reward &lt;threshold&gt; &lt;amount&gt; [group_id]',
        '/admin disable_reward &lt;threshold&gt; [group_id]',
        '/admin adjust &lt;ID&gt; &lt;delta&gt; &lt;reason&gt; [group_id]',
        '/admin block &lt;ID&gt; &lt;reason&gt; / /admin unblock &lt;ID&gt;',
        '/admin export [group_id] — export this group',
        '/approve &lt;claim_id&gt; / /reject &lt;claim_id&gt; [reason]'
      ].join('\n'), { parse_mode: 'HTML' });
      return;
    }

    const groupArg = String(ctx.groupId);
    const [action, ...rawValues] = parts;
    const values = rawValues.filter((part) => part !== groupArg);
    const isGlobal = Boolean(db.prepare(
      'SELECT 1 FROM global_admins WHERE telegram_id = ?'
    ).get(ctx.from.id));

    if (action === 'groups') {
      if (!isGlobal) return ctx.reply('Only global administrators can list all groups.');
      const groups = db.prepare(`
        SELECT g.chat_id, g.title, g.is_active,
          (SELECT COUNT(*) FROM group_members m
            WHERE m.group_id = g.chat_id AND m.is_member = 1) AS members
        FROM groups g ORDER BY g.chat_id
      `).all();
      return ctx.reply(groups.length
        ? groups.map((group) =>
          `${escapeHtml(group.title || 'Telegram group')} — <code>${group.chat_id}</code> — ${group.is_active ? 'active' : 'inactive'} — ${group.members} members`
        ).join('\n')
        : 'No groups have been registered yet.', { parse_mode: 'HTML' });
    }

    if (action === 'global_stats') {
      if (!isGlobal) return ctx.reply('Only global administrators can view global statistics.');
      const totals = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM groups WHERE is_active = 1) AS groups,
          (SELECT COUNT(*) FROM group_members WHERE is_member = 1) AS members,
          (SELECT COUNT(*) FROM referrals WHERE is_active = 1) AS referrals,
          (SELECT COUNT(*) FROM reward_claims WHERE status = 'pending') AS pending_claims
      `).get();
      return ctx.reply([
        '<b>Global bot statistics</b>',
        `Active groups: ${totals.groups}`,
        `Active group memberships: ${totals.members}`,
        `Active referrals: ${totals.referrals}`,
        `Pending claims: ${totals.pending_claims}`
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (action === 'group_admin_add' || action === 'group_admin_remove') {
      if (!isGlobal) return ctx.reply('Only global administrators can manage group administrators.');
      const targetGroupId = parseGroupId(rawValues[0]);
      const userId = parsePositiveInteger(rawValues[1], 'Telegram user ID');
      if (!db.prepare('SELECT 1 FROM groups WHERE chat_id = ?').get(targetGroupId)) {
        return ctx.reply('That group is not registered. Add the bot to the group first.');
      }
      db.transaction(() => {
        if (action === 'group_admin_add') {
          db.prepare(`
            INSERT INTO users (telegram_id, first_name)
            VALUES (?, 'Group administrator')
            ON CONFLICT(telegram_id) DO NOTHING
          `).run(userId);
          db.prepare(`
            INSERT INTO group_admins (group_id, telegram_id) VALUES (?, ?)
            ON CONFLICT(group_id, telegram_id) DO NOTHING
          `).run(targetGroupId, userId);
        } else {
          db.prepare('DELETE FROM group_admins WHERE group_id = ? AND telegram_id = ?')
            .run(targetGroupId, userId);
        }
        writeAudit(db, targetGroupId, ctx.from.id, action, userId);
      })();
      return ctx.reply(
        `Group administrator ${action.endsWith('add') ? 'added to' : 'removed from'} ${targetGroupId}.`
      );
    }

    if (action === 'global_admin_add' || action === 'global_admin_remove') {
      if (!isGlobal) return ctx.reply('Only global administrators can manage global administrators.');
      const userId = parsePositiveInteger(values[0], 'Telegram user ID');
      if (action === 'global_admin_remove' && userId === ctx.from.id) {
        return ctx.reply('You cannot remove your own global access.');
      }
      db.transaction(() => {
        if (action === 'global_admin_add') {
          db.prepare(`
            INSERT INTO users (telegram_id, first_name)
            VALUES (?, 'Global administrator')
            ON CONFLICT(telegram_id) DO NOTHING
          `).run(userId);
          db.prepare('INSERT INTO global_admins (telegram_id) VALUES (?) ON CONFLICT DO NOTHING')
            .run(userId);
        } else {
          db.prepare('DELETE FROM global_admins WHERE telegram_id = ?').run(userId);
        }
      })();
      return ctx.reply(`Global administrator ${action.endsWith('add') ? 'added' : 'removed'}.`);
    }

    if (!ctx.groupId || !db.prepare(
      'SELECT 1 FROM groups WHERE chat_id = ? AND is_active = 1'
    ).get(ctx.groupId)) {
      return ctx.reply('Select an active group by adding its chat ID, for example: /admin stats -1001234567890.');
    }

    if (action === 'stats') {
      const overview = ctx.services.referrals.getOverview();
      let groupCount;
      let apiNote = '';
      try {
        groupCount = await ctx.telegram.getChatMemberCount(ctx.groupId);
      } catch (error) {
        logger.warn('Could not fetch live Telegram group member count', {
          groupId: ctx.groupId,
          error: error.message
        });
        apiNote = `\nLive Telegram count unavailable: ${escapeHtml(error.message)}`;
      }
      return ctx.reply([
        `<b>Group statistics — ${ctx.groupId}</b>`,
        `Current Telegram group members: ${groupCount ?? 'unavailable'}`,
        `Members observed by the bot as currently active: ${overview.members}`,
        `Successful active referrals: ${overview.successfulReferrals}`,
        `Registered group members: ${overview.users}${apiNote}`
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (action === 'users') {
      const page = parsePositiveInteger(values[0] || '1', 'page');
      const users = ctx.services.referrals.listUsers(20, (page - 1) * 20);
      if (!users.length) return ctx.reply('No registered members on that page.');
      return ctx.reply([
        `<b>Group members — page ${page}</b>`,
        ...users.map((user) =>
          `${escapeHtml(user.first_name)} — <code>${user.telegram_id}</code>${user.username ? ` (@${escapeHtml(user.username)})` : ''}${user.is_blocked ? ' [BLOCKED]' : ''}`
        ),
        '',
        'Use /admin users &lt;page&gt; for another page.'
      ].join('\n'), { parse_mode: 'HTML' });
    }

    if (action === 'search' || action === 'user') {
      const query = values.join(' ').replace(/^@/, '');
      if (!query || query.length > 64) return ctx.reply('Usage: /admin search <ID|username>');
      const users = ctx.services.referrals.searchUsers(query);
      if (!users.length) return ctx.reply('No matching registered group member found.');
      const lines = users.map((user) => {
        const stats = ctx.services.referrals.getStats(user.telegram_id);
        const display = `${escapeHtml(user.first_name)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}`;
        return [
          `<b>${display}</b>`,
          `Telegram ID: <code>${user.telegram_id}</code>`,
          `Active referral count: <b>${stats.referralCount}</b>`,
          `Status: ${user.is_blocked ? 'BLOCKED' : 'active'}`,
          `Commands: /admin block ${user.telegram_id} &lt;reason&gt; | /admin adjust ${user.telegram_id} &lt;delta&gt; &lt;reason&gt;`
        ].join('\n');
      });
      return ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
    }

    if (action === 'top') {
      const leaders = ctx.services.referrals.getLeaderboard(10);
      return ctx.reply(leaders.length
        ? leaders.map((user, index) =>
          `${index + 1}. ${safeName(user.first_name)}${user.username ? ` (@${safeName(user.username)})` : ''} — ${user.referral_count}`
        ).join('\n')
        : 'No eligible referrals yet.', { parse_mode: 'HTML' });
    }

    if (action === 'claims') {
      const claims = ctx.services.rewards.listClaims('pending', 50);
      if (!claims.length) return ctx.reply('There are no pending claims in this group.');
      for (const claim of claims) {
        await ctx.reply(
          `Group ${ctx.groupId} — claim #${claim.id}\nMember: ${claim.username ? `@${claim.username}` : claim.first_name} (${claim.user_id})\nLevel: ${claim.threshold} members\nAmount: ${claim.amount.toLocaleString('en-US')} ETB`,
          Markup.inlineKeyboard([[
            Markup.button.callback('✅ Approve', `admin_claim:approve:${ctx.groupId}:${claim.id}`),
            Markup.button.callback('❌ Reject', `admin_claim:reject:${ctx.groupId}:${claim.id}`)
          ]])
        );
      }
      return;
    }

    if (action === 'reward') {
      const threshold = parsePositiveInteger(values[0], 'threshold');
      const amount = parsePositiveInteger(values[1], 'amount');
      ctx.services.rewards.setReward(ctx.from.id, threshold, amount);
      return ctx.reply(`Reward level saved for group ${ctx.groupId}: ${threshold} active referrals — ${amount.toLocaleString('en-US')} ETB.`);
    }

    if (action === 'disable_reward') {
      const threshold = parsePositiveInteger(values[0], 'threshold');
      ctx.services.rewards.disableReward(ctx.from.id, threshold);
      return ctx.reply(`Reward level for ${threshold} referrals disabled in group ${ctx.groupId}.`);
    }

    if (action === 'adjust') {
      const targetId = parsePositiveInteger(values[0], 'Telegram user ID');
      const delta = parseSignedInteger(values[1], 'delta');
      const reason = values.slice(2).join(' ').trim();
      if (!delta || !reason || reason.length > 500) {
        return ctx.reply('Usage: /admin adjust <ID> <non-zero-delta> <reason (max 500 chars)>');
      }
      const previousCount = ctx.services.referrals.getStats(targetId).referralCount;
      const count = ctx.services.referrals.adjustCount(ctx.from.id, targetId, delta, reason);
      await ctx.reply(`Referral adjustment recorded. Current displayed count for ${targetId}: ${count}.`);
      if (count > previousCount) {
        const eligibleRewardIds = new Set(
          ctx.services.rewards.eligibleRewards(targetId).map((reward) => reward.id)
        );
        const milestones = ctx.services.rewards.listRewards().filter((reward) =>
          previousCount < reward.threshold && count >= reward.threshold &&
          eligibleRewardIds.has(reward.id)
        );
        for (const reward of milestones) {
          await ctx.services.notifications.referralMilestone(targetId, reward);
        }
      }
      return;
    }

    if (action === 'block' || action === 'unblock') {
      const targetId = parsePositiveInteger(values[0], 'Telegram user ID');
      const reason = values.slice(1).join(' ').trim();
      if (action === 'block' && (!reason || reason.length > 500)) {
        return ctx.reply('Usage: /admin block <ID> <reason (max 500 chars)>');
      }
      ctx.services.referrals.setBlocked(ctx.from.id, targetId, action === 'block', reason);
      return ctx.reply(`User ${targetId} ${action === 'block' ? 'blocked' : 'unblocked'} in group ${ctx.groupId}.`);
    }

    if (action === 'export') {
      const rows = ctx.services.rewards.exportRows();
      const csv = [
        ['telegram_id', 'username', 'first_name', 'last_name', 'referral_count', 'blocked'].join(','),
        ...rows.map((row) => [
          row.telegram_id, row.username, row.first_name, row.last_name, row.referral_count, row.is_blocked
        ].map(csvCell).join(','))
      ].join('\n');
      const file = path.join(os.tmpdir(), `referrals-${ctx.groupId}-${Date.now()}.csv`);
      try {
        await fs.writeFile(file, csv, { encoding: 'utf8', flag: 'wx' });
        await ctx.replyWithDocument(Input.fromLocalFile(file, `referrals-${ctx.groupId}.csv`));
      } finally {
        await fs.rm(file, { force: true });
      }
      return;
    }

    await ctx.reply('Unknown admin action. Use /admin to view available commands.');
  });

  for (const decision of ['approved', 'rejected']) {
    bot.command(decision === 'approved' ? 'approve' : 'reject', authorize, async (ctx) => {
      if (!ctx.groupId) return ctx.reply('Select the claim group first: /approve <claim_id> <group_id>.');
      ctx.services.referrals.saveUser(ctx.from);
      const [, claimArg, ...noteParts] = ctx.message.text.split(/\s+/);
      const claimId = parsePositiveInteger(claimArg, 'claim ID');
      const note = noteParts.filter((part) => part !== String(ctx.groupId)).join(' ').trim();
      if (note.length > 500) return ctx.reply('Review note must be 500 characters or fewer.');
      const claim = ctx.services.rewards.reviewClaim(ctx.from.id, claimId, decision, note);
      await ctx.reply(`Claim #${claimId} in group ${ctx.groupId} ${decision}.`);
      await ctx.services.notifications.claimReviewed(claim.user_id, decision, claim, note);
    });
  }

  bot.action(/^admin_claim:(approve|reject):(-?\d+):(\d+)$/, authorize, async (ctx) => {
    const decision = ctx.match[1] === 'approve' ? 'approved' : 'rejected';
    const claimId = Number(ctx.match[3]);
    ctx.services.referrals.saveUser(ctx.from);
    const claim = ctx.services.rewards.reviewClaim(ctx.from.id, claimId, decision);
    await ctx.answerCbQuery(`Claim ${decision}.`);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.services.notifications.claimReviewed(claim.user_id, decision, claim);
  });
}

function writeAudit(db, groupId, adminId, action, userId) {
  db.prepare(`
    INSERT INTO audit_logs (group_id, admin_id, action, target_user_id, details)
    VALUES (?, ?, ?, ?, '{}')
  `).run(groupId, adminId, action, userId);
}

function parseGroupId(value) {
  if (typeof value !== 'string' || !/^-\d+$/.test(value)) {
    throw new Error('Group ID must be a negative Telegram chat ID.');
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error('Group ID is outside the supported range.');
  return id;
}

function parsePositiveInteger(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the supported range.`);
  return parsed;
}

function parseSignedInteger(value, name) {
  if (typeof value !== 'string' || !/^-?[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a non-zero whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the supported range.`);
  return parsed;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function safeName(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function escapeHtml(value) {
  return safeName(value);
}

module.exports = { registerAdminHandlers, parseGroupId };
