const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../src/database/database');
const { migrate } = require('../src/database/migrations');
const { createReferralService } = require('../src/services/referralService');
const { createRewardService } = require('../src/services/rewardService');
const { createBot } = require('../src/bot');
const { adminAuth } = require('../src/middleware/adminAuth');

function setup() {
  const db = createDatabase(':memory:', [9000]);
  const groupId = -100123;
  const referrals = createReferralService(db, groupId);
  const rewards = createRewardService(db, referrals, groupId);
  referrals.saveUser({ id: 101, first_name: 'Inviter' });
  referrals.saveLink(101, 'https://t.me/+personal-link');
  return { db, referrals, rewards };
}

test('only first-observed, attributed member joins count and leaving invalidates referrals', () => {
  const { db, referrals } = setup();
  const invitee = { id: 201, first_name: 'Invitee', is_bot: false };

  const joined = referrals.recordJoin(invitee, 'https://t.me/+personal-link');
  assert.equal(joined.referralCreated, true);
  assert.equal(referrals.getStats(101).referralCount, 1);

  const duplicateUpdate = referrals.recordJoin(invitee, 'https://t.me/+personal-link');
  assert.equal(duplicateUpdate.referralCreated, false);
  assert.equal(referrals.getStats(101).referralCount, 1);

  referrals.recordLeave(invitee);
  assert.equal(referrals.getStats(101).referralCount, 0);

  const rejoin = referrals.recordJoin(invitee, 'https://t.me/+personal-link');
  assert.equal(rejoin.referralCreated, false);
  assert.equal(referrals.getStats(101).referralCount, 0);
  db.close();
});

test('unattributed joins, self-referrals, and bot accounts do not count', () => {
  const { db, referrals } = setup();
  assert.equal(referrals.recordJoin({ id: 202, first_name: 'NoLink' }, null).referralCreated, false);
  assert.equal(referrals.recordJoin({ id: 101, first_name: 'Inviter' }, 'https://t.me/+personal-link').referralCreated, false);
  assert.equal(referrals.recordJoin({ id: 203, first_name: 'Bot', is_bot: true }, 'https://t.me/+personal-link').referralCreated, false);
  assert.equal(referrals.getStats(101).referralCount, 0);
  db.close();
});

test('one invitee cannot be credited to a different inviter', () => {
  const { db, referrals } = setup();
  referrals.saveUser({ id: 102, first_name: 'Other inviter' });
  referrals.saveLink(102, 'https://t.me/+other-link');
  const invitee = { id: 250, first_name: 'Invitee' };
  assert.equal(referrals.recordJoin(invitee, 'https://t.me/+personal-link').referralCreated, true);

  referrals.recordLeave(invitee);
  assert.equal(referrals.recordJoin(invitee, 'https://t.me/+other-link').referralCreated, false);
  assert.equal(referrals.getStats(101).referralCount, 0);
  assert.equal(referrals.getStats(102).referralCount, 0);
  db.close();
});

test('claims are unique, preserve requested amounts, and cannot be approved after a referral leaves', () => {
  const { db, referrals, rewards } = setup();
  rewards.setReward(9000, 1, 100);
  const invitee = { id: 301, first_name: 'Claimant' };
  referrals.recordJoin(invitee, 'https://t.me/+personal-link');
  const reward = rewards.listRewards().find((level) => level.threshold === 1);
  const claim = rewards.requestClaim(101, reward.id);

  rewards.setReward(9000, 1, 250);
  assert.throws(() => rewards.requestClaim(101, reward.id), /already been submitted/);

  referrals.recordLeave(invitee);
  assert.throws(
    () => rewards.reviewClaim(9000, claim.id, 'approved'),
    /no longer meets the referral threshold/
  );
  const pending = rewards.listClaims('pending')[0];
  assert.equal(pending.amount, 100);
  assert.equal(pending.status, 'pending');
  db.close();
});

test('eligible claims can be approved exactly once', () => {
  const { db, referrals, rewards } = setup();
  rewards.setReward(9000, 1, 100);
  referrals.recordJoin({ id: 302, first_name: 'Active invitee' }, 'https://t.me/+personal-link');
  const level = rewards.listRewards().find((reward) => reward.threshold === 1);
  const claim = rewards.requestClaim(101, level.id);
  const reviewed = rewards.reviewClaim(9000, claim.id, 'approved');
  assert.equal(reviewed.amount, 100);
  assert.equal(reviewed.status, 'approved');
  assert.throws(() => rewards.reviewClaim(9000, claim.id, 'approved'), /already approved/);
  db.close();
});

test('admin adjustments affect displayed count and are recorded with audit details', () => {
  const { db, referrals, rewards } = setup();
  referrals.saveUser({ id: 401, first_name: 'Member', username: 'test_user' });
  assert.equal(referrals.adjustCount(9000, 401, 3, 'Verified offline evidence'), 3);
  assert.equal(referrals.getStats(401).referralCount, 3);
  assert.equal(referrals.searchUsers('test_user').length, 1);
  assert.equal(referrals.searchUsers('testXuser').length, 0);
  const audit = db.prepare(`
    SELECT action, details FROM audit_logs WHERE target_user_id = ?
  `).get(401);
  assert.equal(audit.action, 'referral_count_adjusted');
  assert.equal(JSON.parse(audit.details).reason, 'Verified offline evidence');
  assert.equal(referrals.getLeaderboard(1)[0].referral_count, 3);
  assert.equal(rewards.exportRows()[0].referral_count, 3);
  db.close();
});

test('database migrations revoke administrators removed from the configured ID list', () => {
  const db = createDatabase(':memory:', [9000]);
  migrate(db, [9001]);
  assert.equal(db.prepare('SELECT 1 FROM admin_users WHERE telegram_id = 9000').get(), undefined);
  assert.ok(db.prepare('SELECT 1 FROM admin_users WHERE telegram_id = 9001').get());
  db.close();
});

test('all Telegram command and membership handlers register with Telegraf', () => {
  const db = createDatabase(':memory:', [9000]);
  const { bot } = createBot({
    botToken: '123456789:TEST_TOKEN',
    groupId: -100123,
    adminIds: [9000],
    rewardDefaults: []
  }, db);
  assert.ok(bot);
  db.close();
});

test('Telegram membership updates attribute joins and deactivate referrals on leave', async () => {
  const db = createDatabase(':memory:', [9000], [{ threshold: 1, amount: 100 }]);
  const { bot, services } = createBot({
    botToken: '123456789:TEST_TOKEN',
    groupId: -100123,
    adminIds: [9000],
    rewardDefaults: [{ threshold: 1, amount: 100 }]
  }, db);
  services.referrals.saveUser({ id: 101, first_name: 'Inviter' });
  services.referrals.saveLink(101, 'https://t.me/+personal-link');

  const sentMessages = [];
  bot.botInfo = {
    id: 123456789,
    is_bot: true,
    first_name: 'Test',
    username: 'testbot'
  };
  bot.telegram.sendMessage = async (...args) => {
    sentMessages.push(args);
    return {};
  };
  const invitee = { id: 201, first_name: 'Invitee', is_bot: false };
  const membershipUpdate = (updateId, oldStatus, newStatus, user, inviteLink) => ({
    update_id: updateId,
    chat_member: {
      chat: { id: -100123, type: 'supergroup' },
      from: { id: 9000, is_bot: false, first_name: 'Admin' },
      date: 1,
      old_chat_member: { user, status: oldStatus },
      new_chat_member: { user, status: newStatus },
      ...(inviteLink ? { invite_link: { invite_link: inviteLink } } : {})
    }
  });

  await bot.handleUpdate(membershipUpdate(
    1, 'left', 'member', invitee, 'https://t.me/+personal-link'
  ));
  assert.equal(services.referrals.getStats(101).referralCount, 1);
  assert.equal(sentMessages.length, 2);

  await bot.handleUpdate(membershipUpdate(
    2, 'left', 'member', invitee, 'https://t.me/+personal-link'
  ));
  assert.equal(services.referrals.getStats(101).referralCount, 1);
  assert.equal(sentMessages.length, 2);

  await bot.handleUpdate(membershipUpdate(3, 'member', 'left', invitee));
  assert.equal(services.referrals.getStats(101).referralCount, 0);
  db.close();
});

test('administrator controls are private-chat-only and ID-authorized', async () => {
  const db = createDatabase(':memory:', [9000]);
  const authorize = adminAuth(db);
  let called = false;
  const denied = {
    from: { id: 9000 },
    chat: { type: 'group' },
    reply: async () => {}
  };
  await authorize(denied, async () => { called = true; });
  assert.equal(called, false);

  const allowed = {
    from: { id: 9000 },
    chat: { type: 'private' }
  };
  await authorize(allowed, async () => { called = true; });
  assert.equal(called, true);

  const nonAdmin = {
    from: { id: 9010 },
    chat: { type: 'private' },
    reply: async () => {}
  };
  called = false;
  await authorize(nonAdmin, async () => { called = true; });
  assert.equal(called, false);
  db.close();
});
