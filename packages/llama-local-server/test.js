#!/usr/bin/env node
'use strict';

// Offline checks for the parts of this package that decide whether to start or
// kill a process. Nothing here spawns llama-server, makes a network call, or
// reads the machine's real runtime dir -- LLAMA_RUNTIME_DIR is redirected at a
// mkdtemp dir before anything is required.
//
// The end-to-end proof that the chain actually starts and stops a real server
// lives in ../token-monitor-core/test-lifecycle.js, which needs a GPU and the
// shared port and is held back from the default run for that reason. This file
// is the half that can run anywhere, every time.
//
//   node test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-managed-'));
process.env.LLAMA_RUNTIME_DIR = path.join(tmp, 'runtime');

const managed = require('./managed');
const cfg = require('./config');
const ports = require('./ports');

const sleepers = [];
function liveForeignPid() {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  sleepers.push(p);
  return p.pid;
}

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push([name, err]);
  }
}

// ---------------------------------------------------------------------------
// netstat parsing -- the check that stops a kill landing on the wrong process
// ---------------------------------------------------------------------------

// Captured from a real `netstat -ano -p tcp` while the suite was running: one
// LISTENING row for the server and ESTABLISHED rows for its clients.
const NETSTAT = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1256',
  '  TCP    127.0.0.1:8090         0.0.0.0:0              LISTENING       14568',
  '  TCP    127.0.0.1:8090         127.0.0.1:52233        ESTABLISHED     22952',
  '  TCP    127.0.0.1:52233        127.0.0.1:8090         ESTABLISHED     22952',
  '  TCP    127.0.0.1:8091         0.0.0.0:0              LISTENING       9001',
  '',
].join('\r\n');

check('parses the LISTENING pid for a port', () => {
  assert.strictEqual(managed.parseNetstatListener(NETSTAT, 8090), 14568);
});

check('ignores ESTABLISHED rows, which carry the client pid', () => {
  // 22952 is the watcher talking to the server. Returning it here would mean
  // an idle shutdown killing the watcher instead of llama-server.
  assert.notStrictEqual(managed.parseNetstatListener(NETSTAT, 8090), 22952);
});

check('does not confuse one port for another', () => {
  assert.strictEqual(managed.parseNetstatListener(NETSTAT, 8091), 9001);
  assert.strictEqual(managed.parseNetstatListener(NETSTAT, 8092), null);
});

check('a port that only appears as a substring does not match', () => {
  // :809 must not match the :8090 row.
  assert.strictEqual(managed.parseNetstatListener(NETSTAT, 809), null);
});

check('returns null on garbage rather than throwing', () => {
  assert.strictEqual(managed.parseNetstatListener('', 8090), null);
  assert.strictEqual(managed.parseNetstatListener('not netstat output', 8090), null);
});

// ---------------------------------------------------------------------------
// the ownership record
// ---------------------------------------------------------------------------

check('record round-trips and clears', () => {
  assert.strictEqual(managed.readRecord(), null, 'expected no record in a fresh runtime dir');
  managed.writeRecord('chat-shared', { pid: 4321, port: 8090, started_by: 'test' });
  assert.strictEqual(managed.readRecord().pid, 4321);
  managed.clearRecord();
  assert.strictEqual(managed.readRecord(), null);
});

check('a record without a numeric pid is treated as absent', () => {
  const rf = managed.recordFile('chat-shared');
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, JSON.stringify({ port: 8090 }));
  assert.strictEqual(managed.readRecord(), null);
  fs.writeFileSync(rf, '{ truncated');
  assert.strictEqual(managed.readRecord(), null);
  managed.clearRecord();
});

check('sharedStatus reports a dead recorded pid as not alive', () => {
  // A pid that has certainly exited: spawn one and wait for it.
  managed.writeRecord('chat-shared', { pid: 999_999, port: 8090 });
  const st = managed.sharedStatus();
  assert.strictEqual(st.managed, true);
  assert.strictEqual(st.alive, false);
  managed.clearRecord();
});

// ---------------------------------------------------------------------------
// stopShared's refusals -- the safety half
// ---------------------------------------------------------------------------

async function asyncChecks() {
  await checkAsync('stopShared does nothing when there is no record', async () => {
    managed.clearRecord();
    const r = await managed.stopShared({ reason: 'test' });
    assert.strictEqual(r.stopped, false);
    // Either message is correct depending on whether this machine happens to
    // have a server up right now; both mean "did not kill anything".
    assert.match(r.reason, /no managed instance recorded|unmanaged llama-server/);
  });

  await checkAsync('stopShared clears a record whose process is already gone', async () => {
    managed.writeRecord('chat-shared', { pid: 999_999, port: 8090 });
    const r = await managed.stopShared({ reason: 'test' });
    assert.strictEqual(r.stopped, false);
    assert.match(r.reason, /already gone/);
    assert.strictEqual(managed.readRecord(), null, 'stale record should be cleared');
  });

  await checkAsync('stopShared refuses to kill a live pid that does not hold the port', async () => {
    // The recycled-pid case: the record names a process that is alive but is
    // emphatically not llama-server. Killing it is the one genuinely
    // destructive mistake this module could make.
    const foreign = liveForeignPid();
    managed.writeRecord('chat-shared', { pid: foreign, port: 8090 });
    const r = await managed.stopShared({ reason: 'test' });
    assert.strictEqual(r.stopped, false, `stopShared reported killing pid ${foreign}`);
    assert.ok(managed.isPidAlive(foreign), 'stopShared killed an unrelated live process');
    managed.clearRecord();
  });
}

// ---------------------------------------------------------------------------
// the spawn lock
// ---------------------------------------------------------------------------

check('the spawn lock is re-entrant for the holder', () => {
  assert.strictEqual(managed.acquireSpawnLock('chat-shared'), true);
  assert.strictEqual(managed.acquireSpawnLock('chat-shared'), true, 'a process should not deadlock against its own lock');
  managed.releaseSpawnLock('chat-shared');
});

check('a lock held by another live process is not granted', () => {
  const other = liveForeignPid();
  fs.writeFileSync(
    path.join(cfg.LLAMA_RUNTIME_DIR, 'chat-shared.spawn.lock'),
    JSON.stringify({ pid: other, at_ms: Date.now() })
  );
  assert.strictEqual(managed.acquireSpawnLock('chat-shared'), false);
});

check('a stale lock is taken over', () => {
  const other = liveForeignPid();
  fs.writeFileSync(
    path.join(cfg.LLAMA_RUNTIME_DIR, 'chat-shared.spawn.lock'),
    // Live pid, but older than the staleness ceiling: a spawner that hung.
    JSON.stringify({ pid: other, at_ms: Date.now() - managed.SPAWN_LOCK_STALE_MS - 1000 })
  );
  assert.strictEqual(managed.acquireSpawnLock('chat-shared'), true);
  managed.releaseSpawnLock('chat-shared');
});

check('releasing a lock held by someone else is a no-op', () => {
  const other = liveForeignPid();
  const lockPath = path.join(cfg.LLAMA_RUNTIME_DIR, 'chat-shared.spawn.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: other, at_ms: Date.now() }));
  managed.releaseSpawnLock('chat-shared');
  assert.ok(fs.existsSync(lockPath), 'released a lock belonging to another process');
  fs.unlinkSync(lockPath);
});

// ---------------------------------------------------------------------------
// the generalized registry: many instances, two reap policies
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;

function idleRec(overrides = {}) {
  return {
    pid: 4242,
    port: 8099,
    reap_policy: 'idle',
    idle_ttl_ms: 15 * MIN,
    started_at: new Date(Date.now() - 60 * MIN).toISOString(),
    last_used_at: new Date(Date.now() - 60 * MIN).toISOString(),
    ...overrides,
  };
}

check('records are per-claim and listed together', () => {
  managed.clearRecord('chat-shared');
  managed.writeRecord('chat-shared', { pid: 1, port: 8090, reap_policy: 'supervised', idle_ttl_ms: 0 });
  managed.writeRecord('some-embed', idleRec({ pid: 2, port: 8091 }));
  const names = managed.listRecords().map((r) => r.claim).sort();
  assert.deepStrictEqual(names, ['chat-shared', 'some-embed']);
  assert.strictEqual(managed.readRecord('some-embed').port, 8091);
  managed.clearRecord('chat-shared');
  managed.clearRecord('some-embed');
});

check('a claim name cannot escape the runtime directory', () => {
  // Claim names come from ports.js, which is source rather than user input --
  // but a value that reaches the filesystem is constrained rather than
  // trusted, because the cost of being wrong here is writing outside the
  // runtime dir.
  assert.throws(() => managed.recordFile('../../evil'), /unsafe claim name/);
  assert.throws(() => managed.recordFile('a/b'), /unsafe claim name/);
  assert.throws(() => managed.recordFile(''), /unsafe claim name/);
  assert.ok(managed.recordFile('my-embedding-server').endsWith('my-embedding-server.json'));
});

check('a supervised instance is never idle-reaped, however old', () => {
  // The shared chat server exists to be warm. Reaping it after a quiet spell
  // would mean paying a model load the next time the user types a word.
  const ancient = {
    pid: 1,
    port: 8090,
    reap_policy: 'supervised',
    idle_ttl_ms: 0,
    last_used_at: new Date(Date.now() - 30 * 24 * 60 * MIN).toISOString(),
  };
  assert.strictEqual(managed.isReapable(ancient).reap, false);
});

check('an idle instance past its TTL is reapable', () => {
  const v = managed.isReapable(idleRec());
  assert.strictEqual(v.reap, true);
  assert.match(v.why, /idle \d+s/);
});

check('an idle instance inside its TTL is left alone', () => {
  const v = managed.isReapable(idleRec({ last_used_at: new Date(Date.now() - 1 * MIN).toISOString() }));
  assert.strictEqual(v.reap, false);
});

check('an instance never touched still ages out from started_at', () => {
  // The failure this guards: falling back to "now" when last_used_at is
  // absent would make a client that forgets to touch() immortal, which is
  // precisely backwards for the leak this module exists to close.
  const rec = idleRec({ last_used_at: undefined });
  assert.strictEqual(managed.isReapable(rec).reap, true);
});

check('touch refreshes last_used_at, and throttles repeat writes', () => {
  managed.writeRecord('touch-test', idleRec({ pid: process.pid }));
  assert.strictEqual(managed.touch('touch-test'), true);
  const first = managed.readRecord('touch-test').last_used_at;
  assert.ok(Date.now() - Date.parse(first) < 5000, 'touch should have written a fresh timestamp');

  // Immediately again: inside the throttle window, so the timestamp must not
  // move. A per-request client calls this constantly.
  managed.touch('touch-test');
  assert.strictEqual(managed.readRecord('touch-test').last_used_at, first);
  managed.clearRecord('touch-test');
});

check('touch on an unknown claim is a no-op, not a crash', () => {
  assert.strictEqual(managed.touch('never-recorded'), false);
});

// Sequenced rather than fired off at top level: these each write and delete
// records in a shared directory, so running them concurrently with each other
// (or with the summary) would make the suite flaky for reasons that have
// nothing to do with the code under test.
async function registryAsyncChecks() {
  await checkAsync('reap clears records whose process is gone', async () => {
    managed.writeRecord('dead-one', idleRec({ pid: 999_999 }));
    const acted = await managed.reap();
    assert.ok(
      acted.some((a) => a.claim === 'dead-one' && a.action === 'cleared-stale-record'),
      `expected dead-one to be cleared, got ${JSON.stringify(acted)}`
    );
    assert.strictEqual(managed.readRecord('dead-one'), null);
  });

  await checkAsync('reap will not kill a live pid that does not hold the port', async () => {
    // Reapable by policy, but stopManaged's port check must still veto it.
    // Both halves have to hold: the reaper picks the right candidates, and the
    // stopper refuses to act on a candidate it cannot verify.
    const foreign = liveForeignPid();
    managed.writeRecord('idle-but-foreign', idleRec({ pid: foreign, port: 8099 }));
    await managed.reap();
    assert.ok(managed.isPidAlive(foreign), 'reap killed an unrelated live process');
    managed.clearRecord('idle-but-foreign');
  });

  await checkAsync('stopAll reports on every record and leaves none behind', async () => {
    managed.writeRecord('gone-a', idleRec({ pid: 999_998 }));
    managed.writeRecord('gone-b', idleRec({ pid: 999_997 }));
    const results = await managed.stopAll({ reason: 'test' });
    const claims = results.map((r) => r.claim).sort();
    assert.ok(claims.includes('gone-a') && claims.includes('gone-b'), `got ${claims.join(',')}`);
    assert.strictEqual(managed.listRecords().length, 0, 'stopAll left records behind');
  });
}

check('statusAll reports liveness and idle age per instance', () => {
  managed.writeRecord('status-test', idleRec({ pid: process.pid, last_used_at: new Date(Date.now() - 2 * MIN).toISOString() }));
  const row = managed.statusAll().find((r) => r.claim === 'status-test');
  assert.ok(row, 'status-test missing from statusAll');
  assert.strictEqual(row.alive, true);
  assert.strictEqual(row.policy, 'idle');
  assert.ok(row.idle_ms >= 2 * MIN - 5000, `idle_ms looks wrong: ${row.idle_ms}`);
  managed.clearRecord('status-test');
});

// ---------------------------------------------------------------------------
// config resolution -- no hardcoded machine paths
// ---------------------------------------------------------------------------

check('resolveOllamaModel reads a manifest and returns the blob path', () => {
  const models = path.join(tmp, 'ollama');
  const manifestDir = path.join(models, 'manifests', 'registry.ollama.ai', 'library', 'testmodel');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.mkdirSync(path.join(models, 'blobs'), { recursive: true });
  const digest = 'sha256:abc123';
  fs.writeFileSync(path.join(models, 'blobs', 'sha256-abc123'), 'gguf');
  fs.writeFileSync(
    path.join(manifestDir, 'latest'),
    JSON.stringify({
      layers: [
        { mediaType: 'application/vnd.ollama.image.license', digest: 'sha256:deadbeef' },
        { mediaType: 'application/vnd.ollama.image.model', digest },
      ],
    })
  );
  const resolved = cfg.resolveOllamaModel('testmodel:latest', { modelsDir: models });
  assert.strictEqual(resolved, path.join(models, 'blobs', 'sha256-abc123'));
});

check('resolveOllamaModel defaults a bare reference to :latest', () => {
  const models = path.join(tmp, 'ollama');
  assert.ok(cfg.resolveOllamaModel('testmodel', { modelsDir: models }), 'bare name should resolve to the latest tag');
});

check('resolveOllamaModel returns null rather than a bogus path', () => {
  assert.strictEqual(cfg.resolveOllamaModel('nope:latest', { modelsDir: path.join(tmp, 'ollama') }), null);
  assert.strictEqual(cfg.resolveOllamaModel('testmodel:latest', { modelsDir: path.join(tmp, 'nonexistent') }), null);
});

check('a manifest with no model layer resolves to null, not to a license blob', () => {
  const models = path.join(tmp, 'ollama2');
  const manifestDir = path.join(models, 'manifests', 'registry.ollama.ai', 'library', 'broken');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'latest'),
    JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.license', digest: 'sha256:aa' }] })
  );
  assert.strictEqual(cfg.resolveOllamaModel('broken:latest', { modelsDir: models }), null);
});

check('the chat-shared claim and the resolved port agree', () => {
  // ports.js validates this on require, so reaching here already proves it --
  // asserting anyway so the reason is stated where a reader will find it.
  assert.strictEqual(ports.get('chat-shared').port, cfg.LLAMA_PORT);
});

check('the runtime dir is not inside the repo', () => {
  // It has to be machine-level so an installed skill copy can find it too;
  // if this ever regresses to a repo-relative path, those copies silently
  // stop coordinating and start leaking servers.
  const repoRoot = path.resolve(__dirname, '..', '..');
  const rel = path.relative(repoRoot, path.join(__dirname, '..', '..', 'x'));
  assert.ok(rel, 'sanity');
  const defaultDir = path.join(os.homedir(), '.claude', 'llama-local-server');
  assert.ok(
    !path.resolve(defaultDir).toLowerCase().startsWith(path.resolve(repoRoot).toLowerCase()),
    'the default runtime dir must live outside the repo'
  );
});

asyncChecks()
  .then(registryAsyncChecks)
  .then(() => {
    for (const p of sleepers) {
      try {
        p.kill();
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp dir left behind is not a failure */
    }

    if (failures.length) {
      console.log(`llama-local-server: ${passed} passed, ${failures.length} FAILED`);
      for (const [name, err] of failures) console.log(`  FAIL  ${name}\n        ${err.message}`);
      process.exitCode = 1;
    } else {
      console.log(`llama-local-server: ${passed}/${passed} checks passed`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
