const { Telegraf } = require('telegraf');
const { createDatabase, ensureGroup } = require('./database/database');
const { saveUser } = require('./services/referralService');
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
  config.rewardDefaults,
  config.initialGroupId ?? config.groupId ?? null
)) {
  const bot = new Telegraf(config.botToken);
  const notifications = createNotificationService(bot, db);
  const serviceCache = new Map();

  function getServices(groupId) {
    if (!serviceCache.has(groupId)) {
      const referrals = createReferralService(db, groupId);
      serviceCache.set(groupId, {
        referrals,
        rewards: createRewardService(db, referrals, groupId),
        notifications
      });
    }
    return serviceCache.get(groupId);
  }

  const configuredGroup = config.initialGroupId ?? config.groupId;
  if (configuredGroup) {
    ensureGroup(db, { id: configuredGroup, title: null, type: 'supergroup' },
      config.rewardDefaults);
  }

  function requestedGroupId(ctx) {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') return ctx.chat.id;
    const text = ctx.message?.text || ctx.callbackQuery?.data || '';
    const candidates = text.match(/-\d+/g) || [];
    for (const candidate of candidates) {
      const id = Number(candidate);
      if (Number.isSafeInteger(id) && db.prepare(
        'SELECT 1 FROM groups WHERE chat_id = ?'
      ).get(id)) return id;
    }
    const userId = ctx.from?.id;
    if (!userId) return null;
    const admins = db.prepare(`
      SELECT group_id FROM group_admins WHERE telegram_id = ?
      UNION
      SELECT chat_id AS group_id FROM groups
      WHERE is_active = 1 AND EXISTS (
        SELECT 1 FROM global_admins WHERE telegram_id = ?
      )
      ORDER BY group_id
    `).all(userId, userId).map((row) => row.group_id);
    if (admins.length === 1) return admins[0];
    if (!admins.length) {
      const memberships = db.prepare(`
        SELECT group_id FROM group_members
        WHERE user_id = ? AND is_member = 1
        ORDER BY group_id
      `).all(userId).map((row) => row.group_id);
      if (memberships.length === 1) return memberships[0];
    }
    const groups = db.prepare(`
      SELECT chat_id FROM groups WHERE is_active = 1 ORDER BY chat_id
    `).all();
    return groups.length === 1 ? groups[0].chat_id : null;
  }

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
      ensureGroup(db, ctx.chat, config.rewardDefaults);
    }
    ctx.groupId = requestedGroupId(ctx);
    ctx.db = db;
    ctx.services = ctx.groupId ? getServices(ctx.groupId) : {
      referrals: { saveUser: (user) => saveUser(db, user) },
      notifications
    };

    const text = ctx.message?.text || '';
    const command = text.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();
    const groupCommands = new Set([
      'invite', 'profile', 'rewards', 'leaderboard', 'claim', 'approve', 'reject'
    ]);
    if ((groupCommands.has(command) || command === 'start' || command === 'help') &&
        ctx.chat?.type !== 'private') {
      await ctx.reply('Use member commands in a private chat with the bot.');
      return;
    }
    if (ctx.callbackQuery && ctx.chat?.type !== 'private') {
      await ctx.answerCbQuery('Open the bot in a private chat to use this menu.', { show_alert: true });
      return;
    }
    if (!ctx.groupId && command && groupCommands.has(command)) {
      await ctx.reply('Select a group by adding its chat ID, for example: /profile -1001234567890.');
      return;
    }
    if (!ctx.groupId && ctx.callbackQuery) {
      await ctx.answerCbQuery('Select a group with its chat ID first.', { show_alert: true });
      return;
    }
    return next();
  });

  registerStartHandlers(bot);
  registerInviteHandlers(bot);
  registerProfileHandlers(bot);
  registerLeaderboardHandlers(bot);
  registerRewardHandlers(bot);
  registerClaimHandlers(bot);
  registerAdminHandlers(bot, db, config);

  async function handleJoin(groupId, user, inviteLinkUrl) {
    if (user.is_bot) return;
    const services = getServices(groupId);
    const result = services.referrals.recordJoin(user, inviteLinkUrl);
    if (!result.joined) return;

    try {
      await notifications.welcome(groupId, user, services.rewards.listRewards());
    } catch (error) {
      await notifications.welcomeError(user.id, error);
    }

    if (result.referralCreated) {
      const eligibleRewardIds = new Set(
        services.rewards.eligibleRewards(result.inviterId).map((reward) => reward.id)
      );
      const milestones = services.rewards.listRewards().filter((reward) =>
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
    ensureGroup(db, update.chat, config.rewardDefaults);
    const user = update.new_chat_member.user;
    const wasMember = isMember(update.old_chat_member);
    const isNowMember = isMember(update.new_chat_member);
    if (!wasMember && isNowMember) {
      await handleJoin(update.chat.id, user, update.invite_link?.invite_link);
    } else if (wasMember && !isNowMember && !user.is_bot) {
      getServices(update.chat.id).referrals.recordLeave(user);
    }
  });

  bot.on('new_chat_members', async (ctx) => {
    ensureGroup(db, ctx.chat, config.rewardDefaults);
    const inviteLinkUrl = ctx.message.invite_link?.invite_link;
    await Promise.all(ctx.message.new_chat_members.map((user) =>
      handleJoin(ctx.chat.id, user, inviteLinkUrl)
    ));
  });

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.update.my_chat_member;
    if (update.chat.type !== 'group' && update.chat.type !== 'supergroup') return;
    ensureGroup(db, update.chat, config.rewardDefaults);
    const enabled = isMember(update.new_chat_member);
    db.prepare(`
      UPDATE groups SET is_active = ?, updated_at = datetime('now') WHERE chat_id = ?
    `).run(enabled ? 1 : 0, update.chat.id);
    if (!enabled) {
      logger.info('Bot removed from Telegram group', { groupId: update.chat.id });
    } else if (!['administrator', 'creator'].includes(update.new_chat_member.status)) {
      logger.warn('Bot is not an administrator in this group; referral tracking needs admin access', {
        groupId: update.chat.id,
        status: update.new_chat_member.status
      });
    } else {
      logger.info('Bot administrator status confirmed', { groupId: update.chat.id });
    }
  });

  bot.catch(async (error, ctx) => {
    logger.error('Unhandled Telegram update error', {
      updateId: ctx.update?.update_id,
      userId: ctx.from?.id,
      groupId: ctx.chat?.id,
      error: error.message,
      stack: error.stack
    });
    if (ctx.chat?.id) {
      try {
        await ctx.reply('Sorry, that request could not be completed. Please try again or contact a group administrator.');
      } catch (replyError) {
        logger.warn('Could not send request error message', { error: replyError.message });
      }
    }
  });

  const defaultGroupId = configuredGroup || db.prepare(
    'SELECT chat_id FROM groups WHERE is_active = 1 ORDER BY chat_id LIMIT 1'
  ).get()?.chat_id;
  return {
    bot,
    db,
    services: defaultGroupId ? getServices(defaultGroupId) : null,
    getServices
  };
}

module.exports = { createBot };
