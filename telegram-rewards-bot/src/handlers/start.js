const { Markup } = require('telegraf');
const { mainMenu } = require('../utils/keyboards');

function registerStartHandlers(bot) {
  const welcomeText = [
    '🎉 <b>Welcome to the Referral Rewards Bot!</b>',
    '',
    'Invite new members to the group, track your active referrals, and request eligible ETB rewards.',
    '',
    'Use the menu below to get started. Rewards are reviewed by an administrator; payments are not automatic.'
  ].join('\n');

  bot.start(async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    if (ctx.groupId) {
      await ctx.reply(welcomeText, { parse_mode: 'HTML', ...mainMenu(ctx.groupId) });
      return;
    }
    const groups = ctx.db.prepare(`
      SELECT g.chat_id, g.title FROM group_members m
      JOIN groups g ON g.chat_id = m.group_id
      WHERE m.user_id = ? AND m.is_member = 1 AND g.is_active = 1
      ORDER BY g.title, g.chat_id
    `).all(ctx.from.id);
    if (groups.length) {
      await ctx.reply('Choose the group you want to use:', Markup.inlineKeyboard(
        groups.map((group) => [
          Markup.button.callback(
            `${group.title || 'Telegram group'} (${group.chat_id})`,
            `select_group:${group.chat_id}`
          )
        ])
      ));
    } else {
      await ctx.reply(
        `${welcomeText}\n\nJoin a participating group first. Then use /invite <group_chat_id> in this private chat.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  bot.command('help', async (ctx) => {
    ctx.services.referrals.saveUser(ctx.from);
    await ctx.reply([
      '<b>How it works</b>',
      '• Create your personal group invitation link with /invite.',
      '• Only first-observed, link-attributed member joins count; referrals stop counting if the invitee leaves.',
      '• View your current active referral total with /profile.',
      '• Use /claim when you qualify. An administrator reviews every claim and handles payment manually.',
      '',
      'Commands: /start, /invite, /profile, /rewards, /leaderboard, /claim, /help'
    ].join('\n'), { parse_mode: 'HTML', ...(ctx.groupId ? mainMenu(ctx.groupId) : {}) });
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
    await ctx.reply(welcomeText, { parse_mode: 'HTML', ...mainMenu(groupId) });
  });

  bot.action(/^menu:help(?::(-?\d+))?$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /help to see commands, referral rules, and how reward claims are reviewed.');
  });
}

module.exports = { registerStartHandlers };
