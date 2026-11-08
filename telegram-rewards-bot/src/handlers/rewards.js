function registerRewardHandlers(bot) {
  async function show(ctx, callback = false) {
    const rewards = ctx.services.rewards.listRewards();
    const text = rewards.length
      ? [
        '💰 <b>Referral Rewards</b>',
        '',
        ...rewards.map((reward) =>
          `✅ Invite ${reward.threshold} active members — <b>${reward.amount.toLocaleString('en-US')} ETB</b>`
        ),
        '',
        'Use /claim after reaching a level. All claims are reviewed manually.'
      ].join('\n')
      : 'No reward levels are currently available.';
    if (callback) await ctx.answerCbQuery();
    await ctx.reply(text, { parse_mode: 'HTML' });
  }
  bot.command('rewards', (ctx) => show(ctx));
  bot.action('menu:rewards', (ctx) => show(ctx, true));
}

module.exports = { registerRewardHandlers };
