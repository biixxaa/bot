# Telegram Referral Rewards Bot

A Node.js/Telegraf bot for running independent referral and reward programs in multiple Telegram groups. Members, invite links, active referrals, reward levels and claims, adjustments, blocks, statistics, and group administrators are scoped to the Telegram group chat ID. SQLite persists the data across restarts.

## Requirements

- Node.js 22 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- At least one global administrator's positive Telegram user ID
- One or more Telegram groups in which the bot can be an administrator

## Local setup

1. Install dependencies:

   ```sh
   npm ci
   ```

2. Copy `.env.example` to `.env` and configure:

   - `BOT_TOKEN`: secret token from BotFather. Never commit or share it.
   - `ADMIN_IDS`: comma-separated positive Telegram user IDs for global administrators.
   - `DATABASE_PATH`: SQLite file path; defaults to `./data/referrals.sqlite`. Its directory is created automatically. Choose persistent storage in deployments.
   - `LOG_LEVEL`: optional `error`, `warn`, `info` (default), or `debug`.
   - `LEGACY_GROUP_ID`: only needed to upgrade an old single-group database when its group ID cannot be inferred. For an existing installation, the previous `GROUP_ID` environment variable is also accepted during migration.

3. Start the bot:

   ```sh
   npm start
   ```

   Run automated tests with `npm test`.

Newly registered groups get their own initial reward levels:

| Active referrals | Reward |
|---:|---:|
| 50 | 100 ETB |
| 100 | 300 ETB |
| 200 | 500 ETB |
| 400 | 1,000 ETB |

These are group defaults. Existing default reward amounts are divided by ten once during migration. Custom reward amounts are preserved. Changing or disabling a group's levels does not change any other group's configuration.

## Add groups and member setup

1. Add the bot to each group and promote it to an administrator. Allow it to create invitation links and ensure Telegram delivers membership updates to it. The bot needs administrator access to track joins/leaves and create invite links; it does not need permission to ban members.
2. The bot registers groups automatically from Telegram group and membership updates. Check registration with `/admin groups` as a global administrator.
3. Have members, global administrators, and group administrators open a private chat with the bot and send `/start`. Telegram does not let the bot initiate a private conversation first, so this is required for private notifications and menus.
4. Members use `/invite` in private chat to create a personal invitation link. They must be recorded as active members of the selected group. If they participate in multiple groups, specify the group ID (for example `/invite -1001234567890`) or choose a group from `/start`.
5. To identify a group ID, use `/admin groups` or inspect a Telegram update delivered to the bot. Treat group IDs as operational data and do not publish them unnecessarily.

The bot uses long polling. Do not configure a competing webhook for the same token.

## Member commands

Commands are used in private chat. If there is more than one eligible group, include its chat ID:

- `/start` — open the group selector or selected group's menu
- `/invite [group_id]` — create or show your personal invitation link for a group
- `/profile [group_id]` — active referral count and next reward progress
- `/rewards [group_id]` — that group's reward levels
- `/leaderboard [group_id]` — that group's top 10 inviters
- `/claim [group_id]` — submit an eligible reward claim
- `/help` — usage and referral rules

The inline menu is tied to the selected group. A join is attributed only through a recognized, unrevoked personal invitation link.

## Administrator permissions and commands

Administrator commands and claim review controls are restricted to private chat.

**Global administrators** are the IDs in `ADMIN_IDS` on first startup and any accounts later granted global access. They can access every group, manage group administrators, and view global statistics:

- `/admin groups` — registered groups and active member counts
- `/admin global_stats` — global totals
- `/admin group_admin_add <group_id> <user_id>` / `/admin group_admin_remove <group_id> <user_id>` — manage a group's administrators
- `/admin global_admin_add <user_id>` / `/admin global_admin_remove <user_id>` — manage global administrators
- `/admin stats [group_id]` — live Telegram count and tracked totals for a selected group
- `/admin users [page] [group_id]`, `/admin search <ID|username> [group_id]`, `/admin user <ID|username> [group_id]`
- `/admin top [group_id]`, `/admin claims [group_id]`
- `/admin reward <threshold> <amount> [group_id]` — add or update a group reward
- `/admin disable_reward <threshold> [group_id]`
- `/admin adjust <ID> <delta> <reason> [group_id]` — audited referral adjustment
- `/admin block <ID> <reason> [group_id]` / `/admin unblock <ID> [group_id]` — group-specific member block
- `/admin export [group_id]` — export only the selected group's membership and referrals
- `/approve <claim_id> [group_id]` / `/reject <claim_id> [reason] [group_id]`

**Group administrators** are assigned to a specific group and can use that group's statistics, member tools, reward configuration, and claim review controls. They cannot select another group's data. A group ID supplied in a command or callback is never treated as proof of authorization; the bot checks the caller's global or group-specific administrator record before proceeding.

Claim decisions, reward settings, referral adjustments, blocks, and group-admin assignments are recorded with their group ID. Reward claims are unique per member and level within a group, and the requested threshold and amount are snapshotted. Approval rechecks group membership, block status, and referral eligibility. The bot records a decision but **does not send money**.

## Referral behavior and Telegram limitations

- An account can be credited only once per group. Duplicate Telegram updates are idempotent.
- Leaving deactivates that group's referral. Rejoining does not create a second referral. Referrals and membership in other groups are unaffected.
- A referral is not credited for self-invites, bot accounts, blocked participants, or joins without a recognized personal link.
- Telegram does not let bots enumerate all group members or recover historical invitation usage. Only membership updates received while the bot has the required access can be verified; deploy before promotion begins. Missed offline events may not be reconstructable. Administrators can use audited group-specific adjustments for independently verified evidence.
- The bot tracks the invitation link used, not phone contacts or proof of a real-world relationship.

## Safe upgrade from the previous single-group version

Back up the SQLite database before deploying this version. Set `LEGACY_GROUP_ID` to the old `GROUP_ID` for the first startup if the database's group records do not identify the original group. The migration runs transactionally, converts the old administrator list into global administrators, and preserves users, referrals, claims, adjustments, audit history, and reward snapshots. If the migration cannot safely identify a group for legacy records, startup stops with an error instead of assigning the data to a guessed group.

After migration, remove the legacy group variable if desired. Administrator removals are managed with `/admin global_admin_remove` or `/admin group_admin_remove`; removing an ID from `ADMIN_IDS` does not silently erase stored global administrators.

## Render Background Worker

Use one **Background Worker** to keep Telegram long polling connected:

1. Create a Render Background Worker from this repository.
2. Set build command `npm ci` and start command `npm start`.
3. Set `BOT_TOKEN`, `ADMIN_IDS`, `DATABASE_PATH`, and optionally `LOG_LEVEL` as environment variables. Do not put credentials in the repository.
4. Attach a persistent disk mounted at `/var/data`, then set `DATABASE_PATH=/var/data/referrals.sqlite`.
5. Keep the worker at exactly one instance. The process also acquires a lock beside the database to prevent a second poller from using the same persistent path.
6. Deploy, check the worker logs for “Telegram referral bot is running,” and add/promote the bot in each group.

SQLite uses WAL mode; keep the database and its `-wal`/`-shm` sidecar files on the same persistent disk. Do not store the database in `/tmp` or another ephemeral directory. On `SIGINT` or `SIGTERM`, the bot stops polling, closes SQLite, and releases its polling lock.

## Operational notes

- Structured logs go to stdout/stderr. Notification failures (for example, an administrator who has not started the bot) are logged and do not roll back a claim.
- Back up the database using SQLite's backup tooling or a consistent filesystem snapshot; do not copy only the main file while WAL writes are active.
- `/admin stats` distinguishes Telegram's live member count from membership events recorded by this bot.
- Reward approval is manual. Administrators remain responsible for verifying and issuing payments.
