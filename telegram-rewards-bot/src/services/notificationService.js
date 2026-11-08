const logger = require('../utils/logger');

function createNotificationService(bot, adminIds, groupId) {
  async function sendAdminMessage(text, extra) {
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
    async welcome(user, rewardLevels) {
      const rewardLines = rewardLevels.map((reward) =>
        `✅ Invite ${reward.threshold} members – ${reward.amount.toLocaleString('en-US')} ETB`
      ).join('\n');
      const name = escapeHtml(user.first_name || 'there');
      await bot.telegram.sendMessage(groupId, [
        `🎉 <b>WELCOME TO OUR COMMUNITY!</b>`,
        '',
        `Welcome, ${name}! Invite your friends and earn exciting cash rewards.`,
        '',
        '🎁 <b>OUR REWARD PROGRAM</b>',
        rewardLines,
        '',
        '🔥 The more members you invite, the bigger your reward!'
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
    async claimRequested(claim, user) {
      const who = user.username ? `@${user.username}` : `${user.first_name} (${claim.user_id})`;
      await sendAdminMessage(
        `💰 New reward claim #${claim.id}\nMember: ${who}\nInvitations: ${claim.threshold}\nAmount: ${claim.amount.toLocaleString('en-US')} ETB\nReview with /approve ${claim.id} or /reject ${claim.id} [reason].`
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
