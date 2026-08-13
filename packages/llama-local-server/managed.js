'use strict';

// The lifecycle owner for the SHARED chat instance (the 'chat-shared' claim,
// port 8090). `server.js` answers "start one if it isn't up"; this module
// answers the two questions that one cannot:
//
//   1. Is the instance on that port one *we* started, and may therefore stop?
//   2. Who else still needs it?
//
// Why a separate module, and why does its state live outside the repo:
//
// `ensureRunning()`'s `owned` flag is a *per-process* contract -- true only
// for the call that spawned the child. That is right for "don't kill a server
// you merely reused", and useless for the thing actually wanted here: the
// shared server should live exactly as long as some Claude Code session
// needs it, no matter which process happened to start it. A watcher that
// reused a server started ten minutes earlier by a one-shot skill invocation
// has `owned === false` and so leaves a ~2.5 GB model resident forever. That
// is the resource leak this module closes.
//
// So ownership is recorded on disk instead of held in a variable, and the
// record lives at a MACHINE-level path rather than the usual `state/` dir
// next to the code (the one deliberate exception to that convention in the
// suite). It has to: `projects/local-inference-skill` is *installed by
// copying* into `~/.claude/skills/`, so its copy cannot resolve a
// repo-relative path, and it is one of the processes that starts this very
// server. A record only the repo can find would mean the skill's spawns stay
// unmanaged, which is exactly the case that leaks. Override with
// LLAMA_RUNTIME_DIR.
//
// The conservative half of the contract is kept: NO record means NO kill.
// A llama-server someone started by hand on 8090 is reused and left alone.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const ports = require('./ports');
const server = require('./server');

const CLAIM = 'chat-shared';

const RUNTIME_DIR = cfg.LLAMA_RUNTIME_DIR;
const RECORD_FILE = path.join(RUNTIME_DIR, 'chat-shared.json');
// Held only across the spawn itself, not for the server's lifetime.
const SPAWN_LOCK = path.join(RUNTIME_DIR, 'chat-shared.spawn.lock');

// A spawn holds the lock while llama.cpp loads the model off disk. Measured
// cold on a 3B Q4: ~4s. The ceiling is generous because the cost of being
// wrong is asymmetric -- too short means two processes spawn and one wastes a
// bind failure, too long means a crashed spawner blocks startup for this many
// ms exactly once.
const SPAWN_LOCK_STALE_MS = 60_000;

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0: existence probe, sends nothing
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function readRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
    if (!rec || typeof rec.pid !== 'number') return null;
    return rec;
  } catch {
    return null;
  }
}

function writeRecord(rec) {
  ensureRuntimeDir();
  const tmp = `${RECORD_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, RECORD_FILE);
}

function clearRecord() {
  try {
    fs.unlinkSync(RECORD_FILE);
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Spawn lock
// ---------------------------------------------------------------------------
//
// `ensureRunning()` checks isUp() and then spawns, and those two steps are not
// atomic. Two Claude Code sessions starting within the same second both see
// "nothing on 8090" and both spawn; the loser fails to bind, exits instantly,
// and its caller sits out the full 30s health poll before reporting a
// misleading "did not become healthy". The lock collapses that race to one
// spawner and one waiter.

function acquireSpawnLock() {
  ensureRuntimeDir();
  try {
    const raw = JSON.parse(fs.readFileSync(SPAWN_LOCK, 'utf8'));
    const fresh = raw.at_ms && Date.now() - raw.at_ms < SPAWN_LOCK_STALE_MS;
    if (fresh && isPidAlive(raw.pid) && raw.pid !== process.pid) return false;
  } catch {
    /* no lock, or unparseable -- take it */
  }
  fs.writeFileSync(SPAWN_LOCK, JSON.stringify({ pid: process.pid, at_ms: Date.now() }));
  return true;
}

function releaseSpawnLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(SPAWN_LOCK, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(SPAWN_LOCK);
  } catch {
    /* already released, or taken over after going stale */
  }
}

// ---------------------------------------------------------------------------
// Who actually holds the port
// ---------------------------------------------------------------------------

// Split out from pidOnPort so it can be tested against captured netstat output
// rather than against whatever happens to be listening on the test machine.
//
// Matches LISTENING rows only. A port appears many times in netstat once
// anything has connected to it -- one LISTENING row plus an ESTABLISHED row
// per client, and the ESTABLISHED rows carry the *client's* pid. Matching
// those would hand back the pid of whatever last talked to llama-server, which
// on this machine is usually the watcher itself.
function parseNetstatListener(stdout, port) {
  for (const line of String(stdout).split(/\r?\n/)) {
    // "  TCP    127.0.0.1:8090   0.0.0.0:0   LISTENING   12345"
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

// Definitive answer to "which PID is listening on this port", so a kill can
// never land on an unrelated process that happens to have inherited a recycled
// PID. Windows-only (netstat -ano); returns null anywhere it cannot tell, and
// every caller treats null as "fall back to the weaker check" rather than as
// "nothing is there".
function pidOnPort(port, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(parseNetstatListener(stdout, port));
    });
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Returns { baseUrl, port, pid, started, managed }.
//
//   started  true only when THIS call spawned the process
//   managed  true when a record exists, i.e. stopShared() is permitted to
//            stop it later. False means an instance we found but did not
//            start and must leave alone.
async function ensureShared({ startedBy = 'unknown', waitMs = 30_000, ...opts } = {}) {
  const claim = ports.get(CLAIM);
  const port = claim.port;
  const host = claim.host;
  const baseUrl = server.baseUrlFor(port, host);

  if (await server.isUp(port, host)) {
    return { baseUrl, port, pid: readRecord()?.pid ?? null, started: false, managed: !!readRecord() };
  }

  // Someone else is mid-spawn: wait for their server rather than racing it
  // into a bind failure.
  if (!acquireSpawnLock()) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await server.isUp(port, host)) {
        const rec = readRecord();
        return { baseUrl, port, pid: rec?.pid ?? null, started: false, managed: !!rec };
      }
    }
    // The other spawner failed or died holding a lock that has not gone stale
    // yet. Falling through to spawn ourselves is the better failure mode than
    // reporting "unavailable" -- worst case we lose a bind and say so.
  }

  try {
    const { proc } = await server.ensureRunning({
      ...opts,
      host,
      port,
      alias: claim.alias,
      // Must outlive whichever short-lived process happened to start it: a
      // statusline render or a one-shot skill call exits in milliseconds and
      // the whole point is that the next caller reuses this instance.
      // `detached: true` is the documented exception to preferring unref()
      // alone -- and it is verified rather than assumed, because a detached
      // child can silently fail to launch on Windows: ensureRunning() only
      // returns after /health answers.
      detached: true,
      timeoutMs: waitMs,
    });

    const pid = proc?.pid ?? (await pidOnPort(port));
    writeRecord({
      pid,
      port,
      host,
      model_path: opts.modelPath || cfg.LLAMA_MODEL_PATH,
      started_at: new Date().toISOString(),
      started_by: startedBy,
    });
    return { baseUrl, port, pid, started: true, managed: true };
  } finally {
    releaseSpawnLock();
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isPidAlive(pid);
}

function forceKill(pid) {
  return new Promise((resolve) => {
    // /PID, never /IM: there are routinely several llama-server.exe processes
    // on this machine and the others may belong to another session or another
    // repo built on this package. No /T -- llama-server has no children to reap
    // and a tree kill is how you take out a bystander.
    execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000, windowsHide: true }, () => resolve());
  });
}

// Stops the shared instance IF this suite started it.
//
// Returns { stopped, reason, pid }. Never throws: it is called from shutdown
// paths where the process is leaving anyway and an exception would only
// replace a clean exit with a stack trace.
async function stopShared({ reason = 'requested' } = {}) {
  const rec = readRecord();
  if (!rec) {
    const up = await server.isUp(ports.get(CLAIM).port);
    return {
      stopped: false,
      pid: null,
      reason: up
        ? 'an unmanaged llama-server holds the port -- this suite did not start it, so it is left running'
        : 'no managed instance recorded',
    };
  }

  const { pid, port } = rec;

  if (!isPidAlive(pid)) {
    clearRecord();
    return { stopped: false, pid, reason: 'recorded instance is already gone' };
  }

  // PID reuse is the one way an automatic shutdown could kill something
  // innocent, so confirm the recorded PID is the process actually holding the
  // port before signalling it. When netstat can't tell us (non-Windows, or it
  // failed), fall back to the weaker check -- something llama-shaped is still
  // answering on the port -- rather than either refusing to clean up or
  // killing blind.
  const holder = await pidOnPort(port);
  if (holder !== null && holder !== pid) {
    clearRecord();
    return {
      stopped: false,
      pid,
      reason: `port ${port} is held by pid ${holder}, not the recorded ${pid} (recycled pid) -- left alone`,
    };
  }
  if (holder === null && !(await server.isUp(port))) {
    clearRecord();
    return { stopped: false, pid, reason: 'nothing answering on the port' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* raced with its own exit */
  }
  if (!(await waitForExit(pid, 5000))) {
    await forceKill(pid);
    await waitForExit(pid, 3000);
  }

  clearRecord();
  return { stopped: true, pid, reason };
}

// True when a record exists and its process is still alive. Cheap; no network.
function sharedStatus() {
  const rec = readRecord();
  if (!rec) return { managed: false, pid: null, alive: false };
  return { managed: true, pid: rec.pid, alive: isPidAlive(rec.pid), record: rec };
}

module.exports = {
  CLAIM,
  RUNTIME_DIR,
  RECORD_FILE,
  ensureShared,
  stopShared,
  sharedStatus,
  readRecord,
  writeRecord,
  clearRecord,
  pidOnPort,
  parseNetstatListener,
  acquireSpawnLock,
  releaseSpawnLock,
  isPidAlive,
  SPAWN_LOCK_STALE_MS,
};
