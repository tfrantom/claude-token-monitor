'use strict';

// Never starts a llama-server, and the already-running path must stay two
// syscalls -- see CLAUDE.md "The status line starts the watcher".

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../config');

const LOCK_FILE = path.join(cfg.STATE_DIR, 'watcher.lock');
const STAMP_FILE = path.join(cfg.STATE_DIR, 'watcher-spawn.json');
const WATCHER_JS = path.join(__dirname, '..', 'watcher.js');

// A file, not an env var: Claude Code spawns the status line itself, so there
// is nowhere for a user to set one.
const DISABLE_FILE = path.join(cfg.STATE_DIR, 'autostart.disabled');

const MAX_CONSECUTIVE_FAILURES = 3;

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watcherPid() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeStamp(stamp) {
  try {
    fs.mkdirSync(cfg.STATE_DIR, { recursive: true });
    fs.writeFileSync(STAMP_FILE, JSON.stringify(stamp));
  } catch {}
}

// A detached child can silently fail to launch on Windows, so a pid here is
// never taken as proof: the next render checks the lock instead.
function spawnWatcher() {
  const child = spawn(process.execPath, [WATCHER_JS], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(WATCHER_JS),
  });
  child.on('error', () => {});
  child.unref();
  return child.pid || null;
}

// -> 'running' | 'starting' | 'cooldown' | 'failed' | 'disabled'
// Never throws: a status line that crashes prints a stack trace ten times a
// second.
function ensureWatcher() {
  try {
    if (watcherPid()) {
      const stamp = readStamp();
      if (stamp.failures) writeStamp({});
      return 'running';
    }

    if (!cfg.AUTOSTART_WATCHER || fs.existsSync(DISABLE_FILE)) return 'disabled';

    const stamp = readStamp();
    const since = Date.now() - (stamp.at_ms || 0);

    if (since < cfg.WATCHER_SPAWN_COOLDOWN_MS) {
      return (stamp.failures || 0) >= MAX_CONSECUTIVE_FAILURES ? 'failed' : 'starting';
    }

    // Cooldown expired with no lock means the previous attempt failed; count
    // it before retrying, or a broken install never converges on 'failed'.
    const failures = (stamp.at_ms ? stamp.failures || 0 : 0) + (stamp.at_ms ? 1 : 0);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      writeStamp({ at_ms: Date.now(), failures });
      return 'failed';
    }

    writeStamp({ at_ms: Date.now(), failures });
    spawnWatcher();
    return 'starting';
  } catch {
    return 'failed';
  }
}

module.exports = {
  ensureWatcher,
  watcherPid,
  LOCK_FILE,
  STAMP_FILE,
  DISABLE_FILE,
  MAX_CONSECUTIVE_FAILURES,
};
