'use strict';

// Starts the watcher on demand, from the status line.
//
// The suite used to require `node watcher.js` to be run by hand, in a terminal
// you then had to leave open; the installer printed the command and that was
// the whole story. Nothing in a fresh install worked until you did that, and
// nothing cleaned up after the last session closed.
//
// The status line is the right place to fix that from, because it is the one
// piece of this suite that Claude Code itself guarantees to run: it is invoked
// on every render of every session, which makes it a free liveness signal.
// So: the status line ensures the watcher, and the watcher ensures the
// llama-server (see llama-local-server/managed.js). One chain, each link
// owning exactly the thing below it. Nothing ever starts a llama-server from
// here -- doing that in a process that lives ~100ms is how you get four of
// them.
//
// The hard constraint is cost. Claude Code re-invokes statusline.js roughly
// ten times a second (measured: ~102ms median) per open session, so the happy
// path -- watcher already running -- must be effectively free. It is: one
// readFileSync of a small file and one signal-0 probe, both microseconds, no
// network and no spawn. Everything expensive is behind "the watcher is
// actually missing", which is rare by construction.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../config');

const LOCK_FILE = path.join(cfg.STATE_DIR, 'watcher.lock');
const STAMP_FILE = path.join(cfg.STATE_DIR, 'watcher-spawn.json');
const WATCHER_JS = path.join(__dirname, '..', 'watcher.js');

// A pause button that works from outside the process. TOKEN_MONITOR_NO_AUTOSTART
// cannot be used for this: Claude Code spawns the status line itself, with its
// own environment, so there is nowhere for a user to set that variable and
// have it apply. Creating this file stops autostart until it is deleted --
// which is how you run a watcher by hand in a terminal to read its logs, and
// how test-lifecycle.js gets the shared port to itself.
const DISABLE_FILE = path.join(cfg.STATE_DIR, 'autostart.disabled');

// After this many consecutive failed starts, stop trying and let the status
// line say so. A watcher that cannot start is nearly always a broken
// llama.cpp path, which retrying will not fix -- and an invisible retry loop
// spawning a doomed node process every 10s is worse than an honest message.
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

// The watcher's own PID lock, read here rather than duplicated: whatever the
// watcher considers proof that it is running is exactly what should count as
// proof that it does not need starting.
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
  } catch {
    /* the status line must render regardless */
  }
}

// Detached on purpose, and this is the case the general rule carves out: the
// watcher must outlive the ~100ms status line render that started it, so
// unref() alone will not do. A detached child can silently fail to launch on
// Windows -- no error, no 'error' event -- so this is written to be *verified*
// rather than trusted: the next render checks the lock file, and the failure
// counter below is what notices when the child never appeared.
function spawnWatcher() {
  const child = spawn(process.execPath, [WATCHER_JS], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: path.dirname(WATCHER_JS),
  });
  child.on('error', () => {
    /* recorded by the next render finding no lock; never throw into a render */
  });
  child.unref();
  return child.pid || null;
}

// Returns one of:
//   'running'   a live watcher holds the lock
//   'starting'  we just spawned one, or another render did moments ago
//   'cooldown'  missing, but too soon after the last attempt to retry
//   'failed'    too many consecutive attempts produced no live watcher
//   'disabled'  autostart turned off (TOKEN_MONITOR_NO_AUTOSTART=1)
//
// Never throws. A status line that crashes prints a stack trace ten times a
// second, so every failure here degrades to a word instead.
function ensureWatcher() {
  try {
    if (watcherPid()) {
      // Clear the failure counter only on an observed success, not on any
      // render: a run of failures should survive until a watcher genuinely
      // comes up.
      const stamp = readStamp();
      if (stamp.failures) writeStamp({});
      return 'running';
    }

    if (!cfg.AUTOSTART_WATCHER || fs.existsSync(DISABLE_FILE)) return 'disabled';

    const stamp = readStamp();
    const since = Date.now() - (stamp.at_ms || 0);

    // A spawn happened recently and no lock exists yet. Model load is not in
    // this path (the watcher writes its lock before touching llama.cpp), but
    // node startup plus the lock write is not instant either.
    if (since < cfg.WATCHER_SPAWN_COOLDOWN_MS) {
      return (stamp.failures || 0) >= MAX_CONSECUTIVE_FAILURES ? 'failed' : 'starting';
    }

    // The cooldown has expired with still no lock, so the previous attempt --
    // if there was one -- did not produce a watcher. Count it before trying
    // again, so a permanently broken install converges on 'failed' instead of
    // retrying forever.
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
