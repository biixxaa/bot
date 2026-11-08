function adminAuth(db) {
  return async (ctx, next) => {
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

    const userId = ctx.from?.id;
    const globalAdmin = userId && db.prepare(
      'SELECT 1 FROM global_admins WHERE telegram_id = ?'
    ).get(userId);
    const groupAdmin = userId && ctx.groupId && db.prepare(`
      SELECT 1 FROM group_admins WHERE telegram_id = ? AND group_id = ?
    `).get(userId, ctx.groupId);
    const helpOnly = /^\/admin(?:@\w+)?\s*$/i.test(ctx.message?.text || '');
    const assignedToAnyGroup = helpOnly && userId && db.prepare(
      'SELECT 1 FROM group_admins WHERE telegram_id = ? LIMIT 1'
    ).get(userId);
    if (!globalAdmin && !groupAdmin && !assignedToAnyGroup) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('Administrator access required for this group.', { show_alert: true });
      } else {
        await ctx.reply('⛔ You are not an administrator of the selected group.');
      }
      return;
    }
    return next();
  };
}

module.exports = { adminAuth };
