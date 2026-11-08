const DEFAULT_REWARDS = [
  { threshold: 50, amount: 100 },
  { threshold: 100, amount: 300 },
  { threshold: 200, amount: 500 },
  { threshold: 400, amount: 1000 }
];

const PREVIOUS_DEFAULT_REWARDS = [
  { threshold: 50, amount: 1000 },
  { threshold: 100, amount: 3000 },
  { threshold: 200, amount: 5000 },
  { threshold: 400, amount: 10000 }
];

function tableExists(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name));
}
function columns(db, name) {
  return tableExists(db, name)
    ? new Set(db.pragma(`table_info(${name})`).map((column) => column.name))
    : new Set();
}

function migrate(db, adminIds = [], rewardDefaults = DEFAULT_REWARDS, legacyGroupId = null) {
  const legacyTables = [
    'invitation_links', 'group_members', 'referrals', 'reward_levels',
    'reward_claims', 'group_admins', 'audit_logs', 'referral_adjustments', 'admin_users'
  ];
  const oldColumns = Object.fromEntries(legacyTables.map((name) => [name, columns(db, name)]));
  oldColumns.users = columns(db, 'users');
  const legacyRewards = oldColumns.reward_levels.size > 0 &&
    !oldColumns.reward_levels.has('group_id');
  const scopedSchema = oldColumns.reward_levels.has('group_id') &&
    oldColumns.reward_claims.has('group_id') &&
    oldColumns.referral_adjustments.has('group_id') &&
    oldColumns.group_admins.has('group_id') &&
    tableExists(db, 'groups') && tableExists(db, 'global_admins');
  const knownGroupIds = new Set();
  if (legacyGroupId !== null && legacyGroupId !== undefined) knownGroupIds.add(legacyGroupId);
  for (const name of legacyTables) {
    if (!oldColumns[name].has('group_id')) continue;
    for (const row of db.prepare(`SELECT DISTINCT group_id FROM ${name}`).all()) {
      if (row.group_id !== null) knownGroupIds.add(Number(row.group_id));
    }
  }
  if (legacyRewards && knownGroupIds.size === 0) {
    throw new Error(
      'Legacy rewards have no saved group ID. Set LEGACY_GROUP_ID (or GROUP_ID) to migrate them safely.'
    );
  }
  if (legacyRewards && knownGroupIds.size > 1 && !legacyGroupId) {
    throw new Error(
      'Legacy rewards are ambiguous across groups. Set LEGACY_GROUP_ID to the original group ID.'
    );
  }
  const hasUnscopedData = legacyTables.some((name) =>
    oldColumns[name].size > 0 &&
    name !== 'admin_users' &&
    !oldColumns[name].has('group_id') &&
    db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()
  );
  if (hasUnscopedData && knownGroupIds.size === 0) {
    throw new Error(
      'Legacy database records have no saved group ID. Set LEGACY_GROUP_ID (or GROUP_ID) to migrate them safely.'
    );
  }
  if (hasUnscopedData && knownGroupIds.size > 1 && !legacyGroupId) {
    throw new Error(
      'Legacy group-scoped records cannot be assigned safely across multiple groups. Set LEGACY_GROUP_ID.'
    );
  }
  const rewardGroupId = legacyGroupId || knownGroupIds.values().next().value;
  const createdGroups = [];

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          telegram_id INTEGER PRIMARY KEY,
          username TEXT,
          first_name TEXT NOT NULL,
          last_name TEXT,
          is_bot INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
          is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
          block_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS groups (
          chat_id INTEGER PRIMARY KEY,
          title TEXT,
          type TEXT,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          settings_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS global_admins (
          telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      if (!columns(db, 'groups').has('settings_json')) {
        db.exec("ALTER TABLE groups ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'");
      }

      const addGroup = db.prepare(`
        INSERT OR IGNORE INTO groups (chat_id, title, type) VALUES (?, ?, ?)
      `);
      for (const chatId of knownGroupIds) {
        if (addGroup.run(chatId, 'Telegram group', null).changes) createdGroups.push(chatId);
      }

      if (!scopedSchema) {
        createScopedTables(db);
        copyLegacyData(db, oldColumns, rewardGroupId);
        for (const name of legacyTables) {
          if (tableExists(db, name)) db.exec(`DROP TABLE ${name}`);
        }
        db.exec(`
          ALTER TABLE invitation_links_new RENAME TO invitation_links;
          ALTER TABLE group_members_new RENAME TO group_members;
          ALTER TABLE referrals_new RENAME TO referrals;
          ALTER TABLE reward_levels_new RENAME TO reward_levels;
          ALTER TABLE reward_claims_new RENAME TO reward_claims;
          ALTER TABLE group_admins_new RENAME TO group_admins;
          ALTER TABLE audit_logs_new RENAME TO audit_logs;
          ALTER TABLE referral_adjustments_new RENAME TO referral_adjustments;
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_referrals_group_inviter_active
          ON referrals(group_id, inviter_id, is_active);
        CREATE INDEX IF NOT EXISTS idx_referrals_group_invitee
          ON referrals(group_id, invitee_id);
        CREATE INDEX IF NOT EXISTS idx_group_members_group_active
          ON group_members(group_id, is_member);
        CREATE INDEX IF NOT EXISTS idx_group_admins_user
          ON group_admins(telegram_id, group_id);
        CREATE INDEX IF NOT EXISTS idx_reward_claims_group_status
          ON reward_claims(group_id, status, requested_at);
        CREATE INDEX IF NOT EXISTS idx_audit_logs_group_target
          ON audit_logs(group_id, target_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_adjustments_group_user
          ON referral_adjustments(group_id, user_id);
      `);

      const seedRewards = db.prepare(`
        INSERT INTO reward_levels (group_id, threshold, amount)
        VALUES (?, ?, ?)
        ON CONFLICT(group_id, threshold) DO NOTHING
      `);
      for (const chatId of createdGroups) {
        if (db.prepare('SELECT 1 FROM reward_levels WHERE group_id = ? LIMIT 1').get(chatId)) {
          continue;
        }
        for (const reward of rewardDefaults) seedRewards.run(chatId, reward.threshold, reward.amount);
      }

      if (!db.prepare(
        "SELECT 1 FROM app_metadata WHERE key = 'default_rewards_divided_by_ten'"
      ).get()) {
        const updateDefaultReward = db.prepare(`
          UPDATE reward_levels SET amount = ?
          WHERE threshold = ? AND amount = ?
        `);
        for (const previousReward of PREVIOUS_DEFAULT_REWARDS) {
          const currentReward = DEFAULT_REWARDS.find(
            (reward) => reward.threshold === previousReward.threshold
          );
          updateDefaultReward.run(
            currentReward.amount,
            previousReward.threshold,
            previousReward.amount
          );
        }
        db.prepare(`
          INSERT INTO app_metadata (key, value)
          VALUES ('default_rewards_divided_by_ten', '1')
        `).run();
      }

      const addGlobalAdmin = db.prepare(`
        INSERT INTO global_admins (telegram_id) VALUES (?)
        ON CONFLICT(telegram_id) DO NOTHING
      `);
      const addAdminUser = db.prepare(`
        INSERT INTO users (telegram_id, first_name) VALUES (?, 'Administrator')
        ON CONFLICT(telegram_id) DO NOTHING
      `);
      if (!db.prepare(
        "SELECT 1 FROM app_metadata WHERE key = 'global_admins_bootstrapped'"
      ).get()) {
        for (const id of adminIds) {
          addAdminUser.run(id);
          addGlobalAdmin.run(id);
        }
        db.prepare(`
          INSERT INTO app_metadata (key, value) VALUES ('global_admins_bootstrapped', '1')
        `).run();
      }
    })();

    db.pragma('foreign_keys = ON');
    const violations = db.pragma('foreign_key_check');
    if (violations.length) {
      throw new Error(`Database migration produced foreign-key violations: ${JSON.stringify(violations)}`);
    }
  } catch (error) {
    db.pragma('foreign_keys = ON');
    throw error;
  }
}

function createScopedTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitation_links_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      invite_link TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      UNIQUE (inviter_id, group_id),
      UNIQUE (id, group_id),
      FOREIGN KEY (group_id, inviter_id)
        REFERENCES group_members_new(group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_members_new (
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      first_join_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
      is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
      block_reason TEXT,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS referrals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      invitee_id INTEGER NOT NULL REFERENCES users(telegram_id),
      invitation_link_id INTEGER,
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      UNIQUE (group_id, invitee_id),
      FOREIGN KEY (group_id, inviter_id)
        REFERENCES group_members_new(group_id, user_id),
      FOREIGN KEY (group_id, invitee_id)
        REFERENCES group_members_new(group_id, user_id),
      FOREIGN KEY (invitation_link_id, group_id)
        REFERENCES invitation_links_new(id, group_id),
      CHECK (inviter_id <> invitee_id)
    );
    CREATE TABLE IF NOT EXISTS reward_levels_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      threshold INTEGER NOT NULL CHECK (threshold > 0),
      amount INTEGER NOT NULL CHECK (amount > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (group_id, threshold),
      UNIQUE (id, group_id)
    );
    CREATE TABLE IF NOT EXISTS reward_claims_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      reward_level_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(telegram_id),
      review_note TEXT,
      threshold_snapshot INTEGER,
      amount_snapshot INTEGER,
      UNIQUE (group_id, user_id, reward_level_id),
      FOREIGN KEY (group_id, user_id)
        REFERENCES group_members_new(group_id, user_id),
      FOREIGN KEY (reward_level_id, group_id)
        REFERENCES reward_levels_new(id, group_id)
    );
    CREATE TABLE IF NOT EXISTS group_admins_new (
      group_id INTEGER NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
      telegram_id INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, telegram_id)
    );
    CREATE TABLE IF NOT EXISTS audit_logs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      admin_id INTEGER NOT NULL REFERENCES users(telegram_id),
      action TEXT NOT NULL,
      target_user_id INTEGER REFERENCES users(telegram_id),
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS referral_adjustments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(chat_id),
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      admin_id INTEGER NOT NULL REFERENCES users(telegram_id),
      delta INTEGER NOT NULL CHECK (delta <> 0),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function copyLegacyData(db, oldColumns, legacyGroupId) {
  const has = (table, column) => oldColumns[table].has(column);
  const insertIfExists = (table, sql) => {
    if (oldColumns[table].size) db.exec(sql);
  };
  insertIfExists('invitation_links', `
    INSERT INTO invitation_links_new
      (id, inviter_id, group_id, invite_link, created_at, revoked_at)
    SELECT id, inviter_id, group_id, invite_link, created_at, revoked_at
    FROM invitation_links;
  `);
  insertIfExists('group_members', `
    INSERT INTO group_members_new
      (group_id, user_id, first_join_seen_at, last_joined_at, left_at, is_member)
    SELECT group_id, user_id, first_join_seen_at, last_joined_at, left_at, is_member
    FROM group_members;
  `);
  if (oldColumns.group_members.has('is_blocked')) {
    db.exec(`
      UPDATE group_members_new
      SET is_blocked = COALESCE((SELECT is_blocked FROM group_members old
        WHERE old.group_id = group_members_new.group_id AND old.user_id = group_members_new.user_id), 0);
    `);
  }
  if (has('group_members', 'block_reason')) {
    db.exec(`
      UPDATE group_members_new
      SET block_reason = (SELECT block_reason FROM group_members old
        WHERE old.group_id = group_members_new.group_id AND old.user_id = group_members_new.user_id);
    `);
  }
  insertIfExists('referrals', `
    INSERT INTO referrals_new
      (id, inviter_id, invitee_id, invitation_link_id, group_id, joined_at, left_at, is_active)
    SELECT id, inviter_id, invitee_id, invitation_link_id, group_id, joined_at, left_at, is_active
    FROM referrals;
  `);
  if (oldColumns.reward_levels.size) {
    const rows = db.prepare('SELECT * FROM reward_levels ORDER BY id').all();
    const add = db.prepare(`
      INSERT INTO reward_levels_new (id, group_id, threshold, amount, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      add.run(row.id, has('reward_levels', 'group_id') ? row.group_id : legacyGroupId,
        row.threshold, row.amount, row.is_active, row.updated_at);
    }
  }
  if (oldColumns.reward_claims.size) {
    const claimColumns = oldColumns.reward_claims;
    const claims = db.prepare('SELECT * FROM reward_claims ORDER BY id').all();
    const add = db.prepare(`
      INSERT INTO reward_claims_new
        (id, group_id, user_id, reward_level_id, status, requested_at, reviewed_at,
         reviewed_by, review_note, threshold_snapshot, amount_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of claims) {
      const groupId = has('reward_claims', 'group_id')
        ? row.group_id
        : (has('reward_levels', 'group_id')
          ? db.prepare('SELECT group_id FROM reward_levels WHERE id = ?').get(row.reward_level_id)?.group_id
          : legacyGroupId);
      add.run(row.id, groupId, row.user_id, row.reward_level_id, row.status,
        row.requested_at, row.reviewed_at, row.reviewed_by, row.review_note,
        claimColumns.has('threshold_snapshot') ? row.threshold_snapshot : null,
        claimColumns.has('amount_snapshot') ? row.amount_snapshot : null);
    }
  }
  insertIfExists('admin_users', `
    INSERT OR IGNORE INTO global_admins (telegram_id, created_at)
    SELECT telegram_id, created_at FROM admin_users;
  `);
  insertIfExists('group_admins', `
    INSERT OR IGNORE INTO group_admins_new (group_id, telegram_id, created_at)
    SELECT group_id, telegram_id, created_at FROM group_admins;
  `);
  if (oldColumns.audit_logs.size) {
    const auditColumns = oldColumns.audit_logs;
    db.prepare('SELECT * FROM audit_logs ORDER BY id').all().forEach((row) => {
      db.prepare(`
        INSERT INTO audit_logs_new
          (id, group_id, admin_id, action, target_user_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, auditColumns.has('group_id') ? row.group_id : legacyGroupId,
        row.admin_id, row.action, row.target_user_id, row.details, row.created_at);
    });
  }
  if (oldColumns.referral_adjustments.size) {
    const adjustmentColumns = oldColumns.referral_adjustments;
    db.prepare('SELECT * FROM referral_adjustments ORDER BY id').all().forEach((row) => {
      db.prepare(`
        INSERT INTO referral_adjustments_new
          (id, group_id, user_id, admin_id, delta, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, adjustmentColumns.has('group_id') ? row.group_id : legacyGroupId,
        row.user_id, row.admin_id, row.delta, row.reason, row.created_at);
    });
  }
  if (oldColumns.users?.size) {
    db.exec(`
      UPDATE group_members_new SET is_blocked = 1,
        block_reason = (SELECT block_reason FROM users WHERE users.telegram_id = group_members_new.user_id)
      WHERE EXISTS (SELECT 1 FROM users
        WHERE users.telegram_id = group_members_new.user_id AND users.is_blocked = 1);
    `);
  }
}

module.exports = { migrate, DEFAULT_REWARDS };
