const config = require('./src/config');
const { createBot } = require('./src/bot');
const logger = require('./src/utils/logger');

const { bot, db } = createBot(config);
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('Stopping Telegram bot', { signal });
  try {
    bot.stop(signal);
  } finally {
    db.close();
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

bot.launch({
  allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
}).then(() => {
  logger.info('Telegram referral bot is running', { groupId: config.groupId });
}).catch((error) => {
  logger.error('Could not start Telegram bot', { error: error.message, stack: error.stack });
  db.close();
  process.exitCode = 1;
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', {
    error: error instanceof Error ? error.message : String(error)
  });
});
