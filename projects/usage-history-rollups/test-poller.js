'use strict';

// node test-poller.js -- drives poll() against a scratch fixture.
// The env redirects below must stay ABOVE the require('./config'), or this
// writes to the real history.

const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rollup-test-'));
process.env.ROLLUP_STATUS_FILE = path.join(scratch, 'status.json');
process.env.ROLLUP_STATE_DIR = path.join(scratch, 'state');
process.env.ROLLUP_ENDED_CONFIRM_POLLS = '2';
process.env.ROLLUP_PERIODIC_SNAPSHOT_MS = '3600000';

const cfg = require('./config');
const { poll, seedFinalizedFromHistory } = require('./poller');
const { toDeltas } = require('./report');

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${msg}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

function writeStatus(sessions) {
  fs.writeFileSync(process.env.ROLLUP_STATUS_FILE, JSON.stringify({ updated_at: new Date().toISOString(), sessions }));
}

function session(id, { cost = 1, ended = false, name = `Session ${id}` } = {}) {
  return {
    session_id: id,
    project: 'C--projects',
    name,
    ended,
    last_activity: new Date().toISOString(),
    mtime_ms: Date.now(),
    models: ['claude-opus-5'],
    totals: { context: 10, cache_write: 100, cache_read: 1000, thinking: 50, writing: 20, tool_calls: 30, cost_usd: cost, unpriced_output_tokens: 0 },
    semantic: { thinking_productive: 0, thinking_wasted: 0, thinking_unclassified: 50, tool_explore: 30, tool_mutate: 0, tool_verify: 0, tool_redundant: 0, tool_other: 0, tool_unclassified: 0 },
  };
}

function history() {
  try {
    return fs
      .readFileSync(cfg.HISTORY_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

let state = {};
const step = (sessions, nowMs) => {
  if (sessions !== null) writeStatus(sessions);
  state = poll(state, nowMs).state;
};

section('live session is tracked but not snapshotted');
step({ A: session('A', { cost: 1 }) });
check(history().length === 0, 'no entry written for a merely-live session');
check('A' in state && state.A.finalized === false, 'A tracked, not finalized');

section('ended flag requires confirmation before finalizing');
step({ A: session('A', { cost: 2, ended: true }) });
check(history().length === 0, 'first ended poll does not write yet (confirm threshold is 2)');
check(state.A.ended_polls === 1, 'ended_polls incremented to 1');

step({ A: session('A', { cost: 2.5, ended: true }) });
let h = history();
check(h.length === 1, 'second consecutive ended poll writes the final snapshot');
check(h[0].reason === 'ended' && h[0].session_id === 'A', "entry is A with reason 'ended'");
check(h[0].totals.cost_usd === 2.5, 'final snapshot captured the latest cumulative cost (2.5)');
check(h[0].v === cfg.SCHEMA_VERSION, 'entry carries the schema version');
check(h[0].by_project === null, 'by_project passthrough is null while status.json has no such field');
check(h[0].semantic !== null, 'semantic block carried through');

section('a finalized session lingering in the 30-min window is not re-written');
step({ A: session('A', { cost: 2.5, ended: true }) });
step({ A: session('A', { cost: 2.5, ended: true }) });
check(history().length === 1, 'still exactly one entry after two more ended polls');

section('aging out of status.json after being finalized writes nothing extra');
step({});
check(history().length === 1, "no 'vanished' entry for an already-finalized session");
check(!('A' in state), 'A dropped from tracking');

section('transient all-ended blip does not finalize a live session');
step({ B: session('B', { cost: 5 }) });
step({ B: session('B', { cost: 5, ended: true }) });
step({ B: session('B', { cost: 6 }) });
check(history().length === 1, 'no final snapshot written for the one-poll blip');
check(state.B.ended_polls === 0, 'ended counter reset once the session read live again');

section('vanished fallback for a session that never reported ended');
step({});
h = history();
check(h.length === 2, 'B rolled up when it left status.json unconfirmed');
check(h[1].reason === 'vanished' && h[1].session_id === 'B', "entry is B with reason 'vanished'");
check(h[1].totals.cost_usd === 6, 'vanished entry used the last-known totals (6)');

section('unreadable status.json never infers session loss');
step({ C: session('C', { cost: 3 }) });
const before = history().length;
fs.writeFileSync(process.env.ROLLUP_STATUS_FILE, '{"sessions": {"C": {broken');
step(null);
check(history().length === before, 'malformed status.json writes nothing');
check('C' in state, 'C still tracked across the malformed read');
fs.rmSync(process.env.ROLLUP_STATUS_FILE);
step(null);
check(history().length === before, 'missing status.json writes nothing');
check('C' in state, 'C still tracked across the missing file');
fs.writeFileSync(process.env.ROLLUP_STATUS_FILE, JSON.stringify({ updated_at: 'x' }));
step(null);
check(history().length === before, 'status.json without a sessions key writes nothing');
check('C' in state, 'C still tracked across the shapeless read');

section('periodic sampling of a long-lived session');
const t0 = Date.now();
step({ C: session('C', { cost: 3 }) }, t0);
step({ C: session('C', { cost: 8 }) }, t0 + cfg.PERIODIC_SNAPSHOT_MS + 1);
h = history();
check(h.length === before + 1, 'periodic snapshot fired once the interval elapsed');
check(h[h.length - 1].reason === 'periodic' && h[h.length - 1].totals.cost_usd === 8, "entry is 'periodic' at cost 8");
step({ C: session('C', { cost: 9 }) }, t0 + cfg.PERIODIC_SNAPSHOT_MS + 2);
check(history().length === before + 1, 'no second periodic immediately after');

section('resumed session (claude --resume) can be finalized twice');
step({ C: session('C', { cost: 10, ended: true }) }, t0 + 1e7);
step({ C: session('C', { cost: 10, ended: true }) }, t0 + 1e7);
const afterFirstEnd = history().length;
check(history()[afterFirstEnd - 1].reason === 'ended', 'C finalized');
// Kept inside PERIODIC_SNAPSHOT_MS of the last write, so no periodic sample lands in between.
step({ C: session('C', { cost: 12 }) }, t0 + 1e7 + 1000);
check(state.C.finalized === false, 'finalized cleared when the session came back live');
check(history().length === afterFirstEnd, 'coming back live writes nothing by itself');
step({ C: session('C', { cost: 15, ended: true }) }, t0 + 1e7 + 2000);
step({ C: session('C', { cost: 15, ended: true }) }, t0 + 1e7 + 3000);
h = history();
check(h.length === afterFirstEnd + 1, 'a second final snapshot was written after the resume');
check(h[h.length - 1].reason === 'ended' && h[h.length - 1].totals.cost_usd === 15, 'second final captured cost 15');

section('dedup survives losing last-seen.json');
fs.rmSync(cfg.LAST_SEEN_FILE);
let reloaded = seedFinalizedFromHistory({ C: { session: session('C', { cost: 15, ended: true }), first_seen_at: new Date().toISOString(), last_snapshot_at: Date.now(), ended_polls: 5, finalized: false } });
check(reloaded.C.finalized === true, 'finalized re-derived from history.jsonl on a cold start');

section('report.js differences cumulative snapshots correctly');
const deltas = toDeltas([
  { ts: '2026-08-01T00:00:00Z', session_id: 'X', reason: 'periodic', totals: { cost_usd: 2, thinking: 10 } },
  { ts: '2026-08-02T00:00:00Z', session_id: 'X', reason: 'periodic', totals: { cost_usd: 5, thinking: 25 } },
  { ts: '2026-08-03T00:00:00Z', session_id: 'X', reason: 'ended', totals: { cost_usd: 9, thinking: 40 } },
]);
const summed = deltas.reduce((a, d) => a + d.delta.cost_usd, 0);
check(summed === 9, `three cumulative snapshots of 2/5/9 sum to 9 after differencing, not 16 (got ${summed})`);
check(deltas[1].delta.cost_usd === 3 && deltas[2].delta.cost_usd === 4, 'per-period deltas are 2, 3, 4');
const clamped = toDeltas([
  { ts: '2026-08-01T00:00:00Z', session_id: 'Y', reason: 'periodic', totals: { cost_usd: 5 } },
  { ts: '2026-08-02T00:00:00Z', session_id: 'Y', reason: 'ended', totals: { cost_usd: 1 } },
]);
check(clamped[1].delta.cost_usd === 0, 'a shrinking total clamps to a zero delta rather than going negative');

section('compact.js rolls up old detail without changing any total');
const { compact } = require('./compact');
const day = 24 * 60 * 60 * 1000;
// Floored to a UTC midnight, so the +1h/+2h snapshots below stay on the same
// UTC day as `old`. Deriving it straight from Date.now() made this fail for
// the two hours before midnight UTC and pass the rest of the day.
const old = Math.floor((Date.now() - 30 * day) / day) * day;
const mk = (sid, offsetMs, cost, reason = 'periodic') => ({ ts: new Date(offsetMs).toISOString(), session_id: sid, reason, name: sid, totals: { cost_usd: cost, thinking: cost * 10 } });
const raw = [
  mk('P', old, 1),
  mk('P', old + 3600e3, 4),
  mk('P', old + 7200e3, 6),
  mk('P', old + day, 11, 'ended'),
  mk('Q', old + 3600e3, 2),
  mk('Q', old + 7200e3, 5, 'ended'),
  mk('R', Date.now() - 3600e3, 7),
];
const cutoff = Date.now() - 7 * day;
const out = compact(raw, cutoff);
check(out.length === 4, `7 entries compact to 4 (got ${out.length})`);
check(out.filter((e) => e.session_id === 'R').length === 1, 'recent entry left untouched');
const totalBefore = toDeltas(raw).reduce((a, d) => a + d.delta.cost_usd, 0);
const totalAfter = toDeltas(out).reduce((a, d) => a + d.delta.cost_usd, 0);
check(Math.abs(totalBefore - totalAfter) < 1e-9, `cost total unchanged by compaction (${totalBefore} vs ${totalAfter})`);
check(out.find((e) => e.session_id === 'P' && e.ts.startsWith(new Date(old).toISOString().slice(0, 10))).totals.cost_usd === 6, "kept the LAST snapshot of P's first day (6), not the first");
check(out.every((e, i, a) => i === 0 || Date.parse(a[i - 1].ts) <= Date.parse(e.ts)), 'output stays in timestamp order');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (scratch: ${scratch})`);
process.exit(failures === 0 ? 0 : 1);
