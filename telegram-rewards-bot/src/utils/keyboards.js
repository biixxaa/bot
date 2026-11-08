const { Markup } = require('telegraf');

function mainMenu(groupId, botUsername) {
  const suffix = groupId ? `:${groupId}` : '';
  const topRow = botUsername
    ? [
        Markup.button.callback('⚙️ My Groups', 'menu:groups'),
        Markup.button.url('➕ Add to Group', `https://t.me/${botUsername}?startgroup=true`)
      ]
    : [Markup.button.callback('⚙️ My Groups', 'menu:groups')];

  return Markup.inlineKeyboard([
    topRow,
    [
      Markup.button.callback('🎁 Invite Friends', `menu:invite${suffix}`),
      Markup.button.callback('📊 My Stats', `menu:stats${suffix}`)
    ],
    [
      Markup.button.callback('🏆 Leaderboard', `menu:leaderboard${suffix}`),
      Markup.button.callback('💰 Rewards', `menu:rewards${suffix}`)
    ],
    [
      Markup.button.callback('🎯 Claim Reward', `menu:claim${suffix}`),
      Markup.button.callback('ℹ️ Help', `menu:help${suffix}`)
    ]
  ]);
}

module.exports = { mainMenu };
