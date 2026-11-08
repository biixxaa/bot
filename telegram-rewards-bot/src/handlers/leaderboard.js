function registerLeaderboardHandlers(bot) {
  async function show(ctx, callback = false) {
    const entries = ctx.services.referrals.getLeaderboard(10);
    const text = entries.length
      ? [
        '🏆 <b>Top Inviters</b>',
        '',
        ...entries.map((entry, index) => {
          const label = entry.username
            ? `@${escapeHtml(entry.username)}`
            : `${escapeHtml(entry.first_name)} (${entry.telegram_id})`;
          return `${index + 1}. ${label} — <b>${entry.referral_count}</b>`;
        })
      ].join('\n')
      : '🏆 No eligible referrals have been recorded yet. Be the first to invite a new member!';
    if (callback) await ctx.answerCbQuery();
    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  bot.command('leaderboard', (ctx) => show(ctx));
  bot.action(/^menu:leaderboard(?::(-?\d+))?$/, (ctx) => show(ctx, true));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

module.exports = { registerLeaderboardHandlers };
