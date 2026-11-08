const DEFAULT_REWARDS = [
  { threshold: 50, amount: 1000 },
  { threshold: 100, amount: 3000 },
  { threshold: 200, amount: 5000 },
  { threshold: 400, amount: 10000 }
];

function migrate(db, adminIds = [], rewardDefaults = DEFAULT_REWARDS) {
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

    CREATE TABLE IF NOT EXISTS invitation_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      group_id INTEGER NOT NULL,
      invite_link TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      UNIQUE (inviter_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      first_join_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      is_member INTEGER NOT NULL DEFAULT 1 CHECK (is_member IN (0, 1)),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      invitee_id INTEGER NOT NULL REFERENCES users(telegram_id),
      invitation_link_id INTEGER REFERENCES invitation_links(id),
      group_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      UNIQUE (group_id, invitee_id),
      CHECK (inviter_id <> invitee_id)
    );

    CREATE TABLE IF NOT EXISTS reward_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      threshold INTEGER NOT NULL UNIQUE CHECK (threshold > 0),
      amount INTEGER NOT NULL CHECK (amount > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reward_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      reward_level_id INTEGER NOT NULL REFERENCES reward_levels(id),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      reviewed_by INTEGER REFERENCES users(telegram_id),
      review_note TEXT,
      threshold_snapshot INTEGER,
      amount_snapshot INTEGER,
      UNIQUE (user_id, reward_level_id)
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL REFERENCES users(telegram_id),
      action TEXT NOT NULL,
      target_user_id INTEGER REFERENCES users(telegram_id),
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS referral_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      admin_id INTEGER NOT NULL REFERENCES users(telegram_id),
      delta INTEGER NOT NULL CHECK (delta <> 0),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_referrals_inviter_active
      ON referrals(inviter_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_referrals_invitee
      ON referrals(invitee_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_active
      ON group_members(group_id, is_member);
    CREATE INDEX IF NOT EXISTS idx_reward_claims_status
      ON reward_claims(status, requested_at);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_target
      ON audit_logs(target_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_adjustments_user
      ON referral_adjustments(user_id);
  `);

  const claimColumns = new Set(
    db.pragma('table_info(reward_claims)').map((column) => column.name)
  );
  if (!claimColumns.has('threshold_snapshot')) {
    db.exec('ALTER TABLE reward_claims ADD COLUMN threshold_snapshot INTEGER');
  }
  if (!claimColumns.has('amount_snapshot')) {
    db.exec('ALTER TABLE reward_claims ADD COLUMN amount_snapshot INTEGER');
  }
  db.exec(`
    UPDATE reward_claims
    SET threshold_snapshot = (SELECT threshold FROM reward_levels WHERE id = reward_level_id),
        amount_snapshot = (SELECT amount FROM reward_levels WHERE id = reward_level_id)
    WHERE threshold_snapshot IS NULL OR amount_snapshot IS NULL
  `);

  const insertReward = db.prepare(`
    INSERT INTO reward_levels (threshold, amount)
    VALUES (@threshold, @amount)
    ON CONFLICT(threshold) DO NOTHING
  `);
  const seedRewards = db.transaction((levels) => {
    for (const level of levels) insertReward.run(level);
  });
  seedRewards(rewardDefaults);

  const seedAdmin = db.prepare(`
    INSERT INTO users (telegram_id, first_name) VALUES (?, 'Administrator')
    ON CONFLICT(telegram_id) DO NOTHING
  `);
  const addAdmin = db.prepare(`
    INSERT INTO admin_users (telegram_id) VALUES (?)
    ON CONFLICT(telegram_id) DO NOTHING
  `);
  const seedAdmins = db.transaction((ids) => {
    for (const id of ids) {
      seedAdmin.run(id);
      addAdmin.run(id);
    }
    if (ids.length) {
      db.prepare(`DELETE FROM admin_users WHERE telegram_id NOT IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
    } else {
      db.exec('DELETE FROM admin_users');
    }
  });
  seedAdmins(adminIds);
}

module.exports = { migrate };
