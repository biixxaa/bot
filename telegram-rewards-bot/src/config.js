require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseTelegramId(value, name) {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be a Telegram numeric ID`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id === 0) {
    throw new Error(`${name} must be a non-zero safe integer`);
  }
  return id;
}

const adminIds = required('ADMIN_IDS')
  .split(',')
  .map((value) => parseTelegramId(value.trim(), 'ADMIN_IDS entry'));

if (adminIds.some((id) => id < 0)) {
  throw new Error('ADMIN_IDS must contain positive user IDs');
}

const config = {
  botToken: required('BOT_TOKEN'),
  groupId: parseTelegramId(required('GROUP_ID'), 'GROUP_ID'),
  adminIds: [...new Set(adminIds)],
  databasePath: process.env.DATABASE_PATH?.trim() || './data/referrals.sqlite',
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  rewardDefaults: [
    { threshold: 50, amount: 1000 },
    { threshold: 100, amount: 3000 },
    { threshold: 200, amount: 5000 },
    { threshold: 400, amount: 10000 }
  ]
};

module.exports = config;
