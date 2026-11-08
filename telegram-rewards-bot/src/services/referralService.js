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
  const getLink = db.prepare(`
    SELECT id, inviter_id, invite_link
    FROM invitation_links
    WHERE group_id = ? AND invite_link = ? AND revoked_at IS NULL
  `);
  const getMember = db.prepare(`
    SELECT is_member FROM group_members WHERE group_id = ? AND user_id = ?
  `);
  const insertReferral = db.prepare(`
    INSERT INTO referrals (inviter_id, invitee_id, invitation_link_id, group_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, invitee_id) DO NOTHING
  `);
  const isBlocked = db.prepare('SELECT is_blocked FROM users WHERE telegram_id = ?');
  const activeReferralCount = db.prepare(`
    SELECT COUNT(*) AS count FROM referrals
    WHERE inviter_id = ? AND group_id = ? AND is_active = 1
  `);
  const adjustmentCount = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) AS count FROM referral_adjustments WHERE user_id = ?
  `);

  const recordJoinTransaction = db.transaction((user, inviteLinkUrl) => {
    const membership = getMember.get(groupId, user.id);
    if (membership?.is_member) {
      return { joined: false, referralCreated: false, duplicate: true };
    }

    if (membership) {
      db.prepare(`
        UPDATE group_members
        SET is_member = 1, last_joined_at = datetime('now'), left_at = NULL
        WHERE group_id = ? AND user_id = ?
      `).run(groupId, user.id);
    } else {
      db.prepare(`
        INSERT INTO group_members (group_id, user_id)
        VALUES (?, ?)
      `).run(groupId, user.id);
    }

    if (membership) {
      return { joined: true, referralCreated: false, previouslySeen: true };
    }

    const invite = inviteLinkUrl ? getLink.get(groupId, inviteLinkUrl) : null;
    if (!invite || invite.inviter_id === user.id) {
      return { joined: true, referralCreated: false };
    }
    if (isBlocked.get(invite.inviter_id)?.is_blocked || isBlocked.get(user.id)?.is_blocked) {
      return { joined: true, referralCreated: false, blocked: true };
    }

    const previousCount = Math.max(
      0,
      activeReferralCount.get(invite.inviter_id, groupId).count +
        adjustmentCount.get(invite.inviter_id).count
    );
    const result = insertReferral.run(invite.inviter_id, user.id, invite.id, groupId);
    return {
      joined: true,
      referralCreated: result.changes === 1,
      inviterId: result.changes === 1 ? invite.inviter_id : undefined,
      previousCount,
      referralCount: result.changes === 1
        ? Math.max(
          0,
          activeReferralCount.get(invite.inviter_id, groupId).count +
            adjustmentCount.get(invite.inviter_id).count
        )
        : previousCount
    };
  });

  const recordLeaveTransaction = db.transaction((user) => {
    const membership = getMember.get(groupId, user.id);
    if (membership) {
      db.prepare(`
        UPDATE group_members
        SET is_member = 0, left_at = datetime('now')
        WHERE group_id = ? AND user_id = ?
      `).run(groupId, user.id);
    } else {
      db.prepare(`
        INSERT INTO group_members (group_id, user_id, is_member, left_at)
        VALUES (?, ?, 0, datetime('now'))
      `).run(groupId, user.id);
    }
    db.prepare(`
      UPDATE referrals SET is_active = 0, left_at = datetime('now')
      WHERE group_id = ? AND invitee_id = ? AND is_active = 1
    `).run(groupId, user.id);
  });

  const saveInvitationLink = db.prepare(`
    INSERT INTO invitation_links (inviter_id, group_id, invite_link)
    VALUES (?, ?, ?)
    ON CONFLICT(inviter_id, group_id) DO UPDATE SET
      invite_link = excluded.invite_link,
      revoked_at = NULL,
      created_at = datetime('now')
  `);

  function getStats(userId) {
    const actual = activeReferralCount.get(userId, groupId).count;
    const adjustment = adjustmentCount.get(userId).count;
    return {
      referralCount: Math.max(0, actual + adjustment),
      activeReferralCount: actual,
      adjustment
    };
  }

  function getLeaderboard(limit = 10) {
    return db.prepare(`
      SELECT u.telegram_id, u.username, u.first_name, u.last_name,
        MAX(0, COUNT(r.id) + COALESCE(a.adjustment, 0)) AS referral_count
      FROM users u
      LEFT JOIN referrals r
        ON r.inviter_id = u.telegram_id AND r.group_id = ? AND r.is_active = 1
      LEFT JOIN (
        SELECT user_id, SUM(delta) AS adjustment
        FROM referral_adjustments
        GROUP BY user_id
      ) a ON a.user_id = u.telegram_id
      WHERE u.is_blocked = 0 AND u.is_bot = 0
      GROUP BY u.telegram_id
      HAVING referral_count > 0
      ORDER BY referral_count DESC, u.telegram_id ASC
      LIMIT ?
    `).all(groupId, limit);
  }

  function getOverview() {
    return {
      members: db.prepare(`
        SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND is_member = 1
      `).get(groupId).count,
      successfulReferrals: db.prepare(`
        SELECT COUNT(*) AS count FROM referrals WHERE group_id = ? AND is_active = 1
      `).get(groupId).count,
      users: db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_bot = 0').get().count
    };
  }

  return {
    saveUser: (user) => saveUser(db, user),
    recordJoin(user, inviteLinkUrl) {
      if (user.is_bot) return { joined: false, referralCreated: false, bot: true };
      saveUser(db, user);
      return recordJoinTransaction(user, inviteLinkUrl);
    },
    recordLeave(user) {
      saveUser(db, user);
      recordLeaveTransaction(user);
    },
    findLink: (inviterId) => db.prepare(`
      SELECT invite_link FROM invitation_links
      WHERE inviter_id = ? AND group_id = ? AND revoked_at IS NULL
    `).get(inviterId, groupId),
    saveLink: (inviterId, url) => saveInvitationLink.run(inviterId, groupId, url),
    getStats,
    getLeaderboard,
    getOverview,
    searchUsers(query) {
      const id = /^\d+$/.test(query) ? Number(query) : null;
      const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      return db.prepare(`
        SELECT telegram_id, username, first_name, last_name, is_blocked
        FROM users
        WHERE is_bot = 0 AND (
          (? IS NOT NULL AND telegram_id = ?) OR username LIKE ? ESCAPE '\\'
        )
        ORDER BY telegram_id
        LIMIT 20
      `).all(id, id, pattern);
    },
    getUser(userId) {
      return db.prepare(`
        SELECT telegram_id, username, first_name, last_name, is_blocked, block_reason
        FROM users WHERE telegram_id = ?
      `).get(userId);
    },
    listUsers(limit = 100, offset = 0) {
      return db.prepare(`
        SELECT telegram_id, username, first_name, last_name, is_blocked
        FROM users WHERE is_bot = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    },
    adjustCount(adminId, targetId, delta, reason) {
      if (!Number.isSafeInteger(delta) || delta === 0) {
        throw new Error('Adjustment must be a non-zero whole number.');
      }
      if (!this.getUser(targetId)) throw new Error('User must be registered before their count can be adjusted.');
      const transaction = db.transaction(() => {
        db.prepare(`
          INSERT INTO referral_adjustments (user_id, admin_id, delta, reason)
          VALUES (?, ?, ?, ?)
        `).run(targetId, adminId, delta, reason);
        db.prepare(`
          INSERT INTO audit_logs (admin_id, action, target_user_id, details)
          VALUES (?, 'referral_count_adjusted', ?, ?)
        `).run(adminId, targetId, JSON.stringify({ delta, reason }));
      });
      transaction();
      return this.getStats(targetId).referralCount;
    },
    setBlocked(adminId, targetId, blocked, reason = '') {
      if (!this.getUser(targetId)) throw new Error('User must be registered before they can be blocked.');
      if (db.prepare('SELECT 1 FROM admin_users WHERE telegram_id = ?').get(targetId)) {
        throw new Error('Administrator accounts cannot be blocked through this command.');
      }
      const transaction = db.transaction(() => {
        db.prepare(`
          UPDATE users SET is_blocked = ?, block_reason = ?, updated_at = datetime('now')
          WHERE telegram_id = ?
        `).run(blocked ? 1 : 0, blocked ? reason : null, targetId);
        db.prepare(`
          INSERT INTO audit_logs (admin_id, action, target_user_id, details)
          VALUES (?, ?, ?, ?)
        `).run(adminId, blocked ? 'user_blocked' : 'user_unblocked', targetId,
          JSON.stringify({ reason: blocked ? reason : null }));
      });
      transaction();
    }
  };
}

module.exports = { createReferralService, saveUser };
