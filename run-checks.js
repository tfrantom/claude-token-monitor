#!/usr/bin/env node
'use strict';

// run-checks.js -- the suite-level test runner.
//
// Every project under projects/ grew its own verification script at its own
// pace, with its own name (test.js, verify.js, test-poller.js, selftest.js,
// smoke-test.ps1) and its own idea of what "run me" means. This runs all of
// them, reports pass/fail per project, and exits non-zero if anything failed.
//
//   node run-checks.js                  # everything safe to run unattended
//   node run-checks.js --list           # show the registry, run nothing
//   node run-checks.js --include-unsafe # also run the checks held back by default
//   node run-checks.js --only rollups   # substring filter on check name
//   node run-checks.js -v               # stream child output even on success
//   node run-checks.js --no-audit       # skip the unregistered-script audit
//   node run-checks.js --timeout 60000  # override every per-check timeout
//
// No package.json, no framework, no node_modules anywhere in this suite, and
// this file keeps it that way: stdlib only.
//
// ---------------------------------------------------------------------------
// REGISTRY, NOT GLOB -- why
// ---------------------------------------------------------------------------
// Globbing for *test*.js / verify*.js would adapt on its own as projects
// appear, and it was tempting. It cannot work here, for one decisive reason:
// *the thing the runner most needs to know about a check is not in its
// filename.* Whether a script is pure offline logic, needs a live llama
// server on a particular port, takes 90 seconds against every transcript on
// disk, or is one flag away from firing a blocking desktop popup -- none of
// that is derivable from `test.js`. A glob-driven runner has no choice but to
// execute everything it finds at face value, which is exactly the runner that
// spams popups and hangs. The safety classification has to be written down by
// someone who read the script, so the list may as well be written down too.
//
// The registry's real weakness is going stale, so that gets fixed directly
// rather than by giving up predictability: after the run, `auditUnregistered`
// globs for check-shaped filenames anyway and reports any it finds that aren't
// registered, as a failure. New project lands a test.js and nobody touches
// this file? The next run says so instead of quietly not testing it. Discovery
// is used for what it's good at (noticing new things) and not for what it's
// bad at (deciding what's safe to execute).
//
// ---------------------------------------------------------------------------
// SAFETY CLASSIFICATION
// ---------------------------------------------------------------------------
//   safety: 'safe'    run unattended, no prompts, no network, no side effects
//                     outside temp dirs / the project's own state dir.
//   needsPort: N      needs a live llama server on port N. Probed first: if
//                     it's down the check is SKIPPED, not failed. Other
//                     sessions in this suite restart those servers routinely,
//                     and a transient connection refusal is not a regression.
//   safety: 'unsafe'  held back unless --include-unsafe. See each entry's
//                     `why` for what specifically makes it unsafe.
//   args: [...]       extra argv for the check. Used where consent to do
//                     something disruptive belongs in the registry rather than
//                     in the script's default behaviour (--take-over).
//
// A check can also skip ITSELF, for a precondition only it can see: exit 3,
// with the reason on the last line of its output. 0 passed, 1 failed, 3
// skipped. Exiting 1 would make "nothing to check here" look identical to
// "the check found a bug", which is how a fresh clone with no transcripts
// yet used to report a failure.
//
// ---------------------------------------------------------------------------
// A NOTE ON KILLING THINGS
// ---------------------------------------------------------------------------
// On timeout this kills ONLY the direct child it spawned -- never
// `taskkill /T`, never a tree kill, never anything matched by name. There is
// exactly one watcher.js holding a PID lock and there are shared llama-server
// processes that other sessions and other repos depend on; a tree kill could
// plausibly reach a server this suite merely reused rather than started.
// Leaving a stray short-lived grandchild to exit on its own is the strictly
// less damaging failure mode.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const NODE = process.execPath;
const DEFAULT_TIMEOUT_MS = 60_000;

// The contract for "I cannot run here, and that is not a failure": a check
// exits 3 and prints why on its last line. 0 = passed, 1 = failed, 3 = skipped.
// This exists because the alternative is worse in both directions -- exiting 1
// makes an unrunnable check indistinguishable from a broken one, and exiting 0
// makes it indistinguishable from a passing one.
const SKIP_EXIT_CODE = 3;

// The child's own explanation, for the summary line.
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
    what: '29 offline assertions over the core: the rate card (dated intro pricing, fast-mode premium, cache multipliers, the [1m] variant, unknown models), transcript parsing (per-message.id usage, block proration, injected-user-turn filtering, torn lines), the statusline renderer against fixtures, and the session-naming helpers.',
    why: 'Pure logic. Transcript fixtures are written to a fresh mkdtemp dir and removed afterwards; the renderer is driven through renderLine\'s test-only status override, so the live status.json the watcher is actively rewriting is never read or touched. No network, no LLM, no watcher.',
  },
  {
    name: 'llama-local-server',
    script: 'packages/llama-local-server/test.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: "21 offline assertions over the code that decides whether to start or kill a process: netstat LISTENING-row parsing (including that an ESTABLISHED row's client pid is never mistaken for the server's), the on-disk ownership record, stopShared's three refusals -- no record, dead pid, live pid that does not hold the port -- the spawn lock's re-entrancy and staleness, and Ollama manifest resolution.",
    why: 'Redirects LLAMA_RUNTIME_DIR at a mkdtemp dir before requiring anything, so the real record file is never touched. Spawns nothing but short-lived sleeping node processes (used as stand-in "live pids" and killed on exit); never starts llama-server, never makes a network call.',
  },
  {
    name: 'token-monitor-core-lifecycle',
    script: 'packages/token-monitor-core/test-lifecycle.js',
    runner: 'node',
    args: ['--take-over'],
    // Real model load off disk, an idle countdown waited out in real time,
    // and a watcher restart at the end.
    timeoutMs: 300_000,
    safety: 'unsafe',
    what: 'End-to-end proof of the start/stop chain: a status line render starts a watcher, the watcher starts the shared llama-server and records its pid, twelve concurrent renders start no second watcher, a second watcher is refused by the lock, and killing the last live session stops both. Isolated into a temp state dir, temp llama runtime dir, and a fake ~/.claude/sessions registry.',
    why: [
      'It asserts on the state of the SHARED port 8090, which it cannot do while sharing it.',
      'With --take-over it pauses autostart (state/autostart.disabled), stops the running watcher, and takes 8090 for the duration -- so any other Claude Code session on this machine loses its status line data and its local-inference server for a minute or two. It restores autostart on exit and the next render brings the watcher back, but that is a real interruption, not a no-op.',
      'It also loads a ~2 GB model onto the GPU. Without --take-over it refuses to run rather than disturbing anything.',
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
    why: "Requires monitor.js as a module, which by design does not start the poll loop and does not call fireNotification(). Nothing in it can reach notify-done.ps1. Its only side effect outside temp is mkdir'ing the project's own state/ dir at require time.",
  },
  {
    name: 'usage-history-rollups',
    script: 'projects/usage-history-rollups/test-poller.js',
    runner: 'node',
    timeoutMs: 30_000,
    safety: 'safe',
    what: '41 assertions driving poll() through every snapshot transition, including ones that would take 30 real minutes.',
    why: 'Redirects itself at a fresh mkdtemp scratch dir via ROLLUP_STATUS_FILE / ROLLUP_STATE_DIR before requiring config, so it never reads or writes the real history or anything under packages/. Wholly offline.',
  },
  {
    name: 'per-project-cost-attribution',
    script: 'projects/per-project-cost-attribution/verify.js',
    runner: 'node',
    // Reads and parses every .jsonl transcript in ~/.claude/projects, twice
    // (its own parser plus token-monitor-core's classifySession). That set
    // only ever grows, so this gets a much longer leash than the pure-logic
    // checks -- a slow run here is expected, a hang is not.
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
    // ~10 real completions against a 3B model, plus a deliberate
    // fail-fast case. Slow but bounded.
    timeoutMs: 240_000,
    safety: 'safe',
    what: 'Smoke test for classify/extract/summarize: input parsing, schema round-trip, exit codes, and that an unreachable server fails fast instead of eating a 30s health-check timeout.',
    why: "Makes real LLM calls, so it needs the chat server. Assertions are deliberately loose enough that a 3B model passes reliably, so a failure means broken plumbing rather than an off day. Note it can spawn llama-server.exe itself if 8090 is cold -- the port probe below means it only ever runs against an already-up server, so it reuses rather than spawns.",
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
      '(1) It is not a pass/fail oracle. It asserts nothing -- it prints an expectation next to each actual result for a human to eyeball, and exits 0 no matter what the model said. Running it by default would contribute a permanent, meaningless green line to the summary, which is worse than not running it.',
      '(2) It drives ask-question-prefilter.ps1, the front door to a blocking WinForms popup with text-to-speech that halts until dismissed. Today every case is defused -- -DryRun or -AskQuestionPath pointed at the stub -- but the safety lives entirely in the arguments of ten call sites in a file this runner does not own. One future case added without -DryRun and an unattended run starts talking out loud and blocking on a dialog.',
      'Run it deliberately, watching it: node run-checks.js --only ask-question --include-unsafe',
    ].join('\n      '),
  },
];

// Projects that ship no check at all. Listed so the summary can say so out
// loud rather than have them silently absent -- not counted as failures.
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

// A single short probe, no retry -- deliberately mirroring llama-local-server's
// own isUp(). The point is to distinguish "the server isn't there" (skip) from
// "the check ran and disagreed with reality" (fail), not to wait for a cold
// server to finish loading a model.
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

// `script` is the single source of truth: the command line, the working
// directory, and the audit's "is this registered?" lookup are all derived from
// it. An earlier version carried a separate hand-written `args` array and the
// two promptly disagreed -- the PowerShell entry passed `scripts/smoke-test.ps1`
// while its cwd was already .../scripts, so the check would have failed to
// launch the first time anyone ran it with --include-unsafe. Deriving removes
// the chance to get it wrong.
//
// Each check runs from its own directory because they all use relative
// require()s and relative state paths, and none of them is written to be run
// from the suite root.
function buildCommand(check) {
  const file = path.basename(check.script);
  // A check may need a flag to run non-interactively at all -- the lifecycle
  // test refuses to touch the shared port without --take-over, deliberately,
  // so the registry is where that consent is recorded rather than baked into
  // the script's default behaviour.
  const extra = check.args || [];
  switch (check.runner) {
    case 'node':
      // process.execPath, not 'node' -- run children on the same runtime as
      // the runner rather than whatever PATH happens to resolve to.
      return { cmd: NODE, args: [file, ...extra] };
    case 'powershell':
      // -NonInteractive so a check that unexpectedly tries to prompt dies
      // instead of hanging until the timeout.
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
      // Direct child only. See the note at the top of this file about why
      // this is never a tree kill.
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
        // A check reporting that its own preconditions are absent -- not a
        // failure. Before this, per-project-cost-attribution exited 1 on a
        // machine with no transcripts yet, so a fresh clone's first
        // `node run-checks.js` went red for the most discouraging possible
        // reason: having nothing to check.
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

    // Progress ticker only when someone is watching a terminal -- a bare \r
    // leaves garbage in a redirected log or a CI capture.
    const interactive = process.stdout.isTTY && !opts.verbose;
    if (interactive) process.stdout.write(`....  ${check.name.padEnd(PAD)} running`);
    const r = await runCheck(check, opts);
    if (interactive) process.stdout.write(`\r${' '.repeat(PAD + 16)}\r`);
    // padEnd(8) not 6 -- 'TIMEOUT' is 7 characters and ran into the name.
    console.log(`${r.status.padEnd(8)}${check.name.padEnd(PAD)} ${fmtMs(r.ms).padStart(7)}  ${r.detail}`);
    results.push({ check, ...r });
  }

  // Failure output, printed once at the end so the per-check lines stay
  // scannable. Already streamed in --verbose, so don't repeat it there.
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
