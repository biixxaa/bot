function saveUser(db, user) {
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name, is_bot)
    VALUES (@id, @username, @first_name, @last_name, @is_bot)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      is_bot = excluded.is_bot,
      updated_at = datetime('now')
  `).run({
    id: user.id,
    username: user.username || null,
    first_name: user.first_name || user.username || String(user.id),
    last_name: user.last_name || null,
    is_bot: user.is_bot ? 1 : 0
  });
}

function createReferralService(db, groupId) {
  if (!Number.isSafeInteger(groupId)) throw new Error('A valid group ID is required.');

  const activeReferralCount = db.prepare(`
    SELECT COUNT(*) AS count FROM referrals
    WHERE group_id = ? AND inviter_id = ? AND is_active = 1
  `);
  const adjustmentCount = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS count FROM referral_adjustments
    WHERE group_id = ? AND user_id = ?
  `);

  const recordJoinTransaction = db.transaction((user, inviteLinkUrl) => {
    const membership = db.prepare(`
      SELECT is_member FROM group_members WHERE group_id = ? AND user_id = ?
    `).get(groupId, user.id);
    if (membership?.is_member) {
      return { joined: false, referralCreated: false, duplicate: true };
    }

    db.prepare(`
      INSERT INTO group_members (group_id, user_id)
      VALUES (?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        is_member = 1, last_joined_at = datetime('now'), left_at = NULL
    `).run(groupId, user.id);
    if (membership) return { joined: true, referralCreated: false, previouslySeen: true };

    const invite = inviteLinkUrl ? db.prepare(`
      SELECT id, inviter_id FROM invitation_links
      WHERE group_id = ? AND invite_link = ? AND revoked_at IS NULL
    `).get(groupId, inviteLinkUrl) : null;
    if (!invite || invite.inviter_id === user.id) {
      return { joined: true, referralCreated: false };
    }
    const inviterBlocked = db.prepare(`
      SELECT is_blocked FROM group_members WHERE group_id = ? AND user_id = ?
    `).get(groupId, invite.inviter_id)?.is_blocked;
    const inviteeBlocked = db.prepare(`
      SELECT is_blocked FROM group_members WHERE group_id = ? AND user_id = ?
    `).get(groupId, user.id)?.is_blocked;
    if (inviterBlocked || inviteeBlocked) {
      return { joined: true, referralCreated: false, blocked: true };
    }
    const previousCount = getStats(invite.inviter_id).referralCount;
    const result = db.prepare(`
      INSERT INTO referrals (inviter_id, invitee_id, invitation_link_id, group_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, invitee_id) DO NOTHING
    `).run(invite.inviter_id, user.id, invite.id, groupId);
    return {
      joined: true,
      referralCreated: result.changes === 1,
      inviterId: result.changes === 1 ? invite.inviter_id : undefined,
      previousCount,
      referralCount: getStats(invite.inviter_id).referralCount
    };
  });

  function getStats(userId) {
    const active = activeReferralCount.get(groupId, userId).count;
    const adjustment = adjustmentCount.get(groupId, userId).count;
    return {
      referralCount: Math.max(0, active + adjustment),
      activeReferralCount: active,
      adjustment
    };
  }

  return {
    groupId,
    saveUser: (user) => saveUser(db, user),
    recordJoin(user, inviteLinkUrl) {
      if (user.is_bot) return { joined: false, referralCreated: false, bot: true };
      saveUser(db, user);
      return recordJoinTransaction(user, inviteLinkUrl);
    },
    recordLeave(user) {
      if (user.is_bot) return;
      saveUser(db, user);
      db.transaction(() => {
        db.prepare(`
          INSERT INTO group_members (group_id, user_id, is_member, left_at)
          VALUES (?, ?, 0, datetime('now'))
          ON CONFLICT(group_id, user_id) DO UPDATE SET
            is_member = 0, left_at = datetime('now')
        `).run(groupId, user.id);
        db.prepare(`
          UPDATE referrals SET is_active = 0, left_at = datetime('now')
          WHERE group_id = ? AND invitee_id = ? AND is_active = 1
        `).run(groupId, user.id);
      })();
    },
    findLink(inviterId) {
      return db.prepare(`
        SELECT invite_link FROM invitation_links
        WHERE group_id = ? AND inviter_id = ? AND revoked_at IS NULL
      `).get(groupId, inviterId);
    },
    saveLink(inviterId, url) {
      return db.prepare(`
        INSERT INTO invitation_links (inviter_id, group_id, invite_link)
        VALUES (?, ?, ?)
        ON CONFLICT(inviter_id, group_id) DO UPDATE SET
          invite_link = excluded.invite_link,
          revoked_at = NULL,
          created_at = datetime('now')
      `).run(inviterId, groupId, url);
    },
    getStats,
    getLeaderboard(limit = 10) {
      return db.prepare(`
        WITH counts AS (
          SELECT inviter_id, COUNT(*) AS referral_count
          FROM referrals
          WHERE group_id = ? AND is_active = 1
          GROUP BY inviter_id
        ), adjustments AS (
          SELECT user_id, SUM(delta) AS amount
          FROM referral_adjustments WHERE group_id = ? GROUP BY user_id
        )
        SELECT u.telegram_id, u.username, u.first_name, u.last_name,
          MAX(0, COALESCE(c.referral_count, 0) + COALESCE(a.amount, 0)) AS referral_count
        FROM group_members m
        JOIN users u ON u.telegram_id = m.user_id
        LEFT JOIN counts c ON c.inviter_id = u.telegram_id
        LEFT JOIN adjustments a ON a.user_id = u.telegram_id
        WHERE m.group_id = ? AND m.is_blocked = 0 AND u.is_bot = 0
        GROUP BY u.telegram_id
        HAVING referral_count > 0
        ORDER BY referral_count DESC, u.telegram_id ASC
        LIMIT ?
      `).all(groupId, groupId, groupId, limit);
    },
    getOverview() {
      return {
        members: db.prepare(`
          SELECT COUNT(*) AS count FROM group_members
          WHERE group_id = ? AND is_member = 1
        `).get(groupId).count,
        successfulReferrals: db.prepare(`
          SELECT COUNT(*) AS count FROM referrals
          WHERE group_id = ? AND is_active = 1
        `).get(groupId).count,
        users: db.prepare(`
          SELECT COUNT(*) AS count FROM group_members WHERE group_id = ?
        `).get(groupId).count
      };
    },
    searchUsers(query) {
      const id = /^\d+$/.test(query) ? Number(query) : null;
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      return db.prepare(`
        SELECT u.telegram_id, u.username, u.first_name, u.last_name, m.is_blocked
        FROM group_members m JOIN users u ON u.telegram_id = m.user_id
        WHERE m.group_id = ? AND (
          (? IS NOT NULL AND u.telegram_id = ?) OR u.username LIKE ? ESCAPE '\\'
        )
        ORDER BY u.telegram_id LIMIT 20
      `).all(groupId, id, id, pattern);
    },
    getUser(userId) {
      return db.prepare(`
        SELECT u.telegram_id, u.username, u.first_name, u.last_name,
          m.is_blocked, m.block_reason
        FROM group_members m JOIN users u ON u.telegram_id = m.user_id
        WHERE u.telegram_id = ?
          AND m.group_id = ?
      `).get(userId, groupId);
    },
    listUsers(limit = 100, offset = 0) {
      return db.prepare(`
        SELECT u.telegram_id, u.username, u.first_name, u.last_name, m.is_blocked
        FROM group_members m JOIN users u ON u.telegram_id = m.user_id
        WHERE m.group_id = ? AND u.is_bot = 0
        ORDER BY u.created_at DESC LIMIT ? OFFSET ?
      `).all(groupId, limit, offset);
    },
    getMembershipGroupIds(userId) {
      return db.prepare(`
        SELECT group_id FROM group_members
        WHERE user_id = ? AND is_member = 1 ORDER BY group_id
      `).all(userId).map((row) => row.group_id);
    },
    getAdminGroupIds(userId) {
      return db.prepare(`
        SELECT group_id FROM group_admins WHERE telegram_id = ? ORDER BY group_id
      `).all(userId).map((row) => row.group_id);
    },
    adjustCount(adminId, targetId, delta, reason) {
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw new Error('Adjustment must be a non-zero whole number.');
      }
      if (!this.getUser(targetId)) throw new Error('User must be registered in this group before their count can be adjusted.');
      db.transaction(() => {
        db.prepare(`
          INSERT INTO referral_adjustments (group_id, user_id, admin_id, delta, reason)
          VALUES (?, ?, ?, ?, ?)
        `).run(groupId, targetId, adminId, delta, reason);
        db.prepare(`
          INSERT INTO audit_logs (group_id, admin_id, action, target_user_id, details)
          VALUES (?, ?, 'referral_count_adjusted', ?, ?)
        `).run(groupId, adminId, targetId, JSON.stringify({ delta, reason }));
      })();
      return getStats(targetId).referralCount;
    },
    setBlocked(adminId, targetId, blocked, reason = '') {
      if (!this.getUser(targetId)) throw new Error('User must be registered in this group before they can be blocked.');
      if (db.prepare(`
        SELECT 1 FROM global_admins WHERE telegram_id = ?
        UNION SELECT 1 FROM group_admins WHERE group_id = ? AND telegram_id = ?
      `).get(targetId, groupId, targetId)) {
        throw new Error('Administrator accounts cannot be blocked through this command.');
      }
      db.transaction(() => {
        db.prepare(`
          UPDATE group_members SET is_blocked = ?, block_reason = ?
          WHERE group_id = ? AND user_id = ?
        `).run(blocked ? 1 : 0, blocked ? reason : null, groupId, targetId);
        db.prepare(`
          INSERT INTO audit_logs (group_id, admin_id, action, target_user_id, details)
          VALUES (?, ?, ?, ?, ?)
        `).run(groupId, adminId, blocked ? 'user_blocked' : 'user_unblocked', targetId,
          JSON.stringify({ reason: blocked ? reason : null }));
      })();
    }
  };
}

module.exports = { createReferralService, saveUser };
