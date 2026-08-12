'use strict';

// Lifecycle ownership for llama-server instances, machine-wide.
//
// `server.js` answers "start one if it isn't up". This module answers the
// three questions it cannot:
//
//   1. Is the process on that port one *we* started, and may therefore stop?
//   2. Is anyone still using it?
//   3. Who is responsible for stopping it, given that whoever started it has
//      very likely already exited?
//
// ---------------------------------------------------------------------------
// Why ownership is a file and not a variable
// ---------------------------------------------------------------------------
//
// `ensureRunning()`'s `owned` flag is a *per-process* contract -- true only
// for the call that spawned the child. That is right for "don't kill a server
// you merely reused", and useless for what is actually needed here, because
// nearly every process that starts one of these servers is short-lived: a
// status line render lasting ~100ms, a one-shot skill invocation, a CLI
// search. The server has to outlive them all, so its lifetime cannot be owned
// by any of them.
//
// Recording ownership on disk decouples the two. A record survives the
// process that wrote it, survives an abrupt kill of that process (which on
// Windows is the only kind of external kill there is -- see the note in the
// suite CLAUDE.md), and can be read by a completely unrelated process that
// takes over responsibility for reaping.
//
// The runtime directory is MACHINE-level rather than the usual `state/` dir
// beside the code -- the one deliberate exception to that convention. It has
// to be: the processes that start these servers include an installed skill
// copied into ~/.claude/skills/ and, since the split, separate repositories.
// None of them can resolve a path relative to this checkout. Override with
// LLAMA_RUNTIME_DIR.
//
// ---------------------------------------------------------------------------
// Two reap policies, because there are two kinds of instance
// ---------------------------------------------------------------------------
//
//   'supervised'  lifetime is tied to a supervisor that is itself tied to
//                 something real -- the watcher, which exits when no Claude
//                 Code session is live. The shared chat instance on :8090.
//                 Never idle-reaped: it is deliberately kept warm for as long
//                 as anyone might type.
//
//   'idle'        reaped after `idle_ttl_ms` with no recorded use. This is for
//                 dedicated instances (a 7B summarizer, an embedding server)
//                 that a one-shot CLI stands up, uses for a minute, and walks
//                 away from. Nothing was ever going to come back and stop
//                 those, which is exactly how a 6.4 GB model ends up resident
//                 until reboot.
//
// Clients mark use with touch(). Any process may call reap(); the watcher does
// it on every tick, which makes it the de-facto reaper on a machine running
// this suite, including for instances started by other repositories.
//
// ---------------------------------------------------------------------------
// The conservative half of the contract, unchanged
// ---------------------------------------------------------------------------
//
// NO record means NO kill. A llama-server started by hand is reused and left
// alone, forever, by everything here. And before any kill, the recorded pid is
// checked against the process actually holding the port, so a recycled pid
// cannot make this shoot a bystander.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const ports = require('./ports');
const server = require('./server');

const SHARED_CLAIM = 'chat-shared';

const RUNTIME_DIR = cfg.LLAMA_RUNTIME_DIR;

// A spawn holds the lock while llama.cpp loads the model off disk. Measured
// cold: ~4s for a 3B Q4, well over a minute for a 7B on a cold file cache.
// The ceiling is generous because the cost of being wrong is asymmetric --
// too short means two processes spawn and one wastes a bind failure, too long
// means a crashed spawner blocks startup for this many ms exactly once.
const SPAWN_LOCK_STALE_MS = 180_000;

// Default idle TTL for 'idle' instances. Long enough to survive the gap
// between two searches in one sitting, short enough that a forgotten 6.4 GB
// model comes back while you are still at the desk.
const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

// touch() is called on every request by some clients, and a file write per
// embedding call would be silly. Skip the write when the record is already
// fresher than this.
const TOUCH_THROTTLE_MS = 30_000;

function recordFile(name) {
  // Claim names come from ports.js, which is source, not user input -- but a
  // name reaching the filesystem still gets constrained rather than trusted.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`unsafe claim name: ${name}`);
  return path.join(RUNTIME_DIR, `${name}.json`);
}

function spawnLockFile(name) {
  return path.join(RUNTIME_DIR, `${name}.spawn.lock`);
}

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
// Records
// ---------------------------------------------------------------------------

function readRecord(name = SHARED_CLAIM) {
  try {
    const rec = JSON.parse(fs.readFileSync(recordFile(name), 'utf8'));
    if (!rec || typeof rec.pid !== 'number') return null;
    return { claim: name, ...rec };
  } catch {
    return null;
  }
}

function writeRecord(name, rec) {
  ensureRuntimeDir();
  const file = recordFile(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ claim: name, ...rec }, null, 2));
  fs.renameSync(tmp, file);
}

function clearRecord(name = SHARED_CLAIM) {
  try {
    fs.unlinkSync(recordFile(name));
  } catch {
    /* already gone */
  }
}

// Every record currently on disk, including ones written by other repos.
function listRecords() {
  let files;
  try {
    files = fs.readdirSync(RUNTIME_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const rec = readRecord(f.slice(0, -'.json'.length));
    if (rec) out.push(rec);
  }
  return out;
}

// Marks an instance as still wanted. Throttled: the common caller is a
// per-request client, and the reaper only needs minute-resolution.
function touch(name = SHARED_CLAIM) {
  const rec = readRecord(name);
  if (!rec) return false;
  const last = Date.parse(rec.last_used_at || rec.started_at || 0) || 0;
  if (Date.now() - last < TOUCH_THROTTLE_MS) return true;
  try {
    writeRecord(name, { ...rec, last_used_at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spawn lock
// ---------------------------------------------------------------------------
//
// `isUp()`-then-spawn is not atomic. Two Claude Code sessions opened in the
// same second both see nothing on the port and both spawn; the loser fails to
// bind, exits instantly, and its caller sits out the full health-poll timeout
// before reporting a misleading "did not become healthy". The lock collapses
// that race to one spawner and one waiter.

function acquireSpawnLock(name) {
  ensureRuntimeDir();
  const file = spawnLockFile(name);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fresh = raw.at_ms && Date.now() - raw.at_ms < SPAWN_LOCK_STALE_MS;
    if (fresh && isPidAlive(raw.pid) && raw.pid !== process.pid) return false;
  } catch {
    /* no lock, or unparseable -- take it */
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at_ms: Date.now() }));
  return true;
}

function releaseSpawnLock(name) {
  try {
    const file = spawnLockFile(name);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(file);
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

// Starts the instance for a port claim if it is not already up, and records
// this suite's ownership of it.
//
// Returns { claim, baseUrl, port, pid, started, managed }.
//   started  true only when THIS call spawned the process
//   managed  true when a record exists, i.e. a reaper is permitted to stop it
//            later. False means an instance found but not started here, which
//            must be left alone.
async function ensureManaged(name, { startedBy = 'unknown', waitMs = 30_000, policy, idleTtlMs, ...opts } = {}) {
  const claim = ports.get(name);
  const port = claim.port;
  const host = opts.host || claim.host;
  const baseUrl = server.baseUrlFor(port, host);

  const reapPolicy = policy || (name === SHARED_CLAIM ? 'supervised' : 'idle');
  const ttl = idleTtlMs != null ? idleTtlMs : DEFAULT_IDLE_TTL_MS;

  if (await server.isUp(port, host)) {
    const rec = readRecord(name);
    // Someone else's server, or ours from a previous run. Either way it is up
    // and reusable; touch it so a reaper does not decide it is idle purely
    // because this caller reused rather than started it.
    if (rec) touch(name);
    return { claim: name, baseUrl, port, pid: rec?.pid ?? null, started: false, managed: !!rec };
  }

  // Someone else is mid-spawn: wait for their server rather than racing it
  // into a bind failure.
  if (!acquireSpawnLock(name)) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await server.isUp(port, host)) {
        const rec = readRecord(name);
        return { claim: name, baseUrl, port, pid: rec?.pid ?? null, started: false, managed: !!rec };
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
      alias: opts.alias || claim.alias || name,
      // Must outlive whichever short-lived process happened to start it: a
      // statusline render or a one-shot CLI exits in milliseconds and the
      // whole point is that the next caller reuses this instance.
      // `detached: true` is the documented exception to preferring unref()
      // alone -- and it is verified rather than assumed, because a detached
      // child can silently fail to launch on Windows: ensureRunning() only
      // returns after /health answers.
      detached: true,
      timeoutMs: waitMs,
    });

    const now = new Date().toISOString();
    const pid = proc?.pid ?? (await pidOnPort(port));
    writeRecord(name, {
      pid,
      port,
      host,
      model_path: opts.modelPath || (name === SHARED_CLAIM ? cfg.LLAMA_MODEL_PATH : null),
      started_at: now,
      started_by: startedBy,
      last_used_at: now,
      reap_policy: reapPolicy,
      idle_ttl_ms: reapPolicy === 'idle' ? ttl : 0,
    });
    return { claim: name, baseUrl, port, pid, started: true, managed: true };
  } finally {
    releaseSpawnLock(name);
  }
}

// The shared chat instance. Kept as a named wrapper because it is what almost
// every caller wants and because `ensureShared()` reads better at call sites
// than a magic string.
function ensureShared(opts = {}) {
  return ensureManaged(SHARED_CLAIM, { policy: 'supervised', ...opts });
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
    // repo. No /T -- llama-server has no children to reap and a tree kill is
    // how you take out a bystander.
    execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000, windowsHide: true }, () => resolve());
  });
}

// Stops an instance IF this suite recorded starting it.
//
// Returns { stopped, reason, pid, claim }. Never throws: it is called from
// shutdown paths where the process is leaving anyway and an exception would
// only replace a clean exit with a stack trace.
async function stopManaged(name, { reason = 'requested' } = {}) {
  const rec = readRecord(name);
  if (!rec) {
    let up = false;
    try {
      up = await server.isUp(ports.get(name).port);
    } catch {
      /* unknown claim -- treat as nothing to do */
    }
    return {
      claim: name,
      stopped: false,
      pid: null,
      reason: up
        ? 'an unmanaged llama-server holds the port -- this suite did not start it, so it is left running'
        : 'no managed instance recorded',
    };
  }

  const { pid, port } = rec;

  if (!isPidAlive(pid)) {
    clearRecord(name);
    return { claim: name, stopped: false, pid, reason: 'recorded instance is already gone' };
  }

  // PID reuse is the one way an automatic shutdown could kill something
  // innocent, so confirm the recorded PID is the process actually holding the
  // port before signalling it. When netstat can't tell us (non-Windows, or it
  // failed), fall back to the weaker check -- something llama-shaped is still
  // answering on the port -- rather than either refusing to clean up or
  // killing blind.
  const holder = await pidOnPort(port);
  if (holder !== null && holder !== pid) {
    clearRecord(name);
    return {
      claim: name,
      stopped: false,
      pid,
      reason: `port ${port} is held by pid ${holder}, not the recorded ${pid} (recycled pid) -- left alone`,
    };
  }
  if (holder === null && !(await server.isUp(port))) {
    clearRecord(name);
    return { claim: name, stopped: false, pid, reason: 'nothing answering on the port' };
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

  clearRecord(name);
  return { claim: name, stopped: true, pid, reason };
}

function stopShared(opts = {}) {
  return stopManaged(SHARED_CLAIM, opts);
}

// Stops every managed instance. The watcher's shutdown path: when the last
// Claude Code session goes away, nothing this suite started should survive it.
async function stopAll({ reason = 'shutdown', include = () => true } = {}) {
  const results = [];
  for (const rec of listRecords()) {
    if (!include(rec)) continue;
    results.push(await stopManaged(rec.claim, { reason }));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reap
// ---------------------------------------------------------------------------

// Stops 'idle' instances that have gone unused past their TTL, and clears
// records whose process is gone. Safe to call often and from anywhere; the
// watcher calls it every tick.
//
// 'supervised' instances are deliberately never idle-reaped -- the shared chat
// server exists to be warm, and reaping it after a quiet ten minutes would
// mean paying a model load the next time the user types.
// The decision, split out from the doing so it can be tested without a real
// server to kill. Returns { reap, idleFor, why }.
function isReapable(rec, now = Date.now()) {
  if (rec.reap_policy !== 'idle' || !rec.idle_ttl_ms) {
    return { reap: false, idleFor: null, why: 'supervised -- lifetime tied to the watcher, never idle-reaped' };
  }
  // started_at as the fallback matters: an instance spawned and then never
  // touched must still age out. Falling back to `now` would make a client that
  // forgets to touch() immortal instead of short-lived, which is the wrong way
  // round for a bug this module exists to prevent.
  const last = Date.parse(rec.last_used_at || rec.started_at || 0) || 0;
  const idleFor = now - last;
  if (idleFor < rec.idle_ttl_ms) {
    return { reap: false, idleFor, why: `used ${Math.round(idleFor / 1000)}s ago, ttl ${Math.round(rec.idle_ttl_ms / 1000)}s` };
  }
  return { reap: true, idleFor, why: `idle ${Math.round(idleFor / 1000)}s (ttl ${Math.round(rec.idle_ttl_ms / 1000)}s)` };
}

async function reap({ now = Date.now(), reason = 'idle' } = {}) {
  const acted = [];
  for (const rec of listRecords()) {
    if (!isPidAlive(rec.pid)) {
      clearRecord(rec.claim);
      acted.push({ claim: rec.claim, action: 'cleared-stale-record', pid: rec.pid });
      continue;
    }

    const verdict = isReapable(rec, now);
    if (!verdict.reap) continue;

    const result = await stopManaged(rec.claim, { reason: `${reason}: ${verdict.why}` });
    acted.push({ claim: rec.claim, action: result.stopped ? 'stopped-idle' : 'left', pid: rec.pid, detail: result.reason });
  }
  return acted;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// Is the server for this claim actually answering? One /health against
// localhost. This is the question a supervisor should ask on a loop --
// distinct from status()'s "does the recorded pid still exist", because a
// process can be alive and wedged, and because an instance may be up without
// any record of who started it.
async function isUpFor(name) {
  const claim = ports.get(name);
  return server.isUp(claim.port, claim.host);
}

// Cheap; no network. `alive` is the recorded process still existing, which is
// not quite the same as the server answering -- see isUpFor() for that.
function status(name = SHARED_CLAIM) {
  const rec = readRecord(name);
  if (!rec) return { claim: name, managed: false, pid: null, alive: false };
  return { claim: name, managed: true, pid: rec.pid, alive: isPidAlive(rec.pid), record: rec };
}

// Back-compat alias for the shared instance.
function sharedStatus() {
  return status(SHARED_CLAIM);
}

// Every managed instance, with liveness and idle age. What the CLI prints and
// what a supervisor logs.
function statusAll({ now = Date.now() } = {}) {
  return listRecords().map((rec) => {
    const last = Date.parse(rec.last_used_at || rec.started_at || 0) || 0;
    return {
      claim: rec.claim,
      pid: rec.pid,
      port: rec.port,
      alive: isPidAlive(rec.pid),
      policy: rec.reap_policy || 'supervised',
      idle_ms: last ? now - last : null,
      idle_ttl_ms: rec.idle_ttl_ms || 0,
      started_by: rec.started_by,
      record: rec,
    };
  });
}

module.exports = {
  SHARED_CLAIM,
  RUNTIME_DIR,
  DEFAULT_IDLE_TTL_MS,
  SPAWN_LOCK_STALE_MS,
  TOUCH_THROTTLE_MS,

  ensureManaged,
  ensureShared,
  stopManaged,
  stopShared,
  stopAll,
  reap,
  isReapable,
  touch,

  isUpFor,
  status,
  statusAll,
  sharedStatus,

  readRecord,
  writeRecord,
  clearRecord,
  listRecords,
  recordFile,
  acquireSpawnLock,
  releaseSpawnLock,
  pidOnPort,
  parseNetstatListener,
  isPidAlive,
};

// ---------------------------------------------------------------------------
// CLI:  node managed.js            -- what is running and who owns it
//       node managed.js --reap     -- stop anything idle past its TTL
//       node managed.js --stop-all -- stop everything this suite started
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];

    if (arg === '--stop-all') {
      const results = await stopAll({ reason: 'stopped from CLI' });
      if (!results.length) console.log('nothing managed is running');
      for (const r of results) console.log(`${r.stopped ? 'stopped' : 'left  '}  ${r.claim} (pid ${r.pid}) -- ${r.reason}`);
      return;
    }

    if (arg === '--reap') {
      const acted = await reap({ reason: 'idle, reaped from CLI' });
      if (!acted.length) console.log('nothing to reap');
      for (const a of acted) console.log(`${a.action}  ${a.claim} (pid ${a.pid})${a.detail ? ` -- ${a.detail}` : ''}`);
      return;
    }

    const rows = statusAll();
    if (!rows.length) {
      console.log('no managed llama-server instances recorded.');
      console.log(`(records live in ${RUNTIME_DIR})`);
      return;
    }
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('CLAIM', 30)}${pad('PID', 8)}${pad('PORT', 6)}${pad('ALIVE', 7)}${pad('POLICY', 12)}IDLE`);
    for (const r of rows) {
      const idle =
        r.policy === 'idle'
          ? `${Math.round((r.idle_ms ?? 0) / 1000)}s / ${Math.round(r.idle_ttl_ms / 1000)}s`
          : '(supervised)';
      console.log(`${pad(r.claim, 30)}${pad(r.pid, 8)}${pad(r.port, 6)}${pad(r.alive ? 'yes' : 'NO', 7)}${pad(r.policy, 12)}${idle}`);
    }
  })().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
