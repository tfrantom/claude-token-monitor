#!/usr/bin/env node
'use strict';

// Integration test for the start/stop chain. Registered `unsafe` in
// run-checks.js: it needs the shared port 8090 to itself and loads a model
// onto the GPU. See CLAUDE.md "The lifecycle test".
//
//   node test-lifecycle.js [--take-over]

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CORE = __dirname;
const IDLE_MS = 6000;

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

const owned = [];

// Cleanup must always remove this again -- left behind, it silently disables
// the user's status line.
const DISABLE_REAL = path.join(CORE, 'state', 'autostart.disabled');
// Recomputed rather than required: requiring that config would bind it to this
// process's env, and the test needs both runtime dirs.
const REAL_RECORD = path.join(os.homedir(), '.claude', 'llama-local-server', 'chat-shared.json');
let restoreAutostart = false;

// By PID, never by image name -- other instances may belong to other repos.
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
  } catch {}
}

function cleanup() {
  if (restoreAutostart) {
    try {
      fs.unlinkSync(DISABLE_REAL);
    } catch {}
  }
  for (const p of owned) {
    try {
      p.kill();
    } catch {}
  }
  stopRecorded(path.join(runtimeDir, 'chat-shared.json'));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
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

// Against the OS, never our own bookkeeping -- the bookkeeping is what is
// under test.
function listenersOn(port) {
  if (process.platform !== 'win32') return null;
  const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  return out.split(/\r?\n/).filter((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l)).length;
}

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

// Pointed at a real process, so the watcher's liveness cross-check passes for
// the right reason.
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
      // /F is not optional, and the stopRecorded() below is not redundant --
      // see the suite CLAUDE.md "An external kill on Windows is always
      // abrupt".
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
    // Polled, not read once: the record is written just after /health starts
    // answering.
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

  await check('the watcher restarts the server if it dies underneath it', async () => {
    // Guards the ensure-every-tick rule -- see CLAUDE.md.
    const before = pidFromNetstat(8090);
    assert.ok(before, 'no server to kill');
    spawnSync('taskkill', ['/PID', String(before), '/F'], { windowsHide: true });
    await until('server to go down', async () => !(await portUp()), 15_000);

    await until('watcher to restart it', () => portUp(), 90_000);
    const after = pidFromNetstat(8090);
    assert.ok(after && after !== before, `expected a new pid, got ${after} (was ${before})`);
    assert.strictEqual(listenersOn(8090), 1, 'restart produced more than one listener');

    await until('record to name the new pid', () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runtimeDir, 'chat-shared.json'), 'utf8')).pid === after;
      } catch {
        return false;
      }
    }, 20_000);
  });

  await check('an idle dedicated instance is reaped, a supervised one is not', async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    owned.push(sleeper);
    const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(runtimeDir, 'test-idle-instance.json'),
      JSON.stringify({
        claim: 'test-idle-instance',
        pid: sleeper.pid,
        port: 8099,
        reap_policy: 'idle',
        idle_ttl_ms: 1000,
        started_at: stale,
        last_used_at: stale,
      })
    );

    await until(
      'idle record to be dealt with',
      () => !fs.existsSync(path.join(runtimeDir, 'test-idle-instance.json')),
      30_000
    );
    assert.ok(isPidAlive(sleeper.pid), 'reaper killed a process that did not hold the port');
    assert.ok(await portUp(), 'reaper took down the supervised shared instance');
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
    session.kill();
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

// The real state dir, not the test one.
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
