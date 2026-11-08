const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDatabase, ensureGroup } = require('../src/database/database');
const { migrate } = require('../src/database/migrations');
const { createReferralService } = require('../src/services/referralService');
const { createRewardService } = require('../src/services/rewardService');
const { createBot } = require('../src/bot');
const { adminAuth } = require('../src/middleware/adminAuth');
const { acquirePollingLock } = require('../src/utils/pollingLock');

const GROUP_A = -100123;
const GROUP_B = -100456;
const REWARDS = [
  { threshold: 1, amount: 100 },
  { threshold: 5, amount: 500 }
];

function setup() {
  const db = createDatabase(':memory:', [9000], REWARDS);
  ensureGroup(db, { id: GROUP_A, title: 'Group A', type: 'supergroup' }, REWARDS);
  ensureGroup(db, { id: GROUP_B, title: 'Group B', type: 'supergroup' }, REWARDS);
  const referralsA = createReferralService(db, GROUP_A);
  const referralsB = createReferralService(db, GROUP_B);
  const rewardsA = createRewardService(db, referralsA, GROUP_A);
  const rewardsB = createRewardService(db, referralsB, GROUP_B);
  for (const referrals of [referralsA, referralsB]) {
    referrals.saveUser({ id: 101, first_name: 'Inviter' });
    referrals.recordJoin({ id: 101, first_name: 'Inviter' }, null);
  }
  referralsA.saveLink(101, 'https://t.me/+group-a-link');
  referralsB.saveLink(101, 'https://t.me/+group-b-link');
  return { db, referralsA, referralsB, rewardsA, rewardsB };
}

test('referral counts, attribution, and leave/rejoin state are isolated by group', () => {
  const { db, referralsA, referralsB } = setup();
  const invitee = { id: 201, first_name: 'Invitee', is_bot: false };

  assert.equal(referralsA.recordJoin(invitee, 'https://t.me/+group-a-link').referralCreated, true);
  assert.equal(referralsA.getStats(101).referralCount, 1);
  assert.equal(referralsB.getStats(101).referralCount, 0);

  assert.equal(referralsB.recordJoin(invitee, 'https://t.me/+group-b-link').referralCreated, true);
  assert.equal(referralsB.getStats(101).referralCount, 1);
  assert.equal(referralsA.getStats(101).referralCount, 1);

  assert.equal(referralsA.recordJoin(invitee, 'https://t.me/+group-a-link').duplicate, true);
  referralsA.recordLeave(invitee);
  assert.equal(referralsA.getStats(101).referralCount, 0);
  assert.equal(referralsB.getStats(101).referralCount, 1);

  assert.equal(referralsA.recordJoin(invitee, 'https://t.me/+group-a-link').referralCreated, false);
  assert.equal(referralsA.getStats(101).referralCount, 0);
  db.close();
});

test('unattributed joins, self-referrals, bots, and duplicate referral rewards do not count', () => {
  const { db, referralsA } = setup();
  assert.equal(referralsA.recordJoin({ id: 202, first_name: 'NoLink' }, null).referralCreated, false);
  assert.equal(referralsA.recordJoin(
    { id: 101, first_name: 'Inviter' }, 'https://t.me/+group-a-link'
  ).referralCreated, false);
  assert.equal(referralsA.recordJoin(
    { id: 203, first_name: 'Bot', is_bot: true }, 'https://t.me/+group-a-link'
  ).referralCreated, false);
  assert.equal(referralsA.getStats(101).referralCount, 0);
  db.close();
});

test('reward levels and initial defaults are created independently for each group', () => {
  const { db, rewardsA, rewardsB } = setup();
  assert.deepEqual(rewardsA.listRewards().map(({ threshold, amount }) => [threshold, amount]), [
    [1, 100], [5, 500]
  ]);
  assert.deepEqual(rewardsB.listRewards().map(({ threshold, amount }) => [threshold, amount]), [
    [1, 100], [5, 500]
  ]);

  rewardsA.setReward(9000, 1, 250);
  assert.equal(rewardsA.listRewards()[0].amount, 250);
  assert.equal(rewardsB.listRewards()[0].amount, 100);
  assert.notEqual(rewardsA.listRewards()[0].id, rewardsB.listRewards()[0].id);
  db.close();
});

test('new groups receive the specified default reward thresholds and amounts', () => {
  const db = createDatabase(':memory:', [9000]);
  ensureGroup(db, { id: GROUP_A, title: 'Group A', type: 'supergroup' });
  ensureGroup(db, { id: GROUP_B, title: 'Group B', type: 'supergroup' });
  const expected = [[50, 100], [100, 300], [200, 500], [400, 1000]];
  for (const groupId of [GROUP_A, GROUP_B]) {
    assert.deepEqual(db.prepare(`
      SELECT threshold, amount FROM reward_levels
      WHERE group_id = ? ORDER BY threshold
    `).all(groupId).map((level) => [level.threshold, level.amount]), expected);
  }
  db.close();
});

test('migration divides existing default rewards by ten once and preserves custom amounts', () => {
  const db = createDatabase(':memory:', [9000], [
    { threshold: 50, amount: 1000 },
    { threshold: 100, amount: 3000 },
    { threshold: 200, amount: 5000 },
    { threshold: 400, amount: 10000 }
  ]);
  ensureGroup(db, { id: GROUP_A, title: 'Group A', type: 'supergroup' }, [
    { threshold: 50, amount: 1000 },
    { threshold: 100, amount: 3000 },
    { threshold: 200, amount: 5000 },
    { threshold: 400, amount: 10000 }
  ]);
  db.prepare('UPDATE reward_levels SET amount = 4500 WHERE group_id = ? AND threshold = 200')
    .run(GROUP_A);
  db.prepare("DELETE FROM app_metadata WHERE key = 'default_rewards_divided_by_ten'").run();

  migrate(db, [9000]);
  const expected = [[50, 100], [100, 300], [200, 4500], [400, 1000]];
  assert.deepEqual(db.prepare(`
    SELECT threshold, amount FROM reward_levels
    WHERE group_id = ? ORDER BY threshold
  `).all(GROUP_A).map((level) => [level.threshold, level.amount]), expected);

  migrate(db, [9000]);
  assert.deepEqual(db.prepare(`
    SELECT threshold, amount FROM reward_levels
    WHERE group_id = ? ORDER BY threshold
  `).all(GROUP_A).map((level) => [level.threshold, level.amount]), expected);
  db.close();
});

test('claims are group-scoped, unique per group, preserve amounts, and recheck eligibility', () => {
  const { db, referralsA, referralsB, rewardsA, rewardsB } = setup();
  const invitee = { id: 301, first_name: 'Invitee' };
  referralsA.recordJoin(invitee, 'https://t.me/+group-a-link');
  referralsB.recordJoin(invitee, 'https://t.me/+group-b-link');
  const claimA = rewardsA.requestClaim(101, rewardsA.listRewards()[0].id);
  const claimB = rewardsB.requestClaim(101, rewardsB.listRewards()[0].id);
  assert.notEqual(claimA.id, claimB.id);
  assert.throws(() => rewardsA.requestClaim(101, rewardsA.listRewards()[0].id), /already been submitted/);

  rewardsA.setReward(9000, 1, 250);
  assert.equal(rewardsA.listClaims()[0].amount, 100);
  assert.throws(() => rewardsB.reviewClaim(9000, claimA.id, 'approved'), /Claim not found in this group/);
  referralsA.recordLeave(invitee);
  assert.throws(
    () => rewardsA.reviewClaim(9000, claimA.id, 'approved'),
    /no longer meets the referral threshold/
  );
  assert.equal(rewardsB.reviewClaim(9000, claimB.id, 'approved').status, 'approved');
  db.close();
});

test('group administrators are isolated while global administrators can access every group', async () => {
  const { db } = setup();
  db.prepare(`
    INSERT INTO users (telegram_id, first_name) VALUES (9001, 'Group admin')
  `).run();
  db.prepare(`
    INSERT INTO group_admins (group_id, telegram_id) VALUES (?, ?)
  `).run(GROUP_A, 9001);

  const guard = adminAuth(db);
  async function allowed(userId, groupId) {
    let passed = false;
    await guard({
      chat: { type: 'private' },
      from: { id: userId },
      groupId,
      reply: async () => {}
    }, async () => { passed = true; });
    return passed;
  }
  assert.equal(await allowed(9001, GROUP_A), true);
  assert.equal(await allowed(9001, GROUP_B), false);
  assert.equal(await allowed(9000, GROUP_A), true);
  assert.equal(await allowed(9000, GROUP_B), true);
  db.close();
});

test('group-specific adjustments, member blocks, and audit records do not leak across groups', () => {
  const { db, referralsA, referralsB, rewardsA } = setup();
  const member = { id: 401, first_name: 'Member', username: 'test_user' };
  referralsA.recordJoin(member, null);
  referralsB.recordJoin(member, null);
  assert.equal(referralsA.adjustCount(9000, 401, 3, 'Verified offline evidence'), 3);
  assert.equal(referralsA.getStats(401).referralCount, 3);
  assert.equal(referralsB.getStats(401).referralCount, 0);
  assert.equal(referralsA.searchUsers('test_user').length, 1);
  assert.equal(referralsA.searchUsers('testXuser').length, 0);
  referralsA.setBlocked(9000, 401, true, 'policy');
  assert.equal(referralsA.getUser(401).is_blocked, 1);
  assert.equal(referralsB.getUser(401).is_blocked, 0);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM audit_logs WHERE group_id = ?'
  ).get(GROUP_A).count, 2);
  assert.equal(db.prepare(
    'SELECT COUNT(*) AS count FROM audit_logs WHERE group_id = ?'
  ).get(GROUP_B).count, 0);
  assert.equal(rewardsA.exportRows()[0].referral_count, 3);
  db.close();
});

test('legacy single-group database migration preserves records and promotes old admins globally', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      telegram_id INTEGER PRIMARY KEY, username TEXT, first_name TEXT NOT NULL,
      last_name TEXT, is_bot INTEGER NOT NULL DEFAULT 0, is_blocked INTEGER NOT NULL DEFAULT 0,
      block_reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE invitation_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      group_id INTEGER NOT NULL, invite_link TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT,
      UNIQUE (inviter_id, group_id)
    );
    CREATE TABLE group_members (
      group_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      first_join_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_joined_at TEXT NOT NULL DEFAULT (datetime('now')), left_at TEXT,
      is_member INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, inviter_id INTEGER NOT NULL REFERENCES users(telegram_id),
      invitee_id INTEGER NOT NULL REFERENCES users(telegram_id), invitation_link_id INTEGER,
      group_id INTEGER NOT NULL, joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      left_at TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE (group_id, invitee_id)
    );
    CREATE TABLE reward_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT, threshold INTEGER NOT NULL UNIQUE,
      amount INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE reward_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      reward_level_id INTEGER NOT NULL REFERENCES reward_levels(id),
      status TEXT NOT NULL DEFAULT 'pending', requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(telegram_id), review_note TEXT,
      threshold_snapshot INTEGER, amount_snapshot INTEGER, UNIQUE (user_id, reward_level_id)
    );
    CREATE TABLE admin_users (
      telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL REFERENCES users(telegram_id),
      action TEXT NOT NULL, target_user_id INTEGER REFERENCES users(telegram_id),
      details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE referral_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(telegram_id),
      admin_id INTEGER NOT NULL REFERENCES users(telegram_id), delta INTEGER NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (telegram_id, first_name) VALUES
      (101, 'Inviter'), (201, 'Invitee'), (9001, 'Legacy admin');
    INSERT INTO invitation_links (id, inviter_id, group_id, invite_link)
      VALUES (1, 101, -100123, 'https://t.me/+legacy-link');
    INSERT INTO group_members (group_id, user_id) VALUES (-100123, 101), (-100123, 201);
    INSERT INTO referrals (id, inviter_id, invitee_id, invitation_link_id, group_id)
      VALUES (1, 101, 201, 1, -100123);
    INSERT INTO reward_levels (id, threshold, amount) VALUES (5, 50, 1000);
    INSERT INTO reward_claims
      (id, user_id, reward_level_id, threshold_snapshot, amount_snapshot)
      VALUES (9, 101, 5, 50, 1000);
    INSERT INTO admin_users (telegram_id) VALUES (9001);
    INSERT INTO audit_logs (id, admin_id, action, details)
      VALUES (7, 9001, 'legacy_action', '{}');
    INSERT INTO referral_adjustments (id, user_id, admin_id, delta, reason)
      VALUES (8, 101, 9001, 2, 'legacy adjustment');
  `);

  migrate(db, [9000], undefined, GROUP_A);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM referrals WHERE group_id = ?')
    .get(GROUP_A).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_claims WHERE group_id = ?')
    .get(GROUP_A).count, 1);
  assert.equal(db.prepare('SELECT amount FROM reward_levels WHERE group_id = ? AND id = 5')
    .get(GROUP_A).amount, 100);
  assert.equal(db.prepare('SELECT amount_snapshot FROM reward_claims WHERE group_id = ? AND id = 9')
    .get(GROUP_A).amount_snapshot, 1000);
  assert.ok(db.prepare('SELECT 1 FROM global_admins WHERE telegram_id = 9001').get());
  assert.ok(db.prepare('SELECT 1 FROM global_admins WHERE telegram_id = 9000').get());
  assert.equal(db.prepare('SELECT group_id FROM audit_logs WHERE id = 7').get().group_id, GROUP_A);
  assert.equal(db.prepare('SELECT group_id FROM referral_adjustments WHERE id = 8').get().group_id, GROUP_A);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  migrate(db, [9000], undefined, GROUP_A);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_levels').get().count, 1);
  db.close();
});

test('safe migration refuses to guess the owner group for legacy reward data', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (telegram_id INTEGER PRIMARY KEY, first_name TEXT NOT NULL);
    CREATE TABLE reward_levels (
      id INTEGER PRIMARY KEY, threshold INTEGER NOT NULL UNIQUE, amount INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO reward_levels (id, threshold, amount) VALUES (1, 50, 1000);
  `);
  assert.throws(() => migrate(db, []), /Set LEGACY_GROUP_ID/);
  db.close();
});

test('configured global administrators bootstrap once and explicit removals persist on restart', () => {
  const db = createDatabase(':memory:', [9000], REWARDS);
  db.prepare('DELETE FROM global_admins WHERE telegram_id = 9000').run();
  migrate(db, [9000], REWARDS);
  assert.equal(db.prepare(
    'SELECT 1 FROM global_admins WHERE telegram_id = 9000'
  ).get(), undefined);
  db.close();
});

test('bot registers all Telegram handlers and creates distinct group services', () => {
  const db = createDatabase(':memory:', [9000], REWARDS);
  const { bot, services, getServices } = createBot({
    botToken: '123456789:TEST_TOKEN',
    groupId: GROUP_A,
    adminIds: [9000],
    rewardDefaults: REWARDS
  }, db);
  ensureGroup(db, { id: GROUP_B, title: 'Group B', type: 'supergroup' }, REWARDS);
  assert.ok(bot);
  assert.notEqual(services.referrals.groupId, getServices(GROUP_B).referrals.groupId);
  db.close();
});

test('Telegram membership updates count and deactivate referrals in the originating group only', async () => {
  const { db, referralsA, referralsB } = setup();
  const { bot } = createBot({
    botToken: '123456789:TEST_TOKEN',
    groupId: GROUP_A,
    adminIds: [9000],
    rewardDefaults: REWARDS
  }, db);
  referralsA.saveLink(101, 'https://t.me/+group-a-link');
  referralsB.saveLink(101, 'https://t.me/+group-b-link');
  const sentMessages = [];
  bot.botInfo = { id: 123456789, is_bot: true, first_name: 'Test', username: 'testbot' };
  bot.telegram.sendMessage = async (...args) => { sentMessages.push(args); return {}; };
  const invitee = { id: 501, first_name: 'Invitee', is_bot: false };
  const membershipUpdate = (updateId, groupId, oldStatus, newStatus, user, inviteLink) => ({
    update_id: updateId,
    chat_member: {
      chat: { id: groupId, title: `Group ${groupId}`, type: 'supergroup' },
      from: { id: 9000, is_bot: false, first_name: 'Admin' },
      date: 1,
      old_chat_member: { user, status: oldStatus },
      new_chat_member: { user, status: newStatus },
      ...(inviteLink ? { invite_link: { invite_link: inviteLink } } : {})
    }
  });
  await bot.handleUpdate(membershipUpdate(
    1, GROUP_A, 'left', 'member', invitee, 'https://t.me/+group-a-link'
  ));
  await bot.handleUpdate(membershipUpdate(
    2, GROUP_B, 'left', 'member', invitee, 'https://t.me/+group-b-link'
  ));
  assert.equal(referralsA.getStats(101).referralCount, 1);
  assert.equal(referralsB.getStats(101).referralCount, 1);
  await bot.handleUpdate(membershipUpdate(3, GROUP_A, 'member', 'left', invitee));
  assert.equal(referralsA.getStats(101).referralCount, 0);
  assert.equal(referralsB.getStats(101).referralCount, 1);
  assert.ok(sentMessages.length >= 4);
  db.close();
});

test('multiple welcome messages are sent without waiting for earlier Telegram responses', async () => {
  const { db } = setup();
  const { bot } = createBot({
    botToken: '123456789:TEST_TOKEN',
    groupId: GROUP_A,
    adminIds: [9000],
    rewardDefaults: REWARDS
  }, db);
  const sentMessages = [];
  const releaseSends = [];
  bot.botInfo = { id: 123456789, is_bot: true, first_name: 'Test', username: 'testbot' };
  bot.telegram.sendMessage = (...args) => {
    sentMessages.push(args);
    return new Promise((resolve) => releaseSends.push(resolve));
  };

  const updatePromise = bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: GROUP_A, title: 'Group A', type: 'supergroup' },
      from: { id: 9000, is_bot: false, first_name: 'Admin' },
      new_chat_members: [
        { id: 501, first_name: 'First', is_bot: false },
        { id: 502, first_name: 'Second', is_bot: false }
      ]
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 2);
  releaseSends.forEach((resolve) => resolve({}));
  await updatePromise;
  db.close();
});

test('only one polling process can hold a database lock at a time', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-poll-lock-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'bot.sqlite');
  const release = acquirePollingLock(databasePath);
  assert.throws(() => acquirePollingLock(databasePath), /already running/);
  release();
  const releaseAgain = acquirePollingLock(databasePath);
  releaseAgain();
});
