function createRewardService(db, referralService, groupId) {
  function listRewards() {
    return db.prepare(`
      SELECT id, threshold, amount FROM reward_levels
      WHERE is_active = 1 ORDER BY threshold
    `).all();
  }

  function eligibleRewards(userId) {
    const user = db.prepare('SELECT is_blocked FROM users WHERE telegram_id = ?').get(userId);
    if (!user || user.is_blocked) return [];
    const count = referralService.getStats(userId).referralCount;
    const claimed = db.prepare(`
      SELECT reward_level_id FROM reward_claims WHERE user_id = ?
    `).all(userId).map((row) => row.reward_level_id);
    return listRewards().filter((reward) =>
      count >= reward.threshold && !claimed.includes(reward.id)
    );
  }

  function requestClaim(userId, rewardLevelId) {
    const user = db.prepare(`
      SELECT is_blocked FROM users WHERE telegram_id = ?
    `).get(userId);
    if (!user) throw new Error('Start the bot before requesting a reward.');
    if (user.is_blocked) throw new Error('Your account is blocked from making reward claims.');

    const reward = db.prepare(`
      SELECT id, threshold, amount FROM reward_levels
      WHERE id = ? AND is_active = 1
    `).get(rewardLevelId);
    if (!reward) throw new Error('That reward level is no longer available.');
    if (referralService.getStats(userId).referralCount < reward.threshold) {
      throw new Error('You do not currently meet this reward level.');
    }
    const result = db.prepare(`
      INSERT INTO reward_claims (
        user_id, reward_level_id, threshold_snapshot, amount_snapshot
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, reward_level_id) DO NOTHING
    `).run(userId, rewardLevelId, reward.threshold, reward.amount);
    if (result.changes === 0) {
      throw new Error('A claim for this reward level has already been submitted.');
    }
    return {
      ...reward,
      rewardLevelId: reward.id,
      id: Number(result.lastInsertRowid)
    };
  }

  function listClaims(status = 'pending', limit = 50) {
    return db.prepare(`
      SELECT c.id, c.user_id, c.reward_level_id, c.status, c.requested_at,
        c.review_note, u.username, u.first_name,
        COALESCE(c.threshold_snapshot, r.threshold) AS threshold,
        COALESCE(c.amount_snapshot, r.amount) AS amount
      FROM reward_claims c
      JOIN users u ON u.telegram_id = c.user_id
      JOIN reward_levels r ON r.id = c.reward_level_id
      WHERE c.status = ?
      ORDER BY c.requested_at ASC
      LIMIT ?
    `).all(status, limit);
  }

  function reviewClaim(adminId, claimId, decision, note = '') {
    if (!['approved', 'rejected'].includes(decision)) {
      throw new Error('Decision must be approved or rejected.');
    }
    const transaction = db.transaction(() => {
      const claim = db.prepare(`
        SELECT c.id, c.user_id, c.status,
          COALESCE(c.threshold_snapshot, r.threshold) AS threshold,
          COALESCE(c.amount_snapshot, r.amount) AS amount,
          u.is_blocked
        FROM reward_claims c
        JOIN reward_levels r ON r.id = c.reward_level_id
        JOIN users u ON u.telegram_id = c.user_id
        WHERE c.id = ?
      `).get(claimId);
      if (!claim) throw new Error('Claim not found.');
      if (claim.status !== 'pending') throw new Error(`Claim is already ${claim.status}.`);
      if (decision === 'approved' && claim.is_blocked) {
        throw new Error('This member is blocked; reject the claim or resolve the block first.');
      }
      if (decision === 'approved' &&
          referralService.getStats(claim.user_id).referralCount < claim.threshold) {
        throw new Error('This member no longer meets the referral threshold; the claim cannot be approved.');
      }
      db.prepare(`
        UPDATE reward_claims
        SET status = ?, reviewed_at = datetime('now'), reviewed_by = ?, review_note = ?
        WHERE id = ?
      `).run(decision, adminId, note || null, claimId);
      db.prepare(`
        INSERT INTO audit_logs (admin_id, action, target_user_id, details)
        VALUES (?, ?, ?, ?)
      `).run(adminId, `claim_${decision}`, claim.user_id, JSON.stringify({
        claimId,
        note: note || null
      }));
      return { ...claim, status: decision };
    });
    return transaction();
  }

  function setReward(adminId, threshold, amount) {
    if (!Number.isSafeInteger(threshold) || threshold < 1 ||
        !Number.isSafeInteger(amount) || amount < 1) {
      throw new Error('Threshold and amount must be positive whole numbers.');
    }
    const transaction = db.transaction(() => {
      const existing = db.prepare(`
        SELECT id, threshold, amount FROM reward_levels WHERE threshold = ?
      `).get(threshold);
      if (existing) {
        db.prepare(`
          UPDATE reward_levels SET amount = ?, is_active = 1, updated_at = datetime('now')
          WHERE id = ?
        `).run(amount, existing.id);
      } else {
        db.prepare(`
          INSERT INTO reward_levels (threshold, amount) VALUES (?, ?)
        `).run(threshold, amount);
      }
      db.prepare(`
        INSERT INTO audit_logs (admin_id, action, details)
        VALUES (?, 'reward_level_updated', ?)
      `).run(adminId, JSON.stringify({ threshold, amount }));
    });
    transaction();
  }

  function disableReward(adminId, threshold) {
    const reward = db.prepare(`
      SELECT id FROM reward_levels WHERE threshold = ? AND is_active = 1
    `).get(threshold);
    if (!reward) throw new Error(`No active reward level exists at ${threshold} referrals.`);
    const transaction = db.transaction(() => {
      db.prepare(`
        UPDATE reward_levels SET is_active = 0, updated_at = datetime('now') WHERE id = ?
      `).run(reward.id);
      db.prepare(`
        INSERT INTO audit_logs (admin_id, action, details)
        VALUES (?, 'reward_level_disabled', ?)
      `).run(adminId, JSON.stringify({ threshold }));
    });
    transaction();
  }

  function exportRows() {
    return db.prepare(`
      SELECT u.telegram_id, u.username, u.first_name, u.last_name, u.is_blocked,
        MAX(0,
          (SELECT COUNT(*) FROM referrals r
            WHERE r.inviter_id = u.telegram_id AND r.group_id = ? AND r.is_active = 1) +
          COALESCE((SELECT SUM(a.delta) FROM referral_adjustments a
            WHERE a.user_id = u.telegram_id), 0)
        ) AS referral_count
      FROM users u
      WHERE u.is_bot = 0
      ORDER BY referral_count DESC, u.telegram_id
    `).all(groupId);
  }

  return {
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
