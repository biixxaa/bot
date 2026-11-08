function registerInviteHandlers(bot, config) {
  async function sendInvite(ctx) {
    const user = ctx.from;
    ctx.services.referrals.saveUser(user);
    if (user.is_bot) return ctx.reply('Bots cannot generate referral links.');
    if (ctx.services.referrals.getUser(user.id)?.is_blocked) {
      return ctx.reply('Your account is currently blocked from the referral program.');
    }
    const membership = await ctx.telegram.getChatMember(config.groupId, user.id);
    if (!['creator', 'administrator', 'member'].includes(membership.status) &&
        !(membership.status === 'restricted' && membership.is_member)) {
      return ctx.reply('Join the group before creating your personal invitation link.');
    }

    const stored = ctx.services.referrals.findLink(user.id);
    if (stored) {
      await ctx.reply(`🎁 Your personal invitation link:\n${stored.invite_link}\n\nShare it with friends who are new to this group.`);
      return;
    }
    const link = await ctx.telegram.createChatInviteLink(config.groupId, {
      name: `ref-${user.id}`
    });
    ctx.services.referrals.saveLink(user.id, link.invite_link);
    await ctx.reply(`🎁 Your personal invitation link:\n${link.invite_link}\n\nShare it with friends who are new to this group.`);
  }

  bot.command('invite', sendInvite);
  bot.action('menu:invite', async (ctx) => {
    await ctx.answerCbQuery();
    await sendInvite(ctx);
  });
}

module.exports = { registerInviteHandlers };
