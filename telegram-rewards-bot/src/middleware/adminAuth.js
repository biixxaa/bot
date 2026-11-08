function adminAuth(db) {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    const authorized = userId && db.prepare(
      'SELECT 1 FROM admin_users WHERE telegram_id = ?'
    ).get(userId);
    if (!authorized) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Administrator access required.', { show_alert: true });
      } else {
        await ctx.reply('⛔ This command is restricted to authorized administrators.');
      }
      return;
    }
    if (ctx.chat?.type !== 'private') {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Use administrator controls in a private chat with the bot.', {
          show_alert: true
        });
      } else {
        await ctx.reply('Use administrator commands in a private chat with the bot.');
      }
      return;
    }
    return next();
  };
}

module.exports = { adminAuth };
