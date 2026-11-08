function renderProfile(user, stats, rewards) {
  const next = rewards.find((reward) => stats.referralCount < reward.threshold);
  if (!next) {
    return [
      '👤 <b>Your Referral Statistics</b>',
      '',
      `Invited Members: <b>${stats.referralCount}</b>`,
      '',
      '🏆 You have reached every currently configured reward level!'
    ].join('\n');
  }
  const progress = Math.min(stats.referralCount, next.threshold);
  return [
    '👤 <b>Your Referral Statistics</b>',
    '',
    `Invited Members: <b>${stats.referralCount}</b>`,
    '',
    `Next Reward: <b>${next.threshold} Members</b>`,
    `Current Progress: <b>${progress}/${next.threshold}</b>`,
    `Remaining: <b>${Math.max(0, next.threshold - stats.referralCount)} Members</b>`,
    `Potential Reward: <b>${next.amount.toLocaleString('en-US')} ETB</b>`
  ].join('\n');
}

function registerProfileHandlers(bot) {
  async function showProfile(ctx, callback = false) {
    ctx.services.referrals.saveUser(ctx.from);
    const stats = ctx.services.referrals.getStats(ctx.from.id);
    const rewards = ctx.services.rewards.listRewards();
    const text = renderProfile(ctx.from, stats, rewards);
    if (callback) {
      await ctx.answerCbQuery();
      await ctx.reply(text, { parse_mode: 'HTML' });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML' });
    }
  }
  bot.command('profile', (ctx) => showProfile(ctx));
  bot.action(/^menu:stats(?::(-?\d+))?$/, (ctx) => showProfile(ctx, true));
}

module.exports = { registerProfileHandlers, renderProfile };
