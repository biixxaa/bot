const { Markup } = require('telegraf');

function registerClaimHandlers(bot) {
  async function showClaimOptions(ctx, callback = false) {
    ctx.services.referrals.saveUser(ctx.from);
    if (ctx.services.referrals.getUser(ctx.from.id)?.is_blocked) {
      if (callback) await ctx.answerCbQuery();
      await ctx.reply('Your account is blocked from making reward claims. Contact an administrator.');
      return;
    }
    const rewards = ctx.services.rewards.eligibleRewards(ctx.from.id);
    if (callback) await ctx.answerCbQuery();
    if (!rewards.length) {
      await ctx.reply('You do not have an unclaimed reward level yet. Check your progress with /profile.');
      return;
    }
    const buttons = rewards.map((reward) => [
      Markup.button.callback(
        `${reward.threshold} members — ${reward.amount.toLocaleString('en-US')} ETB`,
        `claim:${ctx.groupId}:${reward.id}`
      )
    ]);
    await ctx.reply('Select the reward level you want to claim. Each level can only be claimed once:', {
      ...Markup.inlineKeyboard(buttons)
    });
  }

  bot.command('claim', (ctx) => showClaimOptions(ctx));
  bot.action(/^menu:claim(?::(-?\d+))?$/, (ctx) => showClaimOptions(ctx, true));

  bot.action(/^claim:(-?\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const rewardId = Number(ctx.match[2]);
    ctx.services.referrals.saveUser(ctx.from);
    try {
      const claim = ctx.services.rewards.requestClaim(ctx.from.id, rewardId);
      await ctx.reply(`✅ Claim #${claim.id} submitted for ${claim.amount.toLocaleString('en-US')} ETB. An administrator will review it.`);
      const user = ctx.services.referrals.getUser(ctx.from.id);
      await ctx.services.notifications.claimRequested(
        ctx.groupId,
        { ...claim, user_id: ctx.from.id },
        user
      );
    } catch (error) {
      await ctx.reply(error.message);
    }
  });
}

module.exports = { registerClaimHandlers };
