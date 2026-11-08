const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Input, Markup } = require('telegraf');
const { adminAuth } = require('../middleware/adminAuth');
const logger = require('../utils/logger');

function registerAdminHandlers(bot, db, config) {
  const authorize = adminAuth(db);

  bot.command('admin', authorize, async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    const subcommand = ctx.message.text
      .replace(/^\/admin(?:@\w+)?\s*/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!subcommand.length) {
      await ctx.reply([
        '<b>Administrator commands</b>',
        '/admin stats — group and referral totals',
        '/admin users [page] — registered users, 20 per page',
        '/admin search &lt;ID|username&gt; — find member',
        '/admin user &lt;ID|username&gt; — member stats',
        '/admin top — top inviters',
        '/admin claims — pending reward claims',
        '/admin reward &lt;threshold&gt; &lt;amount&gt; — add/update a level',
        '/admin disable_reward &lt;threshold&gt; — disable a level',
        '/admin adjust &lt;ID&gt; &lt;delta&gt; &lt;reason&gt; — audited count adjustment',
        '/admin block &lt;ID&gt; &lt;reason&gt; / /admin unblock &lt;ID&gt;',
        '/admin export — send referral CSV',
        '/approve &lt;claim_id&gt; / /reject &lt;claim_id&gt; [reason]'
      ].join('\n'), { parse_mode: 'HTML' });
      return;
    }

    const [action, ...args] = subcommand;
    if (action === 'stats') {
      const overview = ctx.services.referrals.getOverview();
      let groupCount;
      let apiNote = '';
      try {
        groupCount = await ctx.telegram.getChatMemberCount(config.groupId);
      } catch (error) {
        logger.warn('Could not fetch live Telegram group member count', { error: error.message });
        apiNote = `\nLive Telegram count unavailable: ${escapeHtml(error.message)}`;
      }
      await ctx.reply([
        '<b>Bot statistics</b>',
        `Current Telegram group members: ${groupCount ?? 'unavailable'}`,
        `Members observed by the bot as currently active: ${overview.members}`,
        `Successful active referrals: ${overview.successfulReferrals}`,
        `Registered users: ${overview.users}${apiNote}`
      ].join('\n'), { parse_mode: 'HTML' });
      return;
    }

    if (action === 'users') {
      const page = parsePositiveInteger(args[0] || '1', 'page');
      const users = ctx.services.referrals.listUsers(20, (page - 1) * 20);
      if (!users.length) return ctx.reply('No registered users on that page.');
      await ctx.reply([
        `<b>Registered users — page ${page}</b>`,
        ...users.map((user) =>
          `${escapeHtml(user.first_name)} — <code>${user.telegram_id}</code>${user.username ? ` (@${escapeHtml(user.username)})` : ''}${user.is_blocked ? ' [BLOCKED]' : ''}`
        ),
        '',
        'Use /admin users &lt;page&gt; for another page.'
      ].join('\n'), { parse_mode: 'HTML' });
      return;
    }

    if (action === 'search' || action === 'user') {
      const query = args.join(' ').replace(/^@/, '');
      if (!query || query.length > 64) return ctx.reply('Usage: /admin search <ID|username>');
      const users = ctx.services.referrals.searchUsers(query);
      if (!users.length) return ctx.reply('No matching registered user found.');
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
      await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
      return;
    }

    if (action === 'top') {
      const leaders = ctx.services.referrals.getLeaderboard(10);
      await ctx.reply(leaders.length
        ? leaders.map((user, index) =>
          `${index + 1}. ${safeName(user.first_name)}${user.username ? ` (@${safeName(user.username)})` : ''} — ${user.referral_count}`
        ).join('\n')
        : 'No eligible referrals yet.', { parse_mode: 'HTML' });
      return;
    }

    if (action === 'claims') {
      const claims = ctx.services.rewards.listClaims('pending', 50);
      if (!claims.length) return ctx.reply('There are no pending claims.');
      for (const claim of claims) {
        await ctx.reply(
          `Claim #${claim.id}\nMember: ${claim.username ? `@${claim.username}` : claim.first_name} (${claim.user_id})\nLevel: ${claim.threshold} members\nAmount: ${claim.amount.toLocaleString('en-US')} ETB`,
          Markup.inlineKeyboard([[
            Markup.button.callback('✅ Approve', `admin_claim:approve:${claim.id}`),
            Markup.button.callback('❌ Reject', `admin_claim:reject:${claim.id}`)
          ]])
        );
      }
      return;
    }

    if (action === 'reward') {
      const threshold = parsePositiveInteger(args[0], 'threshold');
      const amount = parsePositiveInteger(args[1], 'amount');
      ctx.services.rewards.setReward(ctx.from.id, threshold, amount);
      await ctx.reply(`Reward level saved: ${threshold} active referrals — ${amount.toLocaleString('en-US')} ETB.`);
      return;
    }

    if (action === 'disable_reward') {
      const threshold = parsePositiveInteger(args[0], 'threshold');
      ctx.services.rewards.disableReward(ctx.from.id, threshold);
      await ctx.reply(`Reward level for ${threshold} referrals disabled.`);
      return;
    }

    if (action === 'adjust') {
      const targetId = parsePositiveInteger(args[0], 'Telegram user ID');
      const delta = parseSignedInteger(args[1], 'delta');
      const reason = args.slice(2).join(' ').trim();
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
          previousCount < reward.threshold &&
            count >= reward.threshold &&
            eligibleRewardIds.has(reward.id)
        );
        for (const reward of milestones) {
          await ctx.services.notifications.referralMilestone(targetId, reward);
        }
      }
      return;
    }

    if (action === 'block' || action === 'unblock') {
      const targetId = parsePositiveInteger(args[0], 'Telegram user ID');
      const reason = args.slice(1).join(' ').trim();
      if (action === 'block' && (!reason || reason.length > 500)) {
        return ctx.reply('Usage: /admin block <ID> <reason (max 500 chars)>');
      }
      ctx.services.referrals.setBlocked(ctx.from.id, targetId, action === 'block', reason);
      await ctx.reply(`User ${targetId} ${action === 'block' ? 'blocked' : 'unblocked'}.`);
      return;
    }

    if (action === 'export') {
      const rows = ctx.services.rewards.exportRows();
      const csv = [
        ['telegram_id', 'username', 'first_name', 'last_name', 'referral_count', 'blocked'].join(','),
        ...rows.map((row) => [
          row.telegram_id, row.username, row.first_name, row.last_name, row.referral_count, row.is_blocked
        ].map(csvCell).join(','))
      ].join('\n');
      const file = path.join(os.tmpdir(), `referrals-${Date.now()}.csv`);
      try {
        await fs.writeFile(file, csv, { encoding: 'utf8', flag: 'wx' });
        await ctx.replyWithDocument(Input.fromLocalFile(file, 'referral-statistics.csv'));
      } finally {
        await fs.rm(file, { force: true });
      }
      return;
    }

    await ctx.reply('Unknown admin action. Use /admin to view available commands.');
  });

  for (const decision of ['approved', 'rejected']) {
    bot.command(decision === 'approved' ? 'approve' : 'reject', authorize, async (ctx) => {
      ctx.services.referrals.saveUser(ctx.from);
      const [, claimArg, ...noteParts] = ctx.message.text.split(/\s+/);
      const claimId = parsePositiveInteger(claimArg, 'claim ID');
      const note = noteParts.join(' ').trim();
      if (note.length > 500) return ctx.reply('Review note must be 500 characters or fewer.');
      const claim = ctx.services.rewards.reviewClaim(ctx.from.id, claimId, decision, note);
      await ctx.reply(`Claim #${claimId} ${decision}.`);
      await ctx.services.notifications.claimReviewed(claim.user_id, decision, claim, note);
    });
  }

  bot.action(/^admin_claim:(approve|reject):(\d+)$/, authorize, async (ctx) => {
    const decision = ctx.match[1] === 'approve' ? 'approved' : 'rejected';
    const claimId = Number(ctx.match[2]);
    ctx.services.referrals.saveUser(ctx.from);
    const claim = ctx.services.rewards.reviewClaim(ctx.from.id, claimId, decision);
    await ctx.answerCbQuery(`Claim ${decision}.`);
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.services.notifications.claimReviewed(claim.user_id, decision, claim);
  });
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

module.exports = { registerAdminHandlers };
