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
    await ctx.reply(welcomeText, { parse_mode: 'HTML', ...mainMenu() });
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
    ].join('\n'), { parse_mode: 'HTML', ...mainMenu() });
  });

  bot.action('menu:help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Use /help to see commands, referral rules, and how reward claims are reviewed.');
  });
}

module.exports = { registerStartHandlers };
