const config = require('./src/config');
const { createBot } = require('./src/bot');
const logger = require('./src/utils/logger');
const { acquirePollingLock } = require('./src/utils/pollingLock');

let bot;
let db;
let releasePollingLock;
let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('Stopping Telegram bot', { signal });
  try {
    bot?.stop(signal);
  } catch (error) {
    logger.warn('Error while stopping Telegram polling', { error: error.message });
  } finally {
    try {
      db?.close();
    } finally {
      releasePollingLock?.();
    }
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

try {
  releasePollingLock = acquirePollingLock(config.databasePath);
  ({ bot, db } = createBot(config));
  bot.launch({
    allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member']
  }).then(() => {
    logger.info('Telegram referral bot is running', { databasePath: config.databasePath });
  }).catch((error) => {
    logger.error('Could not start Telegram bot', { error: error.message, stack: error.stack });
    try {
      db.close();
    } finally {
      releasePollingLock?.();
      process.exitCode = 1;
    }
  });
} catch (error) {
  logger.error('Could not initialize Telegram bot', { error: error.message, stack: error.stack });
  try {
    db?.close();
  } finally {
    releasePollingLock?.();
    process.exitCode = 1;
  }
}

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection', {
    error: error instanceof Error ? error.message : String(error)
  });
});
