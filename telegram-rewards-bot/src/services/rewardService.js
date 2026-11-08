function createRewardService(db, referralService, groupId) {
  function listRewards() {
    return db.prepare(`
      SELECT id, threshold, amount FROM reward_levels
      WHERE group_id = ? AND is_active = 1 ORDER BY threshold
    `).all(groupId);
  }

  function eligibleRewards(userId) {
    const user = referralService.getUser(userId);
    if (!user || user.is_blocked) return [];
    if (!db.prepare(`
      SELECT 1 FROM group_members
      WHERE group_id = ? AND user_id = ? AND is_member = 1
    `).get(groupId, userId)) return [];
    const count = referralService.getStats(userId).referralCount;
    const claimed = db.prepare(`
      SELECT reward_level_id FROM reward_claims WHERE group_id = ? AND user_id = ?
    `).all(groupId, userId).map((row) => row.reward_level_id);
    return listRewards().filter((reward) =>
      count >= reward.threshold && !claimed.includes(reward.id)
    );
  }

  function requestClaim(userId, rewardLevelId) {
    const user = referralService.getUser(userId);
    if (!user) throw new Error('Join this group and start the bot before requesting a reward.');
    if (!db.prepare(`
      SELECT 1 FROM group_members
      WHERE group_id = ? AND user_id = ? AND is_member = 1
    `).get(groupId, userId)) {
      throw new Error('You must be an active member of this group to request a reward.');
    }
    if (user.is_blocked) throw new Error('Your account is blocked from making reward claims in this group.');
    if (!Number.isSafeInteger(rewardLevelId) || rewardLevelId < 1) {
      throw new Error('Invalid reward level.');
    }
    return db.transaction(() => {
      const reward = db.prepare(`
        SELECT id, threshold, amount FROM reward_levels
        WHERE group_id = ? AND id = ? AND is_active = 1
      `).get(groupId, rewardLevelId);
      if (!reward) throw new Error('That reward level is no longer available in this group.');
      if (referralService.getStats(userId).referralCount < reward.threshold) {
        throw new Error('You do not currently meet this reward level.');
      }
      const result = db.prepare(`
        INSERT INTO reward_claims (
          group_id, user_id, reward_level_id, threshold_snapshot, amount_snapshot
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_id, user_id, reward_level_id) DO NOTHING
      `).run(groupId, userId, reward.id, reward.threshold, reward.amount);
      if (result.changes === 0) {
        throw new Error('A claim for this reward level has already been submitted in this group.');
      }
      return {
        ...reward,
        groupId,
        rewardLevelId: reward.id,
        id: Number(result.lastInsertRowid)
      };
    })();
  }

  function listClaims(status = 'pending', limit = 50) {
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      throw new Error('Invalid claim status.');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error('Claim limit must be between 1 and 200.');
    }
    return db.prepare(`
      SELECT c.id, c.user_id, c.reward_level_id, c.group_id, c.status, c.requested_at,
        c.review_note, u.username, u.first_name,
        COALESCE(c.threshold_snapshot, r.threshold) AS threshold,
        COALESCE(c.amount_snapshot, r.amount) AS amount
      FROM reward_claims c
      JOIN users u ON u.telegram_id = c.user_id
      JOIN reward_levels r ON r.id = c.reward_level_id AND r.group_id = c.group_id
      WHERE c.group_id = ? AND c.status = ?
      ORDER BY c.requested_at ASC
      LIMIT ?
    `).all(groupId, status, limit);
  }

  function reviewClaim(adminId, claimId, decision, note = '') {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('Decision must be approved or rejected.');
    }
    if (!Number.isSafeInteger(claimId) || claimId < 1 || note.length > 500) {
      throw new Error('Invalid claim ID or review note.');
    }
    return db.transaction(() => {
      const claim = db.prepare(`
        SELECT c.id, c.user_id, c.group_id, c.status,
          COALESCE(c.threshold_snapshot, r.threshold) AS threshold,
          COALESCE(c.amount_snapshot, r.amount) AS amount,
          m.is_blocked, m.is_member
        FROM reward_claims c
        JOIN reward_levels r ON r.id = c.reward_level_id AND r.group_id = c.group_id
        JOIN group_members m ON m.group_id = c.group_id AND m.user_id = c.user_id
        WHERE c.group_id = ? AND c.id = ?
      `).get(groupId, claimId);
      if (!claim) throw new Error('Claim not found in this group.');
      if (claim.status !== 'pending') throw new Error(`Claim is already ${claim.status}.`);
      if (decision === 'approved' && !claim.is_member) {
        throw new Error('This member has left the group; the claim cannot be approved.');
      }
      if (decision === 'approved' && claim.is_blocked) {
        throw new Error('This member is blocked; reject the claim or resolve the group block first.');
      }
      if (decision === 'approved' &&
          referralService.getStats(claim.user_id).referralCount < claim.threshold) {
        throw new Error('This member no longer meets the referral threshold; the claim cannot be approved.');
      }
      db.prepare(`
        UPDATE reward_claims
        SET status = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ?
        WHERE group_id = ? AND id = ?
      `).run(decision, adminId, note || null, groupId, claimId);
      db.prepare(`
        INSERT INTO audit_logs (group_id, admin_id, action, target_user_id, details)
        VALUES (?, ?, ?, ?, ?)
      `).run(groupId, adminId, `claim_${decision}`, claim.user_id, JSON.stringify({
        claimId,
        note: note || null
      }));
      return { ...claim, status: decision };
    })();
  }

  function setReward(adminId, threshold, amount) {
    if (!Number.isSafeInteger(threshold) || threshold < 1 ||
        !Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('Threshold and amount must be positive whole numbers.');
    }
    db.transaction(() => {
      db.prepare(`
        INSERT INTO reward_levels (group_id, threshold, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(group_id, threshold) DO UPDATE SET
          amount = excluded.amount, is_active = 1, updated_at = datetime('now')
      `).run(groupId, threshold, amount);
      db.prepare(`
        INSERT INTO audit_logs (group_id, admin_id, action, details)
        VALUES (?, ?, 'reward_level_updated', ?)
      `).run(groupId, adminId, JSON.stringify({ threshold, amount }));
    })();
  }

  function disableReward(adminId, threshold) {
    db.transaction(() => {
      const result = db.prepare(`
        UPDATE reward_levels SET is_active = 0, updated_at = datetime('now')
        WHERE group_id = ? AND threshold = ? AND is_active = 1
      `).run(groupId, threshold);
      if (!result.changes) throw new Error(`No active reward level exists at ${threshold} referrals in this group.`);
      db.prepare(`
        INSERT INTO audit_logs (group_id, admin_id, action, details)
        VALUES (?, ?, 'reward_level_disabled', ?)
      `).run(groupId, adminId, JSON.stringify({ threshold }));
    })();
  }

  function exportRows() {
    return db.prepare(`
      SELECT u.telegram_id, u.username, u.first_name, u.last_name, m.is_blocked,
        MAX(0,
          (SELECT COUNT(*) FROM referrals r
            WHERE r.inviter_id = u.telegram_id AND r.group_id = ? AND r.is_active = 1) +
          COALESCE((SELECT SUM(a.delta) FROM referral_adjustments a
            WHERE a.user_id = u.telegram_id AND a.group_id = ?), 0)
        ) AS referral_count
      FROM group_members m
      JOIN users u ON u.telegram_id = m.user_id
      WHERE m.group_id = ? AND u.is_bot = 0
      ORDER BY referral_count DESC, u.telegram_id
    `).all(groupId, groupId, groupId);
  }

  return {
    groupId,
    listRewards,
    eligibleRewards,
    requestClaim,
    listClaims,
    reviewClaim,
    setReward,
    disableReward,
    exportRows
  };
}

module.exports = { createRewardService };
