const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function acquirePollingLock(databasePath) {
  if (databasePath === ':memory:') {
    throw new Error('Telegram polling requires a persistent database path.');
  }
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const lockPath = `${databasePath}.polling.lock`;
  const owner = {
    pid: process.pid,
    hostname: os.hostname(),
    token: crypto.randomUUID(),
    startedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
      fs.closeSync(descriptor);
      descriptor = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (current.token === owner.token) fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      const created = descriptor !== undefined;
      if (created) fs.closeSync(descriptor);
      if (error.code !== 'EEXIST') {
        if (created) {
          try {
            fs.unlinkSync(lockPath);
          } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
        }
        throw error;
      }
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw new Error(`Polling lock exists but cannot be read safely: ${readError.message}`);
      }
      if (existing.hostname !== os.hostname()) {
        throw new Error(`Telegram polling lock is held by another host (${existing.hostname}).`);
      }
      if (processExists(existing.pid)) {
        throw new Error(`Telegram polling is already running with process ${existing.pid}.`);
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  throw new Error('Could not acquire the Telegram polling lock.');
}

module.exports = { acquirePollingLock };
