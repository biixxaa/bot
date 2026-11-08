require('dotenv').config();
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_REWARDS } = require('./database/migrations');

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

const initialGroupValue = process.env.LEGACY_GROUP_ID?.trim() || process.env.GROUP_ID?.trim();
const initialGroupId = initialGroupValue
  ? parseTelegramId(initialGroupValue, 'LEGACY_GROUP_ID')
  : null;
if (initialGroupId !== null && initialGroupId >= 0) {
  throw new Error('LEGACY_GROUP_ID must be a negative Telegram group chat ID.');
}
const databasePath = process.env.DATABASE_PATH?.trim() || './data/referrals.sqlite';
const resolvedDatabasePath = path.resolve(databasePath);
const temporaryDirectory = path.resolve(os.tmpdir()) + path.sep;
if (resolvedDatabasePath.toLowerCase().startsWith(temporaryDirectory.toLowerCase())) {
  throw new Error('DATABASE_PATH must use persistent storage, not a temporary directory.');
}

module.exports = {
  botToken: required('BOT_TOKEN'),
  adminIds: [...new Set(adminIds)],
  initialGroupId,
  databasePath,
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  rewardDefaults: DEFAULT_REWARDS
};
