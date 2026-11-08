const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate, DEFAULT_REWARDS } = require('./migrations');

function createDatabase(databasePath, adminIds = [], rewardDefaults = DEFAULT_REWARDS, initialGroupId = null) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db, adminIds, rewardDefaults, initialGroupId);
  return db;
}

function ensureGroup(db, chat, rewardDefaults = DEFAULT_REWARDS) {
  if (!Number.isSafeInteger(chat.id) || chat.id >= 0) {
    throw new Error('Only Telegram groups and supergroups can be registered.');
  }
  const insert = db.prepare(`
    INSERT INTO groups (chat_id, title, type)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title = COALESCE(excluded.title, groups.title),
      type = COALESCE(excluded.type, groups.type),
      is_active = 1,
      updated_at = datetime('now')
  `);
  const created = db.transaction(() => {
    const existed = db.prepare('SELECT 1 FROM groups WHERE chat_id = ?').get(chat.id);
    insert.run(chat.id, chat.title || chat.username || null, chat.type || null);
    if (!existed) {
      const addReward = db.prepare(`
        INSERT INTO reward_levels (group_id, threshold, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(group_id, threshold) DO NOTHING
      `);
      for (const reward of rewardDefaults) addReward.run(chat.id, reward.threshold, reward.amount);
    }
    return !existed;
  })();
  return created;
}

module.exports = { createDatabase, ensureGroup };
