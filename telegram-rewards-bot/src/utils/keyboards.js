const { Markup } = require('telegraf');

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Invite Friends', 'menu:invite'),
      Markup.button.callback('📊 My Statistics', 'menu:stats')],
    [Markup.button.callback('🏆 Leaderboard', 'menu:leaderboard'),
      Markup.button.callback('💰 Rewards', 'menu:rewards')],
    [Markup.button.callback('🎯 Claim Reward', 'menu:claim'),
      Markup.button.callback('ℹ️ Help', 'menu:help')],
    [Markup.button.callback('📊 How many users have I added?', 'menu:stats')]
  ]);
}

module.exports = { mainMenu };
