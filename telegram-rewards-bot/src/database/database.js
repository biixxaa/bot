const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { migrate } = require('./migrations');

function createDatabase(databasePath, adminIds = [], rewardDefaults) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db, adminIds, rewardDefaults);
  return db;
}

module.exports = { createDatabase };
