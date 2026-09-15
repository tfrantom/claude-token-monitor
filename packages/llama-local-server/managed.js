'use strict';

// Machine-wide lifecycle ownership. Every refusal below is deliberate -- see
// CLAUDE.md "For the shared instance, use managed.js".

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./config');
const ports = require('./ports');
const server = require('./server');

const SHARED_CLAIM = 'chat-shared';

const RUNTIME_DIR = cfg.LLAMA_RUNTIME_DIR;

const SPAWN_LOCK_STALE_MS = 180_000;

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000;

const TOUCH_THROTTLE_MS = 30_000;

function recordFile(name) {
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
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The on-disk claim that this suite started a server, and how it may be
 * stopped. Ownership lives here rather than in a variable because the process
 * that starts a server is usually short-lived and cannot outlive it -- see
 * CLAUDE.md "Ownership is on disk, not in a variable".
 *
 * @typedef {object} OwnershipRecord
 * @property {string} claim Port-claim name; also the record's filename.
 * @property {number|null} pid
 * @property {number} port
 * @property {string} host
 * @property {string|null} model_path
 * @property {string} started_at ISO 8601.
 * @property {string} started_by Free text, for a human deciding whether to kill it.
 * @property {string} last_used_at ISO 8601; moved forward by `touch`.
 * @property {'supervised'|'idle'} reap_policy `supervised` is never idle-reaped
 *   and dies with its owner; `idle` is reaped after `idle_ttl_ms` untouched.
 * @property {number} idle_ttl_ms 0 for `supervised`.
 */

/**
 * @param {string} [name]
 * @returns {OwnershipRecord|null} null means **no record**, which is the signal
 *   never to kill anything: a server this suite did not start is left alone.
 */
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
  } catch {}
}

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

/**
 * Moves `last_used_at` forward, deferring an idle reap.
 *
 * @param {string} [name]
 * @returns {boolean} False when there is no record to touch.
 */
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

function acquireSpawnLock(name) {
  ensureRuntimeDir();
  const file = spawnLockFile(name);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const fresh = raw.at_ms && Date.now() - raw.at_ms < SPAWN_LOCK_STALE_MS;
    if (fresh && isPidAlive(raw.pid) && raw.pid !== process.pid) return false;
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at_ms: Date.now() }));
  return true;
}

function releaseSpawnLock(name) {
  try {
    const file = spawnLockFile(name);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(file);
  } catch {}
}

// LISTENING rows only: an ESTABLISHED row carries the *client's* pid, usually
// the watcher's.
function parseNetstatListener(stdout, port) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

// Windows-only. null means "cannot tell", never "nothing is there"; callers
// fall back to the weaker check.
/**
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<number|null>} The pid of the LISTENING socket's owner, or
 *   null for "cannot tell" — never treat null as "nobody", since callers use
 *   this to avoid killing a bystander that inherited a recycled pid.
 */
function pidOnPort(port, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(parseNetstatListener(stdout, port));
    });
  });
}

// -> { claim, baseUrl, port, pid, started, managed }
/**
 * @typedef {object} EnsureResult
 * @property {string} claim
 * @property {string} baseUrl
 * @property {number} port
 * @property {number|null} pid
 * @property {boolean} started False when an instance was already answering,
 *   including one this suite did not start.
 * @property {boolean} managed A record exists, so a reaper may stop it later.
 *   False means it is someone else's and will be left alone forever.
 */

/**
 * Starts the named server if nothing is answering on its port, and records
 * ownership if it does start one.
 *
 * Concurrent callers are serialised by a spawn lock: two sessions opening at
 * once both see an empty port, and without it both spawn a resident copy of the
 * model. The loser waits rather than failing to bind.
 *
 * @param {string} name A registered port claim.
 * @param {object} [options]
 * @param {string} [options.startedBy] Recorded verbatim, for whoever later has
 *   to decide whether killing it is safe.
 * @param {number} [options.waitMs] How long to wait for another spawner.
 * @param {'supervised'|'idle'} [options.policy] Defaults to `supervised` for
 *   the shared claim and `idle` for everything else.
 * @param {number} [options.idleTtlMs] Ignored under `supervised`.
 * @returns {Promise<EnsureResult>}
 */
async function ensureManaged(name, { startedBy = 'unknown', waitMs = 30_000, policy, idleTtlMs, ...opts } = {}) {
  const claim = ports.get(name);
  const port = claim.port;
  const host = opts.host || claim.host;
  const baseUrl = server.baseUrlFor(port, host);

  const reapPolicy = policy || (name === SHARED_CLAIM ? 'supervised' : 'idle');
  const ttl = idleTtlMs != null ? idleTtlMs : DEFAULT_IDLE_TTL_MS;

  if (await server.isUp(port, host)) {
    const rec = readRecord(name);
    if (rec) touch(name);
    return { claim: name, baseUrl, port, pid: rec?.pid ?? null, started: false, managed: !!rec };
  }

  if (!acquireSpawnLock(name)) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      if (await server.isUp(port, host)) {
        const rec = readRecord(name);
        return { claim: name, baseUrl, port, pid: rec?.pid ?? null, started: false, managed: !!rec };
      }
    }
    // Falls through on purpose: the other spawner died holding a lock that has
    // not gone stale yet, and losing a bind is the better failure mode.
  }

  try {
    const { proc } = await server.ensureRunning({
      ...opts,
      host,
      port,
      alias: opts.alias || claim.alias || name,
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

function ensureShared(opts = {}) {
  return ensureManaged(SHARED_CLAIM, { policy: 'supervised', ...opts });
}

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
    // /PID, never /IM, and never /T: the other llama-server.exe processes may
    // belong to another session or repo.
    execFile('taskkill', ['/PID', String(pid), '/F'], { timeout: 5000, windowsHide: true }, () => resolve());
  });
}

/**
 * Stops an instance IF this suite recorded starting it. Never throws: it is
 * called from shutdown paths.
 *
 * @param {string} name
 * @param {{reason?: string}} [options]
 * @returns {Promise<{claim: string, stopped: boolean, pid: number|null, reason: string}>}
 *   `stopped: false` is a normal outcome, not a failure — no record, an
 *   already-dead pid, or a port held by someone else all land here, and
 *   `reason` says which. Nothing is killed without confirming the recorded pid
 *   still holds the port.
 */
async function stopManaged(name, { reason = 'requested' } = {}) {
  const rec = readRecord(name);
  if (!rec) {
    let up = false;
    try {
      up = await server.isUp(ports.get(name).port);
    } catch {}
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

  // PID reuse is the one way this could kill a bystander, so confirm the
  // recorded pid holds the port. A null from netstat means "cannot tell", so
  // fall back to the weaker check rather than killing blind.
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
  } catch {}
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

async function stopAll({ reason = 'shutdown', include = () => true } = {}) {
  const results = [];
  for (const rec of listRecords()) {
    if (!include(rec)) continue;
    results.push(await stopManaged(rec.claim, { reason }));
  }
  return results;
}

/**
 * @param {OwnershipRecord} rec
 * @param {number} [now]
 * @returns {{reap: boolean, idleFor: number|null, why: string}} `why` is
 *   reported to the operator, so it explains a refusal as well as a decision.
 *   Idle is measured from `last_used_at` falling back to `started_at`, never
 *   from now — a client that forgets to touch must not be immortal.
 */
function isReapable(rec, now = Date.now()) {
  if (rec.reap_policy !== 'idle' || !rec.idle_ttl_ms) {
    return { reap: false, idleFor: null, why: 'supervised -- lifetime tied to the watcher, never idle-reaped' };
  }
  // started_at as the fallback, not `now`: a client that forgets to touch()
  // must still age out.
  const last = Date.parse(rec.last_used_at || rec.started_at || 0) || 0;
  const idleFor = now - last;
  if (idleFor < rec.idle_ttl_ms) {
    return { reap: false, idleFor, why: `used ${Math.round(idleFor / 1000)}s ago, ttl ${Math.round(rec.idle_ttl_ms / 1000)}s` };
  }
  return { reap: true, idleFor, why: `idle ${Math.round(idleFor / 1000)}s (ttl ${Math.round(rec.idle_ttl_ms / 1000)}s)` };
}

/**
 * Stops every `idle` instance past its TTL, and clears records whose process is
 * already gone.
 *
 * @param {{now?: number, reason?: string}} [options]
 * @returns {Promise<Array<object>>} What was acted on; empty is the common case.
 */
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

// Whether the server is answering, as opposed to status()'s "the recorded pid
// still exists".
async function isUpFor(name) {
  const claim = ports.get(name);
  return server.isUp(claim.port, claim.host);
}

function status(name = SHARED_CLAIM) {
  const rec = readRecord(name);
  if (!rec) return { claim: name, managed: false, pid: null, alive: false };
  return { claim: name, managed: true, pid: rec.pid, alive: isPidAlive(rec.pid), record: rec };
}

function sharedStatus() {
  return status(SHARED_CLAIM);
}

/**
 * @param {{now?: number}} [options]
 * @returns {Array<{claim: string, pid: number|null, port: number, alive: boolean, policy: string, idle_ms: number|null, idle_ttl_ms: number, started_by: string, record: OwnershipRecord}>}
 *   One row per record, not per listening port: a server nobody recorded does
 *   not appear here, which is what keeps it safe from every automatic path.
 */
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
