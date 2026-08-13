#!/usr/bin/env node
'use strict';

// Integration test for the start/stop chain:
//
//   status line render  ->  watcher  ->  shared llama-server
//   last session exits  ->  watcher exits  ->  llama-server stopped
//
// Held back from the default `node run-checks.js` run (registered `unsafe`)
// for two reasons, both about what it touches rather than how long it takes:
// it really does load a model onto the GPU, and it asserts on the state of
// the *shared* port 8090, so running it while another session's watcher is up
// would both disturb that session and fail here for the wrong reason. It
// refuses to run in that case rather than guessing.
//
//   node test-lifecycle.js
//
// Everything else is isolated into a temp dir: its own state dir, its own
// llama runtime dir, and a fake ~/.claude/sessions registry whose "live
// session" is a sleeping node process this test owns. That fake registry is
// the whole reason the idle path is testable at all -- the real one always
// contains the very session running the test.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CORE = __dirname;
const IDLE_MS = 6000; // long enough to observe the countdown, short enough to wait out

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-lifecycle-'));
const stateDir = path.join(tmp, 'state');
const sessionsDir = path.join(tmp, 'sessions');
const projectsDir = path.join(tmp, 'projects');
const runtimeDir = path.join(tmp, 'llama-runtime');
for (const d of [stateDir, sessionsDir, projectsDir, runtimeDir]) fs.mkdirSync(d, { recursive: true });

const env = {
  ...process.env,
  TOKEN_MONITOR_STATE_DIR: stateDir,
  CLAUDE_SESSIONS_DIR: sessionsDir,
  CLAUDE_PROJECTS_DIR: projectsDir,
  LLAMA_RUNTIME_DIR: runtimeDir,
  TOKEN_MONITOR_IDLE_SHUTDOWN_MS: String(IDLE_MS),
};

const owned = []; // processes this test started, killed on the way out

// The real state dir's pause sentinel (see lib/supervisor.js). Only touched
// under --take-over, and always removed again in cleanup -- leaving it behind
// would silently disable the user's status line.
const DISABLE_REAL = path.join(CORE, 'state', 'autostart.disabled');
// The default LLAMA_RUNTIME_DIR from llama-local-server/config.js, recomputed
// rather than required: requiring that module here would bind it to this
// process's env, and the test needs to talk about both runtime dirs.
const REAL_RECORD = path.join(os.homedir(), '.claude', 'llama-local-server', 'chat-shared.json');
let restoreAutostart = false;

// Stops a llama-server named by one of managed.js's record files, by PID and
// never by image name -- other instances may belong to other repos. Takes the record
// path explicitly because this test deals with two of them: the real one
// (during --take-over) and its own isolated one (during cleanup).
function stopRecorded(recordPath) {
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch {
    return;
  }
  if (rec && rec.pid && isPidAlive(rec.pid)) {
    spawnSync('taskkill', ['/PID', String(rec.pid), '/F'], { windowsHide: true });
  }
  try {
    fs.unlinkSync(recordPath);
  } catch {
    /* already gone */
  }
}

function cleanup() {
  if (restoreAutostart) {
    try {
      fs.unlinkSync(DISABLE_REAL);
    } catch {
      /* already removed */
    }
  }
  for (const p of owned) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  stopRecorded(path.join(runtimeDir, 'chat-shared.json'));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* windows file locks; a temp dir left behind is not a failure */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
    await sleep(300);
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function watcherPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(stateDir, 'watcher.lock'), 'utf8').trim());
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function portUp(port = 8090) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Counts LISTENING sockets on the port. The "never more than one" assertion
// has to be made against the OS, not against our own bookkeeping -- our
// bookkeeping is the thing under test.
function listenersOn(port) {
  if (process.platform !== 'win32') return null;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  return out.split(/\r?\n/).filter((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l)).length;
}

// The PID actually holding the port, per the OS -- the independent check that
// managed.js's record points at the right process rather than merely at some
// live process.
function pidFromNetstat(port) {
  if (process.platform !== 'win32') return null;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (m && Number(m[1]) === port) return Number(m[2]);
  }
  return null;
}

function renderStatusline() {
  const r = spawnSync(process.execPath, [path.join(CORE, 'statusline.js')], {
    input: JSON.stringify({ session_id: 'test-session' }),
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  return (r.stdout || '').trim();
}

// A stand-in for a live Claude Code session: the registry entry Claude Code
// writes, pointed at a real process so the watcher's liveness cross-check
// passes for the right reason.
function addFakeSession(id) {
  const proc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
  owned.push(proc);
  fs.writeFileSync(path.join(sessionsDir, `${proc.pid}.json`), JSON.stringify({ sessionId: id, pid: proc.pid }));
  return proc;
}

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([name, null]);
      console.log(`  ok    ${name}`);
    })
    .catch((err) => {
      results.push([name, err]);
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    });
}

async function main() {
  console.log(`lifecycle integration test (tmp: ${tmp})`);

  // The test needs the shared port to itself, and on any machine actually
  // using this suite there is a live watcher holding it -- started, moments
  // ago, by the very status line of the session running this test. Refuse by
  // default rather than silently killing someone's daemon; --take-over pauses
  // autostart, stops the running watcher through its own signal handler (so
  // it takes the llama-server down the documented way), and restores autostart
  // on the way out.
  const takeOver = process.argv.includes('--take-over');
  const running = watcherPidGlobal();

  if ((running || (await portUp())) && !takeOver) {
    console.error('\nA watcher and/or a llama-server on 8090 is already running.');
    console.error('This test proves that the watcher is what starts and stops that server,');
    console.error('so it needs the port to itself. Re-run with --take-over to have the test');
    console.error('pause autostart, stop the running watcher, and restore it afterwards.');
    process.exit(2);
  }

  if (takeOver) {
    fs.mkdirSync(path.join(CORE, 'state'), { recursive: true });
    fs.writeFileSync(DISABLE_REAL, `paused by test-lifecycle.js pid ${process.pid}\n`);
    restoreAutostart = true;
    if (running) {
      console.log(`  ..    pausing autostart and stopping watcher pid ${running}`);
      // /F is not optional here. Node on Windows never *receives* an external
      // SIGTERM -- process.kill from another process maps to TerminateProcess,
      // and taskkill without /F posts WM_CLOSE, which a console process with no
      // window ignores. So a watcher's SIGINT/SIGTERM handler only ever runs
      // for Ctrl+C in its own console; an external stop is always abrupt, and
      // the server it managed has to be stopped separately. That is exactly
      // why ownership is recorded on disk instead of held in a variable: the
      // record outlives the abrupt exit, and the next watcher adopts it.
      spawnSync('taskkill', ['/PID', String(running), '/F'], { windowsHide: true });
      await until('existing watcher to exit', () => !isPidAlive(running), 30_000);
    }
    stopRecorded(REAL_RECORD);
    if (await portUp()) {
      console.error('\nPort 8090 is still held by something this suite has no record of');
      console.error('starting. Find it with `netstat -ano | findstr :8090` and free it by PID.');
      process.exit(2);
    }
  }

  const session = addFakeSession('sess-1');

  await check('status line starts a watcher when none is running', async () => {
    const line = renderStatusline();
    assert.match(line, /starting watcher|waiting for watcher/, `unexpected first line: ${line}`);
    const pid = await until('watcher lock', () => watcherPid(), 20_000);
    assert.ok(pid, 'no watcher pid');
  });

  await check('watcher starts the shared llama-server', async () => {
    await until('llama-server /health', () => portUp());
    assert.strictEqual(listenersOn(8090), 1, 'expected exactly one listener on 8090');
  });

  await check('the shared instance is recorded as managed', async () => {
    // Deliberately polled rather than read once: ensureRunning() resolves the
    // instant /health answers, and the record is written just after, so the
    // previous check can pass microseconds before this file exists.
    const recPath = path.join(runtimeDir, 'chat-shared.json');
    await until('managed record', () => fs.existsSync(recPath), 15_000);
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
    assert.ok(rec.pid && isPidAlive(rec.pid), 'record does not point at a live pid');
    assert.strictEqual(rec.port, 8090);
    assert.strictEqual(rec.pid, pidFromNetstat(8090), 'record pid is not the process holding the port');
  });

  await check('concurrent renders never start a second watcher', async () => {
    const before = watcherPid();
    await Promise.all(Array.from({ length: 12 }, async () => renderStatusline()));
    assert.strictEqual(watcherPid(), before, 'watcher pid changed under concurrent renders');
    assert.strictEqual(listenersOn(8090), 1, 'a second llama-server appeared');
  });

  await check('a second watcher refuses to start while one holds the lock', async () => {
    const r = spawnSync(process.execPath, [path.join(CORE, 'watcher.js')], {
      encoding: 'utf8',
      env,
      timeout: 20_000,
      windowsHide: true,
    });
    assert.strictEqual(r.status, 1, 'second watcher did not exit 1');
    assert.match(r.stderr || '', /already running/i);
    assert.strictEqual(listenersOn(8090), 1, 'the refused watcher disturbed the server');
  });

  await check('watcher exits and stops llama-server once no session is live', async () => {
    const pid = watcherPid();
    session.kill(); // the registry entry now points at a dead pid
    await until('watcher exit', () => !isPidAlive(pid), IDLE_MS + 40_000);
    await until('llama-server stopped', async () => !(await portUp()), 20_000);
    assert.strictEqual(listenersOn(8090), 0, 'something is still listening on 8090');
  });

  await check('the record is cleared after shutdown', () => {
    assert.ok(!fs.existsSync(path.join(runtimeDir, 'chat-shared.json')), 'stale record left behind');
  });

  const failed = results.filter(([, e]) => e);
  console.log(`\ntoken-monitor-core lifecycle: ${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

// The real state dir, not the test one -- used only for the "is a real watcher
// running" pre-flight.
function watcherPidGlobal() {
  try {
    const pid = Number(fs.readFileSync(path.join(CORE, 'state', 'watcher.lock'), 'utf8').trim());
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

main()
  .catch((err) => {
    console.error(`lifecycle test crashed: ${err.stack}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
