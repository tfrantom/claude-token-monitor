#!/usr/bin/env node
'use strict';

// Offline: no model call, no live status.json. Fixtures go to mkdtemp.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-auditor-'));
process.env.COMMENT_AUDITOR_STATE_DIR = path.join(TMP, 'state');

const { scanComments, dialectFor } = require('./lib/scanner');
const { triage, verdictFor, looksLikeCode, isProtected } = require('./lib/policy');
const { auditSource, applyFindings, parseRanges } = require('./lib/audit');
const { isQuiescent, lastWriteTo } = require('./lib/quiescence');
const { cached } = require('./lib/cache');
const { classifySession } = require('../../packages/token-monitor-core/lib/transcript');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const texts = (cs) => cs.map((c) => c.text.trim());

async function main() {
check('scanner: // inside a string literal is not a comment', () => {
  const cs = scanComments('const u = "http://x.com//y";\n// real\n', 'a.js');
  assert.deepStrictEqual(texts(cs), ['real']);
});

check('scanner: // inside a regex literal is not a comment', () => {
  const cs = scanComments('const re = /a\\/\\/b/g;\nconst d = a / b / c;\n// real\n', 'a.js');
  assert.deepStrictEqual(texts(cs), ['real']);
});

check('scanner: comment inside a template interpolation is found', () => {
  const cs = scanComments('const t = `x ${ y /* in */ } z // not`;\n', 'a.js');
  assert.deepStrictEqual(texts(cs), ['in']);
});

check('scanner: consecutive line comments group into one unit', () => {
  const cs = scanComments('// one\n// two\n// three\ncode();\n', 'a.js');
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].lineCount, 3);
  assert.strictEqual(cs[0].endLine, 3);
});

check('scanner: a blank line breaks a group', () => {
  const cs = scanComments('// one\n\n// two\ncode();\n', 'a.js');
  assert.strictEqual(cs.length, 2);
});

check('scanner: trailing vs leading is distinguished', () => {
  const cs = scanComments('// leading\ncode(); // trailing\n', 'a.js');
  assert.strictEqual(cs[0].trailing, false);
  assert.strictEqual(cs[1].trailing, true);
  assert.strictEqual(cs[1].code, 'code();');
});

check('scanner: leading comment is given the code below it', () => {
  const cs = scanComments('// what\nconst x = load();\nmore();\n', 'a.js');
  assert.ok(cs[0].code.startsWith('const x = load();'));
});

check('scanner: lua line and long-bracket comments, not strings', () => {
  const cs = scanComments('local s = "-- no"\n-- yes\n--[[ blk ]]\n', 'a.lua');
  assert.deepStrictEqual(texts(cs), ['yes', 'blk']);
});

check('scanner: powershell # and <# #>, not strings', () => {
  const cs = scanComments('$a = "# no"\n# yes\n<# blk #>\n', 'a.ps1');
  assert.deepStrictEqual(texts(cs), ['yes', 'blk']);
});

check('scanner: unterminated block comment does not hang or overrun', () => {
  const cs = scanComments('code();\n/* never closed\n', 'a.js');
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].style, 'block');
});

check('scanner: unknown extension returns null rather than guessing', () => {
  assert.strictEqual(scanComments('// x', 'a.unknownext'), null);
  assert.strictEqual(dialectFor('a.bin'), null);
});

check('policy: tooling directives are protected', () => {
  for (const t of [
    ' eslint-disable-next-line no-shadow',
    ' prettier-ignore',
    ' @ts-expect-error legacy',
    ' istanbul ignore next',
    ' webpackChunkName: "lottie"',
    ' SPDX-License-Identifier: MIT',
    ' TODO: handle the empty case',
    ' noqa: E501',
  ]) {
    assert.ok(isProtected(t), `should be protected: ${t}`);
  }
});

check('policy: ordinary prose is not protected', () => {
  assert.strictEqual(isProtected(' Load the config file'), null);
});

check('policy: protected comments never reach a verdict', () => {
  const t = triage({ text: ' eslint-disable-next-line' });
  assert.strictEqual(t.label, 'protected');
  assert.strictEqual(verdictFor('protected', 1, 0.75), 'keep');
});

check('policy: history phrasing is decided by rule', () => {
  const t = triage({ text: ' this used to be a Map, we tried a Set first' });
  assert.strictEqual(t.label, 'history');
  assert.strictEqual(t.by, 'rule');
});

check('policy: commented-out code is detected', () => {
  assert.ok(looksLikeCode('const x = 1;\nfoo(x);'));
  assert.ok(looksLikeCode('return null;'));
  assert.strictEqual(looksLikeCode('Load the config and then parse it'), false);
});

check('policy: banners are decided by rule', () => {
  assert.strictEqual(triage({ text: ' ---------------- helpers ----------------' }).label, 'banner');
  assert.strictEqual(triage({ text: ' ==================' }).label, 'banner');
});

check('policy: a measured finding is relocate, never remove', () => {
  assert.strictEqual(verdictFor('measured-finding', 1, 0.75), 'relocate');
});

check('policy: a low-confidence rule removal is downgraded to review', () => {
  assert.strictEqual(verdictFor('restates-code', 0.9, 0.75, 'rule'), 'remove');
  assert.strictEqual(verdictFor('restates-code', 0.5, 0.75, 'rule'), 'review');
});

check('policy: a model label can never become a removal', () => {
  assert.strictEqual(verdictFor('restates-code', 1, 0.75, 'model'), 'review');
  assert.strictEqual(verdictFor('history', 1, 0.75, 'model'), 'review');
  assert.strictEqual(verdictFor('restates-code', 1, 0.75, 'cache'), 'review');
});

check('policy: pointers and traps are kept by rule, not sent to the model', () => {
  for (const t of [
    ' Usage is per message.id -- see CLAUDE.md "Transcript parsing"',
    ' Must match statusline.js\'s fmtCostShort.',
    ' see packages/llama-local-server/ports.js',
    ' refresh is required, not cosmetic',
    ' Do not "fix" this',
    ' https://example.com/why',
  ]) {
    const t2 = triage({ text: t });
    assert.ok(t2, `should be settled by rule: ${t}`);
    assert.strictEqual(verdictFor(t2.label, t2.confidence, 0.75, 'rule'), 'keep', t);
  }
});

const stubClassifier = (labels) => async (items) => {
  const m = new Map();
  for (const it of items) {
    const hit = labels[it.index];
    if (hit) m.set(it.index, { by: 'model', confidence: 0.9, reason: 'stub', ...hit });
  }
  return m;
};

await checkAsync('audit: rules-only never calls the model', async () => {
  let called = false;
  const r = await auditSource('// we tried a Map here\ncode();\n', 'a.js', {
    rulesOnly: true,
    classify: async () => {
      called = true;
      return new Map();
    },
  });
  assert.strictEqual(called, false);
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].label, 'history');
});

await checkAsync('audit: only unsettled comments are sent to the model', async () => {
  let sent = [];
  await auditSource('// eslint-disable-next-line\n// we tried this before\n\n// Load the config\nload();\n', 'a.js', {
    classify: async (items) => {
      sent = items.map((i) => i.text.trim());
      return new Map();
    },
  });
  assert.deepStrictEqual(sent, ['Load the config']);
});

await checkAsync('audit: a dead model degrades to rule findings, never throws', async () => {
  const r = await auditSource('// we tried a Map\nmap();\n\n// Load the config\nload();\n', 'a.js', {
    classify: async () => null,
  });
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.findings.length, 1);
});

await checkAsync('audit: a model restatement is reported for review, never removed', async () => {
  const src = '// Load the config\nload();\n';
  const r = await auditSource(src, 'a.js', { classify: stubClassifier({ 0: { label: 'restates-code' } }) });
  assert.strictEqual(r.findings[0].verdict, 'review');
  assert.strictEqual(applyFindings(src, r.findings), src);
});

await checkAsync('audit: a rule removal still removes', async () => {
  const src = '// ---------------- helpers ----------------\na();\n';
  const r = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(r.findings[0].verdict, 'remove');
  assert.strictEqual(applyFindings(src, r.findings), 'a();\n');
});

await checkAsync('audit: --lines scopes the audit to comments touching those lines', async () => {
  const src = '// const a = 1;\na();\n// const b = 2;\nb();\n';
  const all = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(all.findings.length, 2);
  const scoped = await auditSource(src, 'a.js', { rulesOnly: true, lines: [[3, 4]] });
  assert.strictEqual(scoped.findings.length, 1);
  assert.strictEqual(scoped.findings[0].line, 3);
  assert.strictEqual(scoped.scanned, 1);
  assert.strictEqual(scoped.inFile, 2);
});

check('audit: line ranges parse, and a bad one is named', () => {
  assert.deepStrictEqual(parseRanges('12'), [[12, 12]]);
  assert.deepStrictEqual(parseRanges('12,40-58'), [[12, 12], [40, 58]]);
  assert.throws(() => parseRanges('12-'), /bad line range/);
});

await checkAsync('audit: unsupported file type is reported, not crashed on', async () => {
  const r = await auditSource('whatever', 'a.bin', {});
  assert.strictEqual(r.unsupported, true);
  assert.deepStrictEqual(r.findings, []);
});

// Geometry, not policy: these drive rule-produced removals, since a model
// label can no longer reach 'remove'.
await checkAsync('apply: removing a leading comment takes its whole line', async () => {
  const src = 'before();\n  // const x = 1;\n  load();\n';
  const r = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(applyFindings(src, r.findings), 'before();\n  load();\n');
});

await checkAsync('apply: removing a trailing comment keeps its code line', async () => {
  const src = 'load(); // return null;\nnext();\n';
  const r = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(applyFindings(src, r.findings), 'load();\nnext();\n');
});

await checkAsync('apply: several removals in one file stay aligned', async () => {
  const src = '// const a = 1;\na();\n// const b = 2;\nb();\n// const c = 3;\nc();\n';
  const r = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(applyFindings(src, r.findings), 'a();\nb();\nc();\n');
});

await checkAsync('apply: a multi-line group is removed whole', async () => {
  const src = '// const a = 1;\n// const b = 2;\n// const c = 3;\na();\n';
  const r = await auditSource(src, 'a.js', { rulesOnly: true });
  assert.strictEqual(applyFindings(src, r.findings), 'a();\n');
});

await checkAsync('apply: relocate and review findings are never applied', async () => {
  const src = '// 8ms per tick\na();\n';
  const r = await auditSource(src, 'a.js', { classify: stubClassifier({ 0: { label: 'measured-finding' } }) });
  assert.strictEqual(applyFindings(src, r.findings), src);
});

const cacheFile = path.join(TMP, 'verdicts.json');

await checkAsync('cache: a stored verdict is reused without calling the model', async () => {
  let calls = 0;
  const inner = async (items) => {
    calls += 1;
    return new Map(items.map((i) => [i.index, { label: 'restates-code', confidence: 0.9, reason: 'x', by: 'model' }]));
  };
  const wrapped = cached(inner, { file: cacheFile });
  const items = [{ index: 0, text: '// Load the config', code: 'load();' }];
  const first = await wrapped(items, {});
  const second = await wrapped(items, {});
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.get(0).by, 'model');
  assert.strictEqual(second.get(0).by, 'cache');
  assert.strictEqual(second.get(0).label, 'restates-code');
});

await checkAsync('cache: changing the comment re-asks', async () => {
  let calls = 0;
  const wrapped = cached(async (items) => {
    calls += 1;
    return new Map(items.map((i) => [i.index, { label: 'restates-code', confidence: 0.9, reason: 'x', by: 'model' }]));
  }, { file: cacheFile });
  await wrapped([{ index: 0, text: '// Alpha', code: 'a();' }], {});
  await wrapped([{ index: 0, text: '// Beta', code: 'a();' }], {});
  assert.strictEqual(calls, 2);
});

await checkAsync('cache: an unanswered comment is not cached as a miss', async () => {
  let calls = 0;
  const wrapped = cached(async () => {
    calls += 1;
    return new Map();
  }, { file: cacheFile });
  const items = [{ index: 0, text: '// Gamma', code: 'g();' }];
  await wrapped(items, {});
  await wrapped(items, {});
  assert.strictEqual(calls, 2);
});

const gitFile = path.join(TMP, 'repo', 'src', 'x.js');
fs.mkdirSync(path.join(TMP, 'repo', '.git'), { recursive: true });
fs.mkdirSync(path.dirname(gitFile), { recursive: true });
fs.writeFileSync(gitFile, '// x\n');
const nogitFile = path.join(TMP, 'loose', 'y.js');
fs.mkdirSync(path.dirname(nogitFile), { recursive: true });
fs.writeFileSync(nogitFile, '// y\n');

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const statusWith = (sessions, updatedAt = '2026-08-12T11:59:55.000Z') => ({ updated_at: updatedAt, sessions });

check('quiescence: no git repository above the file blocks a write', () => {
  const g = isQuiescent(nogitFile, { now: NOW, status: statusWith({}) });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.signal, 'git');
});

check('quiescence: a missing status.json blocks a write', () => {
  const g = isQuiescent(gitFile, { now: NOW, status: null, statusFile: path.join(TMP, 'nope.json') });
  assert.strictEqual(g.ok, false);
});

check('quiescence: a stale status.json blocks a write', () => {
  const g = isQuiescent(gitFile, { now: NOW, status: statusWith({}, '2026-08-12T11:00:00.000Z') });
  assert.strictEqual(g.ok, false);
});

check('quiescence: a file written seconds ago blocks a write', () => {
  const status = statusWith({
    s1: { ended: false, last_activity: '2026-08-12T11:59:58.000Z', recent_writes: [{ path: gitFile, at: '2026-08-12T11:59:58.000Z' }] },
  });
  const g = isQuiescent(gitFile, { now: NOW, status });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.signal, 'per-file');
});

check('quiescence: an untouched file is writable even while a session is live', () => {
  const status = statusWith({
    s1: { ended: false, last_activity: '2026-08-12T11:59:58.000Z', recent_writes: [{ path: path.join(TMP, 'repo', 'other.js'), at: '2026-08-12T11:59:58.000Z' }] },
  });
  const g = isQuiescent(gitFile, { now: NOW, status });
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.signal, 'per-file');
});

check('quiescence: an old write to this file is writable', () => {
  const status = statusWith({
    s1: { ended: false, last_activity: '2026-08-12T11:59:58.000Z', recent_writes: [{ path: gitFile, at: '2026-08-12T11:50:00.000Z' }] },
  });
  assert.strictEqual(isQuiescent(gitFile, { now: NOW, status }).ok, true);
});

check('quiescence: an older watcher with no write index falls back session-wide', () => {
  const busy = statusWith({ s1: { ended: false, last_activity: '2026-08-12T11:59:58.000Z' } });
  const idle = statusWith({ s1: { ended: false, last_activity: '2026-08-12T11:50:00.000Z' } });
  assert.strictEqual(isQuiescent(gitFile, { now: NOW, status: busy }).signal, 'session-wide');
  assert.strictEqual(isQuiescent(gitFile, { now: NOW, status: busy }).ok, false);
  assert.strictEqual(isQuiescent(gitFile, { now: NOW, status: idle }).ok, true);
});

check('quiescence: path comparison survives separator and case differences', () => {
  const status = statusWith({
    s1: { recent_writes: [{ path: gitFile.replace(/\\/g, '/').toUpperCase(), at: '2026-08-12T11:59:58.000Z' }] },
  });
  assert.ok(lastWriteTo(status, gitFile).newest > 0);
});

const transcript = path.join(TMP, 'session.jsonl');
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-12T11:59:58.000Z',
      message: {
        id: 'm1',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'C:\\projects\\x\\a.js', old_string: 'a', new_string: 'b' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'C:\\projects\\x\\b.js' } },
        ],
      },
    }),
  ].join('\n')
);

check('core: transcript.js reports file-mutating tool calls only', () => {
  const parsed = classifySession(transcript);
  assert.strictEqual(parsed.fileWrites.length, 1);
  assert.strictEqual(parsed.fileWrites[0].path, 'C:\\projects\\x\\a.js');
  assert.strictEqual(parsed.fileWrites[0].at, '2026-08-12T11:59:58.000Z');
});

check('core: adding fileWrites did not disturb the existing totals contract', () => {
  const parsed = classifySession(transcript);
  assert.strictEqual(parsed.totals.context, 10);
  assert.ok(parsed.totals.cost_usd > 0);
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`comment-auditor test harness crashed: ${err.stack}`);
  process.exitCode = 1;
});
