#!/usr/bin/env node
'use strict';

// run-checks.js -- the suite-level test runner. Runs each project's own
// verification script, whatever it happens to be called. Stdlib only; see
// --help for the flags.
//
// Registry rather than glob, on purpose: the thing the runner most needs to
// know about a check -- offline logic, needs a live server, one flag away
// from a blocking popup -- is not in its filename. Discovery is used only to
// notice new check-shaped files (auditUnregistered), never to decide what is
// safe to execute. See projects/CLAUDE.md "Adding a check".
//
// Registry fields: safety 'safe' | 'unsafe' (held back unless
// --include-unsafe), needsPort N (probed first; down means SKIP, not FAIL),
// args (consent flags recorded here rather than defaulted into the script).

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const NODE = process.execPath;
const DEFAULT_TIMEOUT_MS = 60_000;

// Three-way exit contract: 0 passed, 1 failed, 3 "I cannot run here, and that
// is not a failure" with the reason on the last line of output.
const SKIP_EXIT_CODE = 3;

function lastLine(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1].trim() : '';
}

// --------------------------------------------------------------------------
// the registry
// --------------------------------------------------------------------------

const CHECKS = [
  {
    name: 'token-monitor-core',
    script: 'packages/token-monitor-core/test.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: '38 offline assertions: the rate card, transcript parsing, the statusline renderer against fixtures, and the session-naming helpers.',
    why: 'Pure logic. Fixtures go to a fresh mkdtemp dir; the renderer uses renderLine\'s test-only status override, so the live status.json is never touched. No network, no LLM, no watcher.',
  },
  {
    name: 'llama-local-server',
    script: 'packages/llama-local-server/test.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: "33 offline assertions over the start/kill decision code: netstat LISTENING-row parsing, the on-disk ownership record, stopShared's three refusals, the spawn lock, the per-claim registry (reap policies, touch throttling, claim-name path safety), and Ollama manifest resolution.",
    why: 'Redirects LLAMA_RUNTIME_DIR at a mkdtemp dir before requiring anything, so the real record file is never touched. Spawns only short-lived sleeping node processes as stand-in live pids; never starts llama-server, never makes a network call.',
  },
  {
    name: 'token-monitor-core-lifecycle',
    script: 'packages/token-monitor-core/test-lifecycle.js',
    runner: 'node',
    args: ['--take-over'],
    // Real model load off disk plus an idle countdown waited out in real time.
    timeoutMs: 300_000,
    safety: 'unsafe',
    what: 'End-to-end proof of the start/stop chain: a render starts a watcher, the watcher starts the shared llama-server and records its pid, concurrent renders start no second watcher, a second watcher is refused by the lock, and killing the last live session stops both. Isolated into a temp state dir, temp llama runtime dir, and a fake ~/.claude/sessions registry.',
    why: [
      'It asserts on the state of the SHARED port 8090, which it cannot do while sharing it.',
      '--take-over pauses autostart, stops the running watcher, takes 8090 for a minute or two, and loads a ~2 GB model onto the GPU -- so every other Claude Code session on this machine loses its status line and its local-inference server meanwhile. Autostart is restored on exit and the next render brings the watcher back, but it is a real interruption. Without --take-over it refuses to run.',
      'Run it deliberately: node run-checks.js --only lifecycle --include-unsafe',
    ].join('\n      '),
  },
  {
    name: 'cost-anomaly-alerts',
    script: 'projects/cost-anomaly-alerts/test.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: '21 offline assertions: tier math, the dedup/re-notify gate, -File quote safety, malformed status.json handling.',
    why: "Requires monitor.js as a module, which does not start the poll loop and does not call fireNotification(), so nothing here can reach notify-done.ps1. Its only side effect outside temp is mkdir'ing the project's own state/ dir.",
  },
  {
    name: 'usage-history-rollups',
    script: 'projects/usage-history-rollups/test-poller.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: '41 assertions driving poll() through every snapshot transition, including ones that would take 30 real minutes.',
    why: 'Redirects itself at a mkdtemp scratch dir via ROLLUP_STATUS_FILE / ROLLUP_STATE_DIR before requiring config, so it never touches the real history or anything under packages/. Wholly offline.',
  },
  {
    name: 'per-project-cost-attribution',
    script: 'projects/per-project-cost-attribution/verify.js',
    runner: 'node',
    // Parses every transcript in ~/.claude/projects twice, and that set only
    // grows -- a slow run here is expected, a hang is not.
    timeoutMs: 300_000,
    safety: 'safe',
    what: "Reconciles this project's parser against token-monitor-core's classifySession() over every real transcript, asserts per-cwd slices partition the session total, plus resolver spot-checks.",
    why: 'Read-only against transcripts and status.json. No network, no LLM, no writes at all.',
  },
  {
    name: 'local-inference-skill',
    script: 'projects/local-inference-skill/selftest.js',
    runner: 'node',
    needsPort: 8090,
    // ~10 real completions against a 3B model. Slow but bounded.
    timeoutMs: 240_000,
    safety: 'safe',
    what: 'Smoke test for classify/extract/summarize: input parsing, schema round-trip, exit codes, and that an unreachable server fails fast instead of eating a 30s health-check timeout.',
    why: "Makes real LLM calls, so it needs the chat server. Assertions are loose enough that a 3B model passes reliably, so a failure means broken plumbing rather than an off day. It can spawn llama-server.exe itself if 8090 is cold, but the port probe means it only ever runs against an already-up server.",
  },
  {
    name: 'ask-question-prefilter',
    script: 'projects/ask-question-prefilter/scripts/smoke-test.ps1',
    runner: 'powershell',
    needsPort: 8090,
    timeoutMs: 240_000,
    safety: 'unsafe',
    what: "Ten cases against the popup prefilter: seven -DryRun judgment calls, two forwarding cases against stub-ask-question.ps1, one fail-open case pointed at a dead port.",
    why: [
      'Two independent reasons, either one sufficient:',
      '(1) It is not a pass/fail oracle. It asserts nothing -- it prints an expectation next to each actual result for a human to eyeball, and exits 0 whatever the model said. A permanent meaningless green line is worse than not running it.',
      '(2) It drives ask-question-prefilter.ps1, the front door to a blocking WinForms popup with text-to-speech. Every case is defused today via -DryRun or the stub, but that safety lives in the arguments of ten call sites in a file this runner does not own.',
      'Run it deliberately, watching it: node run-checks.js --only ask-question --include-unsafe',
    ].join('\n      '),
  },
];

// Named so the summary can say so out loud rather than have them silently
// absent. Not counted as failures.
const UNCOVERED = [
  ['packages/token-usage-skill', 'no check; lookup.js is a pure renderer over status.json'],
  ['packages/token-monitor.nvim', 'no check (lua)'],
];

// --------------------------------------------------------------------------
// arg parsing
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { includeUnsafe: false, only: null, verbose: false, list: false, audit: true, timeout: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--include-unsafe') opts.includeUnsafe = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '-v' || a === '--verbose') opts.verbose = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--no-audit') opts.audit = false;
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else {
      console.error(`unknown argument: ${a}  (try --help)`);
      process.exit(2);
    }
  }
  return opts;
}

const HELP = `run-checks.js -- suite-level test runner

  node run-checks.js                  run everything safe to run unattended
  node run-checks.js --list           show the registry and safety notes, run nothing
  node run-checks.js --include-unsafe also run checks held back by default
  node run-checks.js --only <substr>  filter by check name
  node run-checks.js -v, --verbose    show child output even for passing checks
  node run-checks.js --no-audit       don't report unregistered check-shaped files
  node run-checks.js --timeout <ms>   override every per-check timeout

Exit code is 0 only if every selected check passed and the audit found nothing
unregistered. Skips (server down, or held back as unsafe) do not fail the run.`;

// --------------------------------------------------------------------------
// port probe
// --------------------------------------------------------------------------

// One short probe, no retry, mirroring llama-local-server's isUp(). This
// separates "the server isn't there" (skip) from "the check disagreed with
// reality" (fail); it is not meant to wait out a cold model load.
function probePort(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// --------------------------------------------------------------------------
// running one check
// --------------------------------------------------------------------------

const MAX_CAPTURE = 200_000;

// `script` is the single source of truth -- command line, working directory
// and the audit's "is this registered?" lookup are all derived from it, so
// they cannot disagree. Each check runs from its own directory: they all use
// relative require()s and relative state paths.
function buildCommand(check) {
  const file = path.basename(check.script);
  const extra = check.args || [];
  switch (check.runner) {
    case 'node':
      // process.execPath, not 'node' -- same runtime as the runner rather
      // than whatever PATH resolves to.
      return { cmd: NODE, args: [file, ...extra] };
    case 'powershell':
      // -NonInteractive so a check that unexpectedly prompts dies instead of
      // hanging until the timeout.
      return {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', file, ...extra],
      };
    default:
      throw new Error(`check "${check.name}" has unknown runner: ${check.runner}`);
  }
}

function runCheck(check, opts) {
  const cwd = path.join(ROOT, path.dirname(check.script));
  const timeoutMs = opts.timeout || check.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      const { cmd, args } = buildCommand(check);
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: 'ERROR', ms: 0, output: '', detail: `spawn failed: ${err.message}` });
      return;
    }

    let output = '';
    let truncated = false;
    const collect = (buf) => {
      const s = buf.toString();
      if (opts.verbose) process.stdout.write(s);
      if (output.length >= MAX_CAPTURE) {
        truncated = true;
        return;
      }
      output += s;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Direct child only, never a tree kill -- see projects/CLAUDE.md
      // "Adding a check".
      child.kill('SIGKILL');
    }, timeoutMs);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, ms: Date.now() - started, output: truncated ? `${output}\n... [output truncated]` : output });
    };

    child.on('error', (err) => finish({ status: 'ERROR', detail: `could not run ${check.runner}: ${err.message}` }));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish({ status: 'TIMEOUT', detail: `killed after ${timeoutMs}ms` });
      } else if (code === 0) {
        finish({ status: 'PASS', detail: '' });
      } else if (code === SKIP_EXIT_CODE) {
        finish({ status: 'SKIP', detail: lastLine(output) || 'preconditions absent' });
      } else {
        finish({ status: 'FAIL', detail: signal ? `killed by ${signal}` : `exit code ${code}` });
      }
    });
  });
}

// --------------------------------------------------------------------------
// the staleness audit -- discovery used only to notice, never to execute
// --------------------------------------------------------------------------

const CHECK_NAME_RE = /(^|[-._])(tests?|selftest|verify|smoke|checks?)([-._]|$)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'state', 'drafts', 'proposed', 'models']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (/\.(js|ps1|mjs|cjs)$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function auditUnregistered() {
  const registered = new Set(CHECKS.map((c) => c.script.replace(/\\/g, '/').toLowerCase()));
  // This runner is itself check-shaped; don't report it to itself.
  registered.add('run-checks.js');
  const found = [];
  for (const full of walk(ROOT)) {
    const base = path.basename(full).replace(/\.(js|ps1|mjs|cjs)$/i, '');
    if (!CHECK_NAME_RE.test(base)) continue;
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (registered.has(rel.toLowerCase())) continue;
    found.push(rel);
  }
  return found;
}

// --------------------------------------------------------------------------
// output
// --------------------------------------------------------------------------

const PAD = Math.max(...CHECKS.map((c) => c.name.length)) + 2;
const rule = (ch = '-') => console.log(ch.repeat(72));

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function printList() {
  console.log('\nregistered checks\n');
  for (const c of CHECKS) {
    const tags = [
      c.safety === 'unsafe' ? 'UNSAFE (skipped by default)' : 'safe',
      c.needsPort ? `needs :${c.needsPort}` : 'offline',
      `timeout ${fmtMs(c.timeoutMs || DEFAULT_TIMEOUT_MS)}`,
    ].join(' | ');
    console.log(`  ${c.name}`);
    console.log(`      ${c.script}`);
    console.log(`      ${tags}`);
    console.log(`      what: ${c.what}`);
    console.log(`      why:  ${c.why}`);
    console.log('');
  }
  console.log('projects with no check of their own\n');
  for (const [name, note] of UNCOVERED) console.log(`  ${name.padEnd(30)} ${note}`);
  console.log('');
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.list) {
    printList();
    return 0;
  }

  const selected = CHECKS.filter((c) => !opts.only || c.name.toLowerCase().includes(opts.only.toLowerCase()));
  if (selected.length === 0) {
    console.error(`--only ${opts.only} matched no checks. Known: ${CHECKS.map((c) => c.name).join(', ')}`);
    return 2;
  }

  console.log(`\nclaude-token-monitor :: suite checks    (node ${process.version})`);
  console.log(`${selected.length} registered check(s)${opts.includeUnsafe ? ', including unsafe-by-default' : ''}`);
  rule('=');

  // Probe each distinct port once up front rather than per check.
  const ports = [...new Set(selected.filter((c) => c.needsPort).map((c) => c.needsPort))];
  const portUp = new Map();
  for (const p of ports) {
    const up = await probePort(p);
    portUp.set(p, up);
    console.log(`llama server :${p}  ${up ? 'up' : 'DOWN -- dependent checks will be skipped, not failed'}`);
  }
  if (ports.length) rule('=');

  const results = [];
  for (const check of selected) {
    if (check.safety === 'unsafe' && !opts.includeUnsafe) {
      results.push({ check, status: 'SKIP', ms: 0, detail: 'unsafe by default (--include-unsafe to run)', output: '' });
      console.log(`${'SKIP'.padEnd(8)}${check.name.padEnd(PAD)} ${'-'.padStart(7)}  unsafe by default (--include-unsafe to run)`);
      continue;
    }
    if (check.needsPort && !portUp.get(check.needsPort)) {
      results.push({ check, status: 'SKIP', ms: 0, detail: `llama server :${check.needsPort} not up`, output: '' });
      console.log(`${'SKIP'.padEnd(8)}${check.name.padEnd(PAD)} ${'-'.padStart(7)}  llama server :${check.needsPort} not up`);
      continue;
    }

    // Ticker only for a real terminal -- a bare \r leaves garbage in a
    // redirected log.
    const interactive = process.stdout.isTTY && !opts.verbose;
    if (interactive) process.stdout.write(`....  ${check.name.padEnd(PAD)} running`);
    const r = await runCheck(check, opts);
    if (interactive) process.stdout.write(`\r${' '.repeat(PAD + 16)}\r`);
    console.log(`${r.status.padEnd(8)}${check.name.padEnd(PAD)} ${fmtMs(r.ms).padStart(7)}  ${r.detail}`);
    results.push({ check, ...r });
  }

  // Printed once at the end so the per-check lines stay scannable, and not at
  // all in --verbose, where it was already streamed.
  const bad = results.filter((r) => r.status === 'FAIL' || r.status === 'TIMEOUT' || r.status === 'ERROR');
  if (bad.length && !opts.verbose) {
    for (const r of bad) {
      console.log('');
      rule();
      console.log(`${r.status}: ${r.check.name}  (${r.check.script})`);
      rule();
      console.log(r.output.trim() || '(no output)');
    }
  }

  let unregistered = [];
  if (opts.audit && !opts.only) {
    unregistered = auditUnregistered();
    if (unregistered.length) {
      console.log('');
      rule();
      console.log('UNREGISTERED check-shaped scripts -- someone added a check and this');
      console.log('runner does not know whether it is safe to run unattended. Read it,');
      console.log('then add it to CHECKS in run-checks.js (or rename it if it is not a check).');
      rule();
      for (const f of unregistered) console.log(`  ${f}`);
    }
  }

  rule('=');
  const tally = (s) => results.filter((r) => r.status === s).length;
  console.log(
    `passed ${tally('PASS')}   failed ${tally('FAIL')}   timed out ${tally('TIMEOUT')}   errored ${tally('ERROR')}   skipped ${tally('SKIP')}` +
      (unregistered.length ? `   unregistered ${unregistered.length}` : '')
  );
  if (!opts.only) {
    console.log(`no check of their own: ${UNCOVERED.map(([n]) => n).join(', ')}`);
  }

  const failed = bad.length > 0 || unregistered.length > 0;
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: OK');
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('run-checks.js crashed:', err);
    process.exitCode = 2;
  }
);
