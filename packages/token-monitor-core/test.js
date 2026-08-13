#!/usr/bin/env node
'use strict';

// Offline checks: no network, no LLM, no watcher, and nothing under the real
// state/ is read or written.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirected BEFORE anything requires ./config: the supervisor checks below
// write lock and stamp files, which would otherwise fight the live watcher.
const stateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-core-state-'));
process.env.TOKEN_MONITOR_STATE_DIR = stateTmp;
const signalTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-core-signals-'));
process.env.TOKEN_MONITOR_SIGNAL_DIR = signalTmp;

const cfg = require('./config');

const { costForTurn, priceFor, rateFor } = require('./lib/pricing');
const { classifySession } = require('./lib/transcript');
const { renderLine, fmtK, fmtCostShort } = require('./statusline');
const { sameTopic, topicWords, joinRecent } = require('./watcher');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, message: err.message });
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tmc-core-test-'));
function fixture(name, lines) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

function outputOnly(model, outputTokens, extra = {}) {
  return {
    model,
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_5m: 0,
    cache_creation_1h: 0,
    output_tokens: outputTokens,
    ...extra,
  };
}

const AUG = Date.parse('2026-08-07T12:00:00Z'); // inside Sonnet 5's intro window
const SEP = Date.parse('2026-09-15T12:00:00Z'); // after it closes

check('model ids resolve to the right rate card entry', () => {
  assert.strictEqual(priceFor('claude-opus-5').name, 'Claude Opus 5');
  assert.strictEqual(priceFor('claude-sonnet-5').name, 'Claude Sonnet 5');
  assert.strictEqual(priceFor('claude-haiku-4-5-20251001').name, 'Claude Haiku 4.5');
  assert.strictEqual(priceFor('claude-opus-4-8').name, 'Claude Opus 4.8');
  assert.strictEqual(priceFor(null), null);
});

check('opus-5 matches ahead of the opus-4-x fallback', () => {
  assert.strictEqual(priceFor('claude-opus-5').input, 5.0);
  assert.strictEqual(priceFor('claude-opus-4-7').name, 'Claude Opus 4.x');
});

check('the [1m] long-context variant prices as the base model', () => {
  const base = costForTurn(outputOnly('claude-opus-5', 1e6, { at_ms: AUG }));
  const long = costForTurn(outputOnly('claude-opus-5[1m]', 1e6, { at_ms: AUG }));
  assert.strictEqual(long.cost, base.cost);
  assert.strictEqual(long.cost, 25.0);
});

check('sonnet 5 bills at the intro rate inside the window', () => {
  const r = costForTurn(outputOnly('claude-sonnet-5', 1e6, { at_ms: AUG }));
  assert.strictEqual(r.cost, 10.0, 'expected $10/1M intro output rate');
});

check('sonnet 5 reverts to standard after the window closes', () => {
  const r = costForTurn(outputOnly('claude-sonnet-5', 1e6, { at_ms: SEP }));
  assert.strictEqual(r.cost, 15.0, 'expected $15/1M standard output rate');
});

check('a dated rate is chosen by the turn timestamp, not by wall clock', () => {
  const aug = rateFor(priceFor('claude-sonnet-5'), { atMs: AUG });
  const sep = rateFor(priceFor('claude-sonnet-5'), { atMs: SEP });
  assert.strictEqual(aug.output, 10.0);
  assert.strictEqual(sep.output, 15.0);
});

check('fast mode on opus 5 bills at the premium rate', () => {
  const std = costForTurn(outputOnly('claude-opus-5', 1e6, { speed: 'standard', at_ms: AUG }));
  const fast = costForTurn(outputOnly('claude-opus-5', 1e6, { speed: 'fast', at_ms: AUG }));
  assert.strictEqual(std.cost, 25.0);
  assert.strictEqual(fast.cost, 50.0, 'fast mode is 2x, not the standard rate');
  assert.strictEqual(fast.fastUnpriced, false);
});

check('fast mode on a model with no published premium is flagged, not guessed', () => {
  const r = costForTurn(outputOnly('claude-opus-4-8', 1e6, { speed: 'fast', at_ms: AUG }));
  assert.strictEqual(r.cost, 25.0, 'falls back to the standard rate');
  assert.strictEqual(r.fastUnpriced, true, 'and says so rather than silently absorbing it');
});

check('cache write/read multipliers are 1.25x / 2x / 0.1x of input', () => {
  const r = costForTurn({
    model: 'claude-opus-5',
    at_ms: AUG,
    input_tokens: 1e6, //         $5.00 at 1x
    cache_creation_5m: 1e6, //    $6.25 at 1.25x
    cache_creation_1h: 1e6, //   $10.00 at 2x
    cache_read_input_tokens: 1e6, // $0.50 at 0.1x
    output_tokens: 0,
  });
  assert.ok(Math.abs(r.cost - 21.75) < 1e-9, `expected 21.75, got ${r.cost}`);
});

check('an unknown model is reported unpriced rather than counted as free', () => {
  const r = costForTurn(outputOnly('claude-something-9', 1e6, { at_ms: AUG }));
  assert.strictEqual(r.cost, 0);
  assert.strictEqual(r.priced, false);
});

const ASSISTANT_USAGE = {
  input_tokens: 100,
  output_tokens: 1000,
  cache_read_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
  speed: 'standard',
};

check('usage is counted once per message.id, not once per content-block line', () => {
  const p = fixture('multiblock.jsonl', [
    { type: 'user', timestamp: '2026-08-07T12:00:00Z', message: { content: 'do a thing for me please' } },
    { type: 'assistant', timestamp: '2026-08-07T12:00:01Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [{ type: 'thinking', thinking: 'hmm' }] } },
    { type: 'assistant', timestamp: '2026-08-07T12:00:02Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [{ type: 'text', text: 'answer' }] } },
    { type: 'assistant', timestamp: '2026-08-07T12:00:03Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [{ type: 'tool_use', name: 'Read', input: { file: 'x' } }] } },
  ]);
  const r = classifySession(p);
  assert.strictEqual(r.totals.context, 100);
  assert.strictEqual(r.totals.cache_read, 500);
  assert.strictEqual(r.totals.cache_write, 200);
});

check('output tokens are prorated across blocks and sum to the turn total', () => {
  const p = fixture('prorate.jsonl', [
    { type: 'user', timestamp: '2026-08-07T12:00:00Z', message: { content: 'a real user message with enough text' } },
    { type: 'assistant', timestamp: '2026-08-07T12:00:01Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [{ type: 'thinking', thinking: 'x' }] } },
    { type: 'assistant', timestamp: '2026-08-07T12:00:05Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [{ type: 'text', text: 'y' }] } },
  ]);
  const t = classifySession(p).totals;
  const prorated = t.thinking + t.writing + t.tool_calls;
  assert.ok(Math.abs(prorated - 1000) < 1e-6, `blocks summed to ${prorated}, expected the turn's 1000`);
  assert.ok(t.thinking > 0 && t.writing > 0, 'both buckets should receive a share');
});

check('injected pseudo-user turns are kept out of userTexts', () => {
  const p = fixture('injected.jsonl', [
    { type: 'user', timestamp: '2026-08-07T12:00:00Z', message: { content: 'genuine opening message from the human' } },
    { type: 'user', timestamp: '2026-08-07T12:00:01Z', message: { content: '<task-notification>agent finished</task-notification>' } },
    { type: 'user', timestamp: '2026-08-07T12:00:02Z', message: { content: '<system-reminder>remember to floss</system-reminder>' } },
    { type: 'user', timestamp: '2026-08-07T12:00:03Z', message: { content: '[Request interrupted by user]' } },
    { type: 'user', timestamp: '2026-08-07T12:00:04Z', message: { content: '<command-name>/clear</command-name>' } },
  ]);
  assert.deepStrictEqual(classifySession(p).userTexts, ['genuine opening message from the human']);
});

check('an injected block appended to a real message is stripped, message kept', () => {
  const p = fixture('mixed.jsonl', [
    { type: 'user', timestamp: '2026-08-07T12:00:00Z', message: { content: 'fix the parser<system-reminder>noise</system-reminder>' } },
  ]);
  assert.deepStrictEqual(classifySession(p).userTexts, ['fix the parser']);
});

check('Agent spawns are captured in transcript order', () => {
  const p = fixture('agents.jsonl', [
    { type: 'assistant', timestamp: '2026-08-07T12:00:01Z', message: { id: 'm1', model: 'claude-opus-5', usage: ASSISTANT_USAGE, content: [
      { type: 'tool_use', name: 'Agent', id: 'tu_1', input: { description: 'first' } },
      { type: 'tool_use', name: 'Agent', id: 'tu_2', input: { description: 'second' } },
      { type: 'tool_use', name: 'Read', id: 'tu_3', input: {} },
    ] } },
  ]);
  const uses = classifySession(p).agentUses;
  assert.strictEqual(uses.length, 2, 'only Agent tool_use blocks count');
  assert.deepStrictEqual(uses.map((u) => u.description), ['first', 'second']);
});

check('a malformed line is skipped without losing the rest of the file', () => {
  const p = path.join(tmp, 'torn.jsonl');
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'user', timestamp: '2026-08-07T12:00:00Z', message: { content: 'a genuine user message here' } }),
    '{"type":"assistant","message":{"id":"m1",',
    JSON.stringify({ type: 'user', timestamp: '2026-08-07T12:00:02Z', message: { content: 'a second genuine message' } }),
  ].join('\n'));
  assert.strictEqual(classifySession(p).userTexts.length, 2);
});

check('a missing transcript returns null rather than throwing', () => {
  assert.strictEqual(classifySession(path.join(tmp, 'does-not-exist.jsonl')), null);
});

check('fast-mode turns in a transcript reach the pricing layer', () => {
  const fast = { ...ASSISTANT_USAGE, speed: 'fast' };
  const mk = (usage) => fixture(`speed-${usage.speed}.jsonl`, [
    { type: 'assistant', timestamp: '2026-08-07T12:00:01Z', message: { id: 'm1', model: 'claude-opus-5', usage, content: [{ type: 'text', text: 'hi' }] } },
  ]);
  const stdCost = classifySession(mk(ASSISTANT_USAGE)).totals.cost_usd;
  const fastCost = classifySession(mk(fast)).totals.cost_usd;
  assert.ok(fastCost > stdCost * 1.9, `fast (${fastCost}) should be ~2x standard (${stdCost})`);
});

function session(over = {}) {
  return {
    session_id: 's1',
    name: 'Test Session',
    ended: false,
    mtime_ms: 1000,
    agents: [],
    totals: { context: 1000, cache_write: 0, cache_read: 0, thinking: 0, writing: 0, tool_calls: 0, cost_usd: 1.5 },
    ...over,
  };
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

check('ended sessions are filtered out of the bar', () => {
  const out = strip(renderLine({ session_id: 's1' }, {
    updated_at: new Date().toISOString(),
    sessions: { s1: session(), s2: session({ session_id: 's2', name: 'Finished', ended: true }) },
  }));
  assert.ok(out.includes('Test Session'));
  assert.ok(!out.includes('Finished'), 'an ended session must not render');
});

check('the active session sorts first and shows its agent breakdown', () => {
  const out = strip(renderLine({ session_id: 's2' }, {
    updated_at: new Date().toISOString(),
    sessions: {
      s1: session({ mtime_ms: 9999 }),
      s2: session({ session_id: 's2', name: 'Mine', agents: [{ tokens: 1000, cost_usd: 0.5 }] }),
    },
  }));
  assert.ok(out.indexOf('Mine') < out.indexOf('Test Session'), 'active session leads even when older');
  assert.ok(out.includes('1k-0.5'), `active session renders its per-agent breakdown, got: ${out}`);
});

check('non-active sessions collapse to a count badge', () => {
  const out = strip(renderLine({ session_id: 's1' }, {
    updated_at: new Date().toISOString(),
    sessions: {
      s1: session(),
      s2: session({ session_id: 's2', name: 'Other', agents: [{ tokens: 1, cost_usd: 1 }, { tokens: 2, cost_usd: 2 }] }),
    },
  }));
  assert.ok(out.includes('2A'), 'other sessions show an agent count, not a list');
});

check('the grand total sums every visible session', () => {
  const out = strip(renderLine({ session_id: 's1' }, {
    updated_at: new Date().toISOString(),
    sessions: { s1: session({ totals: { ...session().totals, cost_usd: 1.25 } }), s2: session({ session_id: 's2', totals: { ...session().totals, cost_usd: 2.5 } }) },
  }));
  assert.ok(out.includes('$3.75'), `expected a $3.75 total in: ${out}`);
});

check('an empty session set renders a message, not a crash', () => {
  assert.ok(strip(renderLine({}, { updated_at: '', sessions: {} })).includes('no active sessions'));
});

check('number formatting drops the noise decimal above 10', () => {
  assert.strictEqual(fmtK(999), '999');
  assert.strictEqual(fmtK(1500), '1.5k');
  assert.strictEqual(fmtK(15000), '15k');
  assert.strictEqual(fmtK(1.5e6), '1.5M');
  assert.strictEqual(fmtK(150e6), '150M');
  assert.strictEqual(fmtCostShort(1.25), '$1.3');
  assert.strictEqual(fmtCostShort(42.7), '$43');
});

check('sameTopic ignores generic scaffolding words', () => {
  assert.ok(!sameTopic('Debugging Session Work', 'Project Setup Task'), 'only stopwords in common is not the same topic');
  assert.ok(sameTopic('Tagoto Exploration', 'Tagoto Experimentation Session'), 'a shared significant word is');
});

check('topicWords splits camelCase as well as separators', () => {
  assert.ok(topicWords('DebuggingWatcherCache').has('watcher'));
  assert.ok(topicWords('debugging-watcher-cache').has('watcher'));
});

check('sameTopic on an empty/unnamed side is not a match', () => {
  assert.ok(!sameTopic('', 'Anything At All'));
  assert.ok(!sameTopic(null, 'Anything At All'));
});

check('joinRecent always keeps the newest message', () => {
  const long = 'x'.repeat(10000);
  const out = joinRecent([long, 'the newest message']);
  assert.ok(out.includes('the newest message'), 'a long older message must not evict the newest');
});

check('joinRecent pulls older context in only up to the minimum', () => {
  assert.strictEqual(joinRecent(['short one', 'short two']).includes('short one'), true);
  assert.strictEqual(joinRecent([]), '');
});

// Only the branches that decide NOT to spawn. The spawning one belongs to
// test-lifecycle.js -- a unit test that launches a daemon leaves one behind
// when it fails.

const supervisor = require('./lib/supervisor');

function resetSupervisorState() {
  fs.mkdirSync(cfg.STATE_DIR, { recursive: true });
  for (const f of [supervisor.LOCK_FILE, supervisor.STAMP_FILE, supervisor.DISABLE_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {}
  }
}

check('supervisor reports a live lock holder as running', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.LOCK_FILE, String(process.pid));
  assert.strictEqual(supervisor.ensureWatcher(), 'running');
});

check('an observed running watcher clears a previous failure count', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.LOCK_FILE, String(process.pid));
  fs.writeFileSync(supervisor.STAMP_FILE, JSON.stringify({ at_ms: Date.now(), failures: 2 }));
  assert.strictEqual(supervisor.ensureWatcher(), 'running');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(supervisor.STAMP_FILE, 'utf8')), {});
});

check('the disable sentinel stops autostart without a spawn', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.DISABLE_FILE, 'paused');
  assert.strictEqual(supervisor.ensureWatcher(), 'disabled');
});

check('a recent spawn attempt holds off a retry', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.STAMP_FILE, JSON.stringify({ at_ms: Date.now(), failures: 0 }));
  assert.strictEqual(supervisor.ensureWatcher(), 'starting');
});

check('repeated failures stop the retry loop instead of spawning forever', () => {
  resetSupervisorState();
  fs.writeFileSync(
    supervisor.STAMP_FILE,
    JSON.stringify({ at_ms: Date.now(), failures: supervisor.MAX_CONSECUTIVE_FAILURES })
  );
  assert.strictEqual(supervisor.ensureWatcher(), 'failed');
});

check('a dead pid in the lock file does not count as a running watcher', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.LOCK_FILE, '999999');
  // Sentinel too, so no spawn can happen out of a unit test.
  fs.writeFileSync(supervisor.DISABLE_FILE, 'paused');
  assert.strictEqual(supervisor.ensureWatcher(), 'disabled');
  assert.strictEqual(supervisor.watcherPid(), null);
});

check('a corrupt lock file is treated as no watcher, not as a crash', () => {
  resetSupervisorState();
  fs.writeFileSync(supervisor.LOCK_FILE, 'not-a-pid');
  assert.strictEqual(supervisor.watcherPid(), null);
});

const { watcherMessage } = require('./statusline');

check('every supervisor state gets a distinguishable status line message', () => {
  const states = ['running', 'starting', 'cooldown', 'failed', 'disabled'];
  const seen = new Set(states.map((s) => watcherMessage(s)));
  assert.strictEqual(seen.size, states.length, `messages collapsed: ${[...seen].join(' | ')}`);
});

check('the failed state names the command that explains why', () => {
  assert.match(watcherMessage('failed'), /watcher\.js/);
});

// ------------------------------------------------------ activity signals --

const signals = require('./lib/signals');
const { buildActivity } = require('./watcher');
const { activityMark, ACTIVITY } = require('./statusline');

const MIN = 60 * 1000;

check('a published signal round-trips, session and agent separately', () => {
  signals.publish({ sessionId: 'sess-a', state: 'working', detail: 'running tests' });
  signals.publish({ sessionId: 'sess-a', agent: 'finder', state: 'done' });
  const all = signals.bySession();
  assert.strictEqual(all['sess-a'].state, 'working');
  assert.strictEqual(all['sess-a'].detail, 'running tests');
  assert.deepStrictEqual(
    all['sess-a'].agents.map((a) => [a.agent, a.state]),
    [['finder', 'done']]
  );
  signals.clear('sess-a');
  signals.clear('sess-a', 'finder');
});

check('an unknown state is refused at publish time', () => {
  assert.throws(() => signals.publish({ sessionId: 'x', state: 'nonsense' }), /unknown state/);
});

check('a claim name cannot escape the signal directory', () => {
  assert.throws(() => signals.fileFor('../../evil'), /unsafe session id/);
  assert.throws(() => signals.fileFor('ok', '../x'), /unsafe agent id/);
});

check('a signal past its TTL is not reported', () => {
  const old = new Date(Date.now() - cfg.SIGNAL_TTL_MS - MIN).toISOString();
  signals.publish({ sessionId: 'sess-old', state: 'done', at: old });
  assert.ok(!signals.bySession()['sess-old'], 'expected the stale signal to be dropped');
  signals.clear('sess-old');
});

check('prune drops signals for sessions the watcher no longer reports', () => {
  signals.publish({ sessionId: 'sess-keep', state: 'working' });
  signals.publish({ sessionId: 'sess-gone', state: 'working' });
  signals.prune(['sess-keep']);
  const all = signals.bySession();
  assert.ok(all['sess-keep'], 'live session should survive prune');
  assert.ok(!all['sess-gone'], 'orphaned session should be pruned');
  signals.clear('sess-keep');
});

check('an explicit signal wins over what the watcher would infer', () => {
  const a = buildActivity({ state: 'working', detail: 'busy', at: new Date().toISOString() }, [{}, {}], false, Date.now());
  assert.strictEqual(a.state, 'working');
  assert.strictEqual(a.source, 'signal');
});

check('running agents are inferred when nothing was published', () => {
  const a = buildActivity(undefined, [{}, {}], false, Date.now());
  assert.strictEqual(a.state, 'waiting_agents');
  assert.strictEqual(a.source, 'inferred');
  assert.match(a.detail, /2 agents/);
});

check('a session writing its transcript right now reads as working', () => {
  // The common case: another session that has never published anything must
  // still show as busy, or the bar says nothing about most of the machine.
  const a = buildActivity(undefined, [], false, Date.now() - 5000);
  assert.strictEqual(a.state, 'working');
  assert.strictEqual(a.source, 'inferred');
});

check('a session quiet longer than the window shows no activity', () => {
  const quiet = Date.now() - cfg.ACTIVITY_ACTIVE_WINDOW_MS - 5000;
  assert.strictEqual(buildActivity(undefined, [], false, quiet).state, null);
});

check('agents outrank plain writing when inferring', () => {
  assert.strictEqual(buildActivity(undefined, [{}], false, Date.now()).state, 'waiting_agents');
});

check('a signal is superseded once the transcript keeps growing past it', () => {
  // Publishing writes a tool call to the transcript, so the transcript is
  // always a beat newer than the signal; only a wide gap means "back at work".
  const at = new Date(Date.now() - 10 * MIN).toISOString();
  const justAfter = buildActivity({ state: 'done', at }, [], false, Date.parse(at) + 2000);
  assert.strictEqual(justAfter.state, 'done', 'a couple of seconds later is still done');

  const longAfter = buildActivity({ state: 'done', at }, [], false, Date.parse(at) + 5 * MIN);
  assert.strictEqual(longAfter.state, null, 'five minutes of further writing supersedes it');
});

check('an ended session reports ended, whatever it last published', () => {
  const a = buildActivity({ state: 'working', at: new Date().toISOString() }, [], true, Date.now());
  assert.strictEqual(a.state, 'ended');
});

check('every published state has a status line glyph', () => {
  for (const s of signals.STATES) {
    assert.ok(ACTIVITY[s], `no glyph for published state '${s}'`);
  }
});

check('an unrecognised state still renders, rather than vanishing', () => {
  const mark = activityMark({ state: 'deploying' });
  assert.ok(mark && mark.glyph, 'a future publisher state must not render as nothing');
  assert.strictEqual(activityMark({ state: null }), null);
  assert.strictEqual(activityMark(null), null);
});

check('activity glyphs are distinguishable from each other', () => {
  const glyphs = Object.entries(ACTIVITY)
    .filter(([k]) => k !== 'idle' && k !== 'ended')
    .map(([, v]) => v.glyph);
  assert.strictEqual(new Set(glyphs).size, glyphs.length, `glyphs collide: ${glyphs.join(' ')}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(stateTmp, { recursive: true, force: true });
fs.rmSync(signalTmp, { recursive: true, force: true });

const total = passed + failures.length;
if (failures.length) {
  console.error(`\ntoken-monitor-core: ${passed}/${total} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
console.log(`token-monitor-core: ${passed}/${total} checks passed`);
