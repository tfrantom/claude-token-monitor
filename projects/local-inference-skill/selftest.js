#!/usr/bin/env node
'use strict';

// Smoke test for the three delegation scripts. Not installed into
// ~/.claude/skills/ -- this is a maintenance tool for the source tree.
//
//   node selftest.js              # test the scripts in ./scripts/
//   node selftest.js --installed  # test the copies in ~/.claude/skills/
//
// Checks the plumbing (input parsing, ensureRunning, schema round-trip,
// exit codes), not the model's intelligence -- the assertions are
// deliberately loose enough that a 3B model passes them reliably. A failure
// here means something is actually broken, not that the model had an off day.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const installed = process.argv.includes('--installed');
const scriptsDir = installed
  ? path.join(os.homedir(), '.claude', 'skills', 'local-inference', 'scripts')
  : path.join(__dirname, 'scripts');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-inference-selftest-'));
let failures = 0;

function run(script, payload, extraEnv) {
  const file = path.join(tmpDir, `${script}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const res = spawnSync(process.execPath, [path.join(scriptsDir, script), '--in', file], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function main() {
  console.log(`local-inference selftest (${installed ? 'installed copy' : 'source tree'}: ${scriptsDir})\n`);

  console.log('classify.js');
  let r = run('classify.js', { text: 'Cannot log in, the password reset just loops', labels: ['bug', 'question', 'feature-request'] });
  check('single: exits 0 and returns a label from the list', r.code === 0 && ['bug', 'question', 'feature-request', 'unclear'].includes(r.out), `${r.code} ${r.out || r.err}`);

  r = run('classify.js', { items: ['console.log(x)', 'print(x)', 'fn main() {}'], labels: ['javascript', 'python', 'rust'] });
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  check('batch: exits 0 with one line per item', r.code === 0 && lines.length === 3, `${r.code} got ${lines.length} line(s): ${r.out || r.err}`);
  check('batch: every line is from the label list', lines.every((l) => ['javascript', 'python', 'rust', 'unclear'].includes(l)), r.out);

  r = run('classify.js', { text: 'hello' });
  check('rejects missing labels with exit 1', r.code === 1 && /labels/.test(r.err), `${r.code} ${r.err}`);

  r = run('classify.js', 'not json at all');
  check('rejects non-JSON input with exit 1', r.code === 1 && /not valid JSON/.test(r.err), `${r.code} ${r.err}`);

  console.log('\nextract.js');
  r = run('extract.js', { text: 'Release notes for v3.14.2 -- shipped 2026-08-01, fixes 12 bugs.', field: 'the version number' });
  check('finds a value that is present', r.code === 0 && r.out.includes('3.14.2'), `${r.code} ${r.out || r.err}`);

  r = run('extract.js', { text: 'Release notes for v3.14.2.', field: 'the shipping tracking number' });
  check('reports (not found) rather than inventing one', r.code === 0 && r.out === '(not found)', `${r.code} ${r.out || r.err}`);

  r = run('extract.js', { text: 'Zoe Muller, 42.50 EUR', field: '' });
  check('rejects empty field with exit 1', r.code === 1, `${r.code} ${r.err}`);

  console.log('\nsummarize.js');
  r = run('summarize.js', {
    text: 'The watcher tails every active Claude Code session transcript, classifies each block, prices the tokens against current per-model rates, and writes a status.json snapshot every five seconds.',
    max_words: 25,
  });
  check('returns a non-empty summary', r.code === 0 && r.out.length > 10, `${r.code} ${r.out || r.err}`);
  check('roughly respects max_words', r.out.split(/\s+/).length <= 60, `${r.out.split(/\s+/).length} words`);

  r = run('summarize.js', { text: 'hi', max_words: 5000 });
  check('rejects out-of-range max_words with exit 1', r.code === 1, `${r.code} ${r.err}`);

  console.log('\nfallback (server unreachable)');
  // Point at a dead port with a bogus exe: ensureRunning() must fail fast on
  // the spawn error rather than eating its whole 30s health-check timeout.
  const started = Date.now();
  r = run('classify.js', { text: 'x', labels: ['a', 'b'] }, { LLAMA_PORT: '8099', LLAMA_SERVER_EXE: 'C:\\nope\\does-not-exist.exe' });
  const elapsed = Date.now() - started;
  check('exits 1 with a "do it yourself" message', r.code === 1 && /yourself/.test(r.err), `${r.code} ${r.err}`);
  check('fails fast (<10s) instead of waiting out the 30s timeout', elapsed < 10000, `${elapsed}ms`);

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
