const { Markup } = require('telegraf');
const { mainMenu } = require('../utils/keyboards');

function registerStartHandlers(bot) {
  const welcomeText = [
    '🌹 Hi! I\'m your <b>Referral Rewards Bot</b>.',
    '',
    'Invite new members to your group and earn <b>ETB cash rewards</b>!',
    '',
    '📌 Add me to your group as an <b>administrator</b> so I can track joins and create invite links.'
  ].join('\n');

  bot.start(async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    await ctx.reply(welcomeText, {
      parse_mode: 'HTML',
      ...mainMenu(ctx.groupId, ctx.botInfo?.username)
    });
  });

  bot.command('help', async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    await ctx.reply([
      '<b>How it works</b>',
      '• Tap <b>My Groups</b> to select your active group.',
      '• Use <b>Invite Friends</b> to get your personal referral link.',
      '• Only first-time, link-attributed joins count; referrals stop if the invitee leaves.',
      '• Check your progress with <b>My Stats</b>.',
      '• Use <b>Claim Reward</b> when you qualify — an administrator reviews every claim.',
      '',
      'Commands: /start, /invite, /profile, /rewards, /leaderboard, /claim, /help'
    ].join('\n'), {
      parse_mode: 'HTML',
      ...mainMenu(ctx.groupId, ctx.botInfo?.username)
    });
  });

  bot.action('menu:groups', async (ctx) => {
    await ctx.answerCbQuery();
    const groups = ctx.db.prepare(`
      SELECT g.chat_id, g.title FROM group_members m
      JOIN groups g ON g.chat_id = m.group_id
      WHERE m.user_id = ? AND m.is_member = 1 AND g.is_active = 1
      ORDER BY g.title, g.chat_id
    `).all(ctx.from.id);
    if (!groups.length) {
      await ctx.reply(
        '⚙️ You are not currently recorded as a member of any active group.\n\nJoin a group that uses this bot, then come back here.'
      );
      return;
    }
    await ctx.reply('⚙️ Select a group:', Markup.inlineKeyboard(
      groups.map((group) => [
        Markup.button.callback(
          `${group.title || 'Telegram group'} (${group.chat_id})`,
          `select_group:${group.chat_id}`
        )
      ])
    ));
  });

  bot.action(/^select_group:(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const groupId = Number(ctx.match[1]);
    if (!ctx.db.prepare(`
      SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND is_member = 1
    `).get(groupId, ctx.from.id)) {
      await ctx.reply('You are not currently recorded as a member of that group.');
      return;
    }
    await ctx.reply(
      `✅ Group <code>${groupId}</code> selected. Use the menu below:`,
      { parse_mode: 'HTML', ...mainMenu(groupId, ctx.botInfo?.username) }
    );
  });

  bot.action(/^menu:help(?::(-?\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /help to see commands, referral rules, and how reward claims are reviewed.');
  });
}

module.exports = { registerStartHandlers };
