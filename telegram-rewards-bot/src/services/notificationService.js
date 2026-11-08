const logger = require('../utils/logger');

function createNotificationService(bot, db) {
  async function sendAdminMessage(groupId, text, extra) {
    const adminIds = db.prepare(`
      SELECT telegram_id AS id FROM global_admins
      UNION
      SELECT telegram_id AS id FROM group_admins WHERE group_id = ?
      ORDER BY id
    `).all(groupId).map((row) => row.id);
    const results = await Promise.allSettled(adminIds.map((id) =>
      bot.telegram.sendMessage(id, text, extra)
    ));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn('Could not deliver administrator notification', {
          adminId: adminIds[index],
          error: result.reason?.message
        });
      }
    });
  }

  return {
    async welcome(groupId, user, rewardLevels) {
      const name = escapeHtml(user.first_name || 'there');
      const firstReward = rewardLevels[0];
      const rewardLines = rewardLevels.map((reward) =>
        `✅ Invite <b>${reward.threshold}</b> members — <b>${reward.amount.toLocaleString('en-US')} ETB</b>`
      ).join('\n');
      const intro = firstReward
        ? `👉 Dear "<b>${name}</b>" user, invite <b>${firstReward.threshold}</b> of your contacts to the group and earn <b>${firstReward.amount.toLocaleString('en-US')} ETB</b>!`
        : `👉 Dear "<b>${name}</b>" user, invite your contacts to the group and earn rewards!`;
      await bot.telegram.sendMessage(groupId, [
        '◾ New Member',
        intro,
        ...(rewardLevels.length ? [
          '',
          '🎁 <b>Reward Levels:</b>',
          rewardLines,
          '',
          '🔥 The more you invite, the bigger your reward!'
        ] : [])
      ].join('\n'), { parse_mode: 'HTML' });
    },
    async referralMilestone(userId, reward) {
      try {
        await bot.telegram.sendMessage(
          userId,
          `🎉 Congratulations! You reached ${reward.threshold} active referrals and are eligible to request ${reward.amount.toLocaleString('en-US')} ETB. Use /claim to submit your claim.`
        );
      } catch (error) {
        logger.warn('Could not notify member about referral reward', {
          userId,
          error: error.message
        });
      }
    },
    async claimRequested(groupId, claim, user) {
      const who = user.username ? `@${user.username}` : `${user.first_name} (${claim.user_id})`;
      await sendAdminMessage(
        groupId,
        `💰 New reward claim #${claim.id} for group ${groupId}\nMember: ${who}\nInvitations: ${claim.threshold}\nAmount: ${claim.amount.toLocaleString('en-US')} ETB\nReview using /approve ${claim.id} or /reject ${claim.id} [reason] with this group selected.`
      );
    },
    async claimReviewed(userId, status, claim, note) {
      const message = status === 'approved'
        ? `✅ Your claim #${claim.id} for ${claim.amount.toLocaleString('en-US')} ETB was approved. Payment will be verified and handled manually by an administrator.`
        : `❌ Your claim #${claim.id} was rejected.${note ? ` Reason: ${note}` : ''}`;
      try {
        await bot.telegram.sendMessage(userId, message);
      } catch (error) {
        logger.warn('Could not notify member about claim decision', {
          userId,
          claimId: claim.id,
          error: error.message
        });
      }
    },
    async welcomeError(userId, error) {
      logger.warn('Could not send group welcome message', { userId, error: error.message });
    }
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

module.exports = { createNotificationService, escapeHtml };
