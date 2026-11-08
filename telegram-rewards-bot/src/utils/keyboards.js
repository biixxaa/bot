const { Markup } = require('telegraf');

function mainMenu(groupId) {
  const suffix = groupId === undefined ? '' : `:${groupId}`;
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎁 Invite Friends', `menu:invite${suffix}`),
      Markup.button.callback('📊 My Statistics', `menu:stats${suffix}`)],
    [Markup.button.callback('🏆 Leaderboard', `menu:leaderboard${suffix}`),
      Markup.button.callback('💰 Rewards', `menu:rewards${suffix}`)],
    [Markup.button.callback('🎯 Claim Reward', `menu:claim${suffix}`),
      Markup.button.callback('ℹ️ Help', `menu:help${suffix}`)],
    [Markup.button.callback('📊 How many users have I added?', `menu:stats${suffix}`)]
  ]);
}

module.exports = { mainMenu };
