const { Telegraf } = require('telegraf');
const { createDatabase } = require('./database/database');
const { createReferralService } = require('./services/referralService');
const { createRewardService } = require('./services/rewardService');
const { createNotificationService } = require('./services/notificationService');
const { registerStartHandlers } = require('./handlers/start');
const { registerInviteHandlers } = require('./handlers/invite');
const { registerProfileHandlers } = require('./handlers/profile');
const { registerLeaderboardHandlers } = require('./handlers/leaderboard');
const { registerRewardHandlers } = require('./handlers/rewards');
const { registerClaimHandlers } = require('./handlers/claims');
const { registerAdminHandlers } = require('./handlers/admin');
const logger = require('./utils/logger');

function createBot(config, db = createDatabase(
  config.databasePath,
  config.adminIds,
  config.rewardDefaults
)) {
  const bot = new Telegraf(config.botToken);
  const referrals = createReferralService(db, config.groupId);
  const rewards = createRewardService(db, referrals, config.groupId);
  const notifications = createNotificationService(bot, config.adminIds, config.groupId);
  const services = { referrals, rewards, notifications };

  bot.use(async (ctx, next) => {
    ctx.services = services;
    return next();
  });

  registerStartHandlers(bot);
  registerInviteHandlers(bot, config);
  registerProfileHandlers(bot);
  registerLeaderboardHandlers(bot);
  registerRewardHandlers(bot);
  registerClaimHandlers(bot);
  registerAdminHandlers(bot, db, config);

  async function handleJoin(user, inviteLinkUrl) {
    if (user.is_bot) return;
    const result = referrals.recordJoin(user, inviteLinkUrl);
    if (!result.joined) return;

    try {
      await notifications.welcome(user, rewards.listRewards());
    } catch (error) {
      await notifications.welcomeError(user.id, error);
    }

    if (result.referralCreated) {
      const eligibleRewardIds = new Set(
        rewards.eligibleRewards(result.inviterId).map((reward) => reward.id)
      );
      const milestones = rewards.listRewards().filter((reward) =>
        result.previousCount < reward.threshold &&
          result.referralCount >= reward.threshold &&
          eligibleRewardIds.has(reward.id)
      );
      for (const reward of milestones) {
        await notifications.referralMilestone(result.inviterId, reward);
      }
    }
  }

  function isMember(chatMember) {
    const status = chatMember?.status;
    return status === 'creator' || status === 'administrator' || status === 'member' ||
      (status === 'restricted' && chatMember.is_member === true);
  }

  bot.on('chat_member', async (ctx) => {
    const update = ctx.update.chat_member;
    if (update.chat.id !== config.groupId) return;
    const user = update.new_chat_member.user;
    const wasMember = isMember(update.old_chat_member);
    const isNowMember = isMember(update.new_chat_member);
    if (!wasMember && isNowMember) {
      await handleJoin(user, update.invite_link?.invite_link);
    } else if (wasMember && !isNowMember && !user.is_bot) {
      referrals.recordLeave(user);
    }
  });

  bot.on('new_chat_members', async (ctx) => {
    if (ctx.chat.id !== config.groupId) return;
    const inviteLinkUrl = ctx.message.invite_link?.invite_link;
    for (const user of ctx.message.new_chat_members) {
      await handleJoin(user, inviteLinkUrl);
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.update.my_chat_member;
    if (update.chat.id !== config.groupId) return;
    if (!['administrator', 'creator'].includes(update.new_chat_member.status)) {
      logger.warn('Bot is not an administrator in the configured group; referral tracking needs admin access', {
        groupId: config.groupId,
        status: update.new_chat_member.status
      });
    } else {
      logger.info('Bot administrator status confirmed', { groupId: config.groupId });
    }
  });

  bot.catch(async (error, ctx) => {
    logger.error('Unhandled Telegram update error', {
      updateId: ctx.update?.update_id,
      userId: ctx.from?.id,
      error: error.message,
      stack: error.stack
    });
    if (ctx.chat?.id) {
      try {
        await ctx.reply('Sorry, that request could not be completed. Please try again or contact an administrator.');
      } catch (replyError) {
        logger.warn('Could not send request error message', { error: replyError.message });
      }
    }
  });

  return { bot, db, services };
}

module.exports = { createBot };
