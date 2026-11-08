# Telegram Referral Rewards Bot

A Node.js/Telegraf bot that tracks invitation-link referrals in one Telegram group, shows referral rewards and leaderboards, and routes reward claims to administrators for manual review. Referral records, claim decisions, and admin actions persist in SQLite.

## Requirements

- Node.js 22 or newer
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- One Telegram group and its numeric chat ID (usually starts with `-100`)
- One or more Telegram administrator user IDs

## Local setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and set:

   - `BOT_TOKEN`: secret token from BotFather. Never commit or share it.
   - `GROUP_ID`: numeric ID of the group to track.
   - `ADMIN_IDS`: comma-separated Telegram user IDs allowed to administer the bot.
   - `DATABASE_PATH`: SQLite file path. The parent directory is created automatically.
   - `LOG_LEVEL`: optional `error`, `warn`, `info` (default), or `debug`.

3. Start the bot:

   ```sh
   npm start
   ```

   Run tests with `npm test`.

The database creates the default levels (50/1,000 ETB, 100/3,000 ETB, 200/5,000 ETB, and 400/10,000 ETB) on first startup. Later startups preserve database configuration.

## Add the bot to the group

1. Add the bot to the target group.
2. Promote it to an administrator and allow **Invite users via link**. The bot needs administrator access to create invite links and receive `chat_member` updates. It does not need permission to restrict or ban members.
3. Ensure `GROUP_ID` matches that group.
4. Have each configured administrator open a private chat with the bot and send `/start`. Telegram does not allow the bot to initiate private messages before the user has started it; otherwise admin claim notifications cannot be delivered.
5. Members start a private chat with the bot, then use `/invite`. They must already belong to the configured group.
6. To identify a group ID, temporarily add a trusted update-inspection bot or inspect an update delivered to your own bot. Do not publish group or bot credentials.

## Member commands

- `/start` — open the bot menu
- `/invite` — create or show your personal group invite link
- `/profile` — active referral count and next reward progress
- `/rewards` — configured reward levels
- `/leaderboard` — top 10 eligible inviters
- `/claim` — submit an eligible reward claim
- `/help` — usage and referral rules

The inline menu provides the same features, including **📊 How many users have I added?**.

## Administrator commands

Only IDs listed in `ADMIN_IDS` can use these commands or the admin claim buttons. Admin commands are restricted to a private chat so user data and claim decisions are not exposed in the group.

- `/admin` — command list
- `/admin stats` — live Telegram member count plus bot-tracked totals
- `/admin users [page]` — registered users, 20 per page
- `/admin search <ID|username>` or `/admin user <ID|username>` — search and referral details
- `/admin top` — top 10 inviters
- `/admin claims` — pending claims with approve/reject buttons
- `/approve <claim_id>` — approve a claim
- `/reject <claim_id> [reason]` — reject a claim and optionally notify the member with a reason
- `/admin reward <threshold> <amount>` — add or update an active level
- `/admin disable_reward <threshold>` — disable a level
- `/admin adjust <ID> <delta> <reason>` — manually adjust displayed referral count; adjustment and reason are audited
- `/admin block <ID> <reason>` / `/admin unblock <ID>` — block or unblock a member
- `/admin export` — export registered referral statistics as CSV

Claims are unique per member and reward level. The requested threshold and amount are snapshotted. An administrator can approve only if the member is not blocked and still meets the threshold. Approving a claim records a decision; **the bot never sends money**.

## Referral eligibility and Telegram limitations

- A referral is created only from a recognized, unrevoked personal invite link, for a non-bot invitee, when inviter and invitee differ and neither is blocked.
- A Telegram account can only be referred once per group. Duplicate updates are idempotent.
- When a tracked invitee leaves or is removed, their referral is deactivated and no longer counts. Rejoining does not create a second referral.
- Members joining without a recognized personal link are tracked as group members but do not earn a referral.
- The bot tracks membership events it receives after it is made an administrator. Telegram Bot API does **not** provide a method to enumerate all current group members or their historical join/link use. Therefore it cannot establish a complete pre-installation membership baseline; deploy before promotion begins and do not treat historical joins as verifiable referrals. Any event missed while the bot is offline may likewise be impossible to reconstruct. Admins can use audited count adjustments when they have independently verified evidence.
- The bot cannot access members' phone contacts. A referral link records the link used, not a contact list or proof of a real-world relationship.

## Render deployment

Use a **Background Worker** so Telegram long polling remains connected:

1. Push this project to a private Git repository and create a Render Background Worker from it.
2. Set the build command to `npm ci` and the start command to `npm start`.
3. Configure `BOT_TOKEN`, `GROUP_ID`, and `ADMIN_IDS` as Render environment variables (do not put the token in source control).
4. Attach a persistent disk to the worker, mounted at `/var/data`.
5. Set `DATABASE_PATH` to `/var/data/referrals.sqlite`.
6. Deploy, check the worker logs for “Telegram referral bot is running,” then add/promote the bot as described above.

The SQLite database uses WAL mode; keep the database and its `-wal`/`-shm` sidecar files on the same persistent disk. Do not run multiple worker instances against this SQLite file. The database survives restarts and deploys only when it is stored on the attached persistent disk.

## Operational notes

- The bot uses long polling; do not configure a competing webhook for the same bot token.
- Back up the SQLite database from a consistent copy or use SQLite's backup tooling; avoid copying only the main file while WAL writes are active.
- `/admin stats` distinguishes Telegram's live member count from membership events recorded by this bot.
- Structured logs go to stdout/stderr. Delivery failures to admins who have not started the bot are logged and do not roll back a claim.
