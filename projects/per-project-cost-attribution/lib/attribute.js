'use strict';

const fs = require('fs');
const path = require('path');
const { resolveProject } = require('./project-map');

// Pricing is the one piece deliberately NOT re-implemented here: a second
// copy of the rate table is a silent-drift bug waiting to happen. It is
// required read-only from token-monitor-core and never written to. If this
// project is ever extracted, vendoring lib/pricing.js is a file copy.
const { costForTurn } = require('../../../packages/token-monitor-core/lib/pricing');

// ---------------------------------------------------------------------------
// Independent transcript parse.
//
// This intentionally does NOT call token-monitor-core's classifySession():
// that function throws away the per-entry `cwd` this whole project is built
// on, and packages/ is read-only from here. The accounting below mirrors
// lib/transcript.js turn-for-turn (same usage-once-per-message.id rule, same
// inter-block wall-clock proration, same fallbacks) specifically so that the
// per-cwd slices produced here sum back to exactly the session totals
// status.json already reports -- verify.js asserts that equality against the
// real classifySession() output.
// ---------------------------------------------------------------------------

const TOTALS_KEYS = [
  'context', 'cache_write', 'cache_read',
  'thinking', 'writing', 'tool_calls',
  'cost_usd', 'unpriced_output_tokens', 'fast_unpriced_output_tokens',
];

function emptyTotals() {
  const t = {};
  for (const k of TOTALS_KEYS) t[k] = 0;
  return t;
}

function addTotals(into, from) {
  for (const k of TOTALS_KEYS) into[k] += from[k];
  return into;
}

function charLength(block) {
  switch (block.type) {
    case 'thinking': return (block.thinking || '').length;
    case 'text': return (block.text || '').length;
    case 'tool_use': return (block.name || '').length + JSON.stringify(block.input || {}).length;
    default: return JSON.stringify(block).length;
  }
}

function bucketFor(blockType) {
  if (blockType === 'thinking') return 'thinking';
  if (blockType === 'text') return 'writing';
  return 'tool_calls';
}

function timeDeltaWeights(turn) {
  const times = turn.blocks.map((b) => (b.ts ? Date.parse(b.ts) : NaN));
  if (times.some((t) => Number.isNaN(t))) return null;
  const start = turn.startTs ? Date.parse(turn.startTs) : NaN;
  const weights = times.map((t, i) => {
    const prev = i === 0 ? start : times[i - 1];
    if (Number.isNaN(prev)) return NaN;
    return Math.max(t - prev, 1);
  });
  if (weights.some((w) => Number.isNaN(w))) return null;
  return weights;
}

// Returns this single turn's totals, in the same shape as the session-wide
// ones. Attribution happens by adding this into whichever cwd bucket the
// turn belongs to instead of into one global accumulator.
function totalsForTurn(turn) {
  const totals = emptyTotals();
  const u = turn.usage;
  if (!u) return totals;

  const cacheCreation = u.cache_creation || {};
  // This is the suite's SECOND costForTurn() call site (the first is
  // finalizeTurn in token-monitor-core/lib/transcript.js). Both must feed it
  // the same inputs or the two disagree -- `speed` and `at_ms` are not
  // optional niceties: omitting `speed` under-reports a fast-mode turn by
  // half, and omitting `at_ms` skips any dated rate window entirely. That
  // exact drift is what verify.js's reconciliation check exists to catch, so
  // if you add an input there, add it here too.
  const priced = costForTurn({
    model: turn.model,
    speed: u.speed,
    at_ms: turn.startTs ? Date.parse(turn.startTs) : Date.now(),
    input_tokens: u.input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_5m: cacheCreation.ephemeral_5m_input_tokens || 0,
    cache_creation_1h: cacheCreation.ephemeral_1h_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
  });

  totals.context += u.input_tokens || 0;
  totals.cache_write += (cacheCreation.ephemeral_5m_input_tokens || 0) + (cacheCreation.ephemeral_1h_input_tokens || 0);
  totals.cache_read += u.cache_read_input_tokens || 0;
  totals.cost_usd += priced.cost;
  if (!priced.priced) totals.unpriced_output_tokens += u.output_tokens || 0;
  if (priced.fastUnpriced) totals.fast_unpriced_output_tokens += u.output_tokens || 0;

  const outputTokens = u.output_tokens || 0;
  if (outputTokens === 0 || turn.blocks.length === 0) return totals;

  let weights = timeDeltaWeights(turn);
  if (!weights) weights = turn.blocks.map((b) => charLength(b.block));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    totals.writing += outputTokens;
    return totals;
  }
  turn.blocks.forEach(({ block }, i) => {
    totals[bucketFor(block.type)] += (weights[i] / total) * outputTokens;
  });
  return totals;
}

function newSlice(cwd, agent) {
  return {
    cwd,
    agent: agent.agent,
    agent_type: agent.agent_type,
    agent_description: agent.agent_description,
    turns: 0,
    totals: emptyTotals(),
    first_activity: null,
    last_activity: null,
    models: new Set(),
  };
}

function touchSlice(slice, turn, totals) {
  slice.turns += 1;
  addTotals(slice.totals, totals);
  if (turn.model) slice.models.add(turn.model);
  const ts = turn.endTs || turn.startTs;
  if (ts) {
    if (!slice.first_activity || ts < slice.first_activity) slice.first_activity = ts;
    if (!slice.last_activity || ts > slice.last_activity) slice.last_activity = ts;
  }
}

// Parses one transcript file into per-cwd slices.
//
// `agent` identifies which transcript this is within a session: the main
// one, or one of the sidechain transcripts under
// `<session-id>/subagents/agent-*.jsonl`. Subagent turns are real API calls
// with their own `usage` and their own `cwd`, recorded nowhere in the parent
// transcript -- token-monitor-core's watcher never opens those files, so its
// per-session cost is main-transcript-only. Attribution counts them, tagged,
// because a Task-heavy session can spend most of its money in a cwd the main
// transcript never visits.
function parseTranscript(transcriptPath, agent = { agent: 'main', agent_type: null, agent_description: null }) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const slices = new Map(); // cwd (or '' for unattributed) -> slice
  const sessionTotals = emptyTotals();
  const modelsSeen = new Set();
  let turnCount = 0;
  let firstActivity = null;
  let lastTimestamp = null;
  // Per-turn cwd stability instrumentation -- the open question from the
  // brief. Counts turns (message.id groups) whose JSONL lines disagreed
  // about cwd, and the total number of cwd changes across the session.
  let turnsWithCwdConflict = 0;
  let cwdTransitions = 0;
  let prevEntryCwd = null;
  let lastSeenCwd = null; // carry-forward for entries that omit cwd

  let openTurn = null;
  const closeOpenTurn = () => {
    if (!openTurn) return;
    const totals = totalsForTurn(openTurn);
    addTotals(sessionTotals, totals);
    turnCount += 1;
    const key = openTurn.cwd || '';
    if (!slices.has(key)) slices.set(key, newSlice(openTurn.cwd || null, agent));
    touchSlice(slices.get(key), openTurn, totals);
    openTurn = null;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.cwd) {
      if (prevEntryCwd !== null && prevEntryCwd !== entry.cwd) cwdTransitions += 1;
      prevEntryCwd = entry.cwd;
      lastSeenCwd = entry.cwd;
    }

    const prevTimestamp = lastTimestamp;
    if (entry.timestamp) {
      lastTimestamp = entry.timestamp;
      if (!firstActivity) firstActivity = entry.timestamp;
    }

    if (entry.type === 'assistant' && entry.message) {
      const msgId = entry.message.id;
      if (!openTurn || openTurn.id !== msgId) {
        closeOpenTurn();
        openTurn = {
          id: msgId,
          model: entry.message.model,
          usage: entry.message.usage,
          startTs: prevTimestamp,
          endTs: entry.timestamp || null,
          // The turn's cwd is pinned by its FIRST line. Later lines of the
          // same message.id are only checked for disagreement (see below);
          // they never re-point the turn, so a turn is always attributed
          // whole and slices can never double-count it.
          cwd: entry.cwd || lastSeenCwd || null,
          blocks: [],
        };
        if (entry.message.model) modelsSeen.add(entry.message.model);
      } else {
        if (entry.cwd && openTurn.cwd && entry.cwd !== openTurn.cwd) turnsWithCwdConflict += 1;
        if (entry.timestamp) openTurn.endTs = entry.timestamp;
      }
      for (const block of entry.message.content || []) openTurn.blocks.push({ block, ts: entry.timestamp });
      continue;
    }

    closeOpenTurn();
  }
  closeOpenTurn();

  return {
    session_id: path.basename(transcriptPath).replace(/\.jsonl$/, ''),
    agent,
    transcript_path: transcriptPath,
    first_activity: firstActivity,
    last_activity: lastTimestamp,
    models: [...modelsSeen],
    totals: sessionTotals,
    turns: turnCount,
    slices: [...slices.values()],
    cwd_stability: {
      distinct_cwds: [...slices.keys()].filter(Boolean).length,
      transitions: cwdTransitions,
      turns_with_cwd_conflict: turnsWithCwdConflict,
    },
  };
}

// Groups a parse's per-cwd slices into per-project buckets, keeping the
// per-cwd detail nested underneath as `paths[]`.
// `parses` is the session's main transcript plus each of its subagent
// transcripts -- one session, several files. Totals are summed across all of
// them, so a session's cost here is legitimately higher than the same
// session's cost in status.json, which only ever sees the main file.
function attributeSession(parses, extra = {}) {
  const list = Array.isArray(parses) ? parses : [parses];
  const projects = new Map();
  const unattributed = { turns: 0, totals: emptyTotals() };
  const allSlices = list.flatMap((p) => p.slices);

  for (const slice of allSlices) {
    if (!slice.cwd) {
      unattributed.turns += slice.turns;
      addTotals(unattributed.totals, slice.totals);
      continue;
    }
    const r = resolveProject(slice.cwd);
    const key = `${r.project} ${r.project_root}`;
    if (!projects.has(key)) {
      projects.set(key, {
        project: r.project,
        project_root: r.project_root,
        resolver: r.resolver,
        turns: 0,
        totals: emptyTotals(),
        first_activity: null,
        last_activity: null,
        models: new Set(),
        paths: [],
      });
    }
    const p = projects.get(key);
    p.turns += slice.turns;
    addTotals(p.totals, slice.totals);
    for (const m of slice.models) p.models.add(m);
    if (slice.first_activity && (!p.first_activity || slice.first_activity < p.first_activity)) p.first_activity = slice.first_activity;
    if (slice.last_activity && (!p.last_activity || slice.last_activity > p.last_activity)) p.last_activity = slice.last_activity;
    p.paths.push({
      cwd: slice.cwd,
      subpath: r.subpath,
      agent: slice.agent,
      agent_type: slice.agent_type,
      agent_description: slice.agent_description,
      turns: slice.turns,
      totals: slice.totals,
      first_activity: slice.first_activity,
      last_activity: slice.last_activity,
      models: [...slice.models],
    });
  }

  const attribution = [...projects.values()]
    .map((p) => ({
      ...p,
      models: [...p.models],
      paths: p.paths.sort((a, b) => b.totals.cost_usd - a.totals.cost_usd),
    }))
    .sort((a, b) => b.totals.cost_usd - a.totals.cost_usd);

  const main = list.find((p) => p.agent && p.agent.agent === 'main') || list[0];
  const totals = emptyTotals();
  const models = new Set();
  let turns = 0;
  let firstActivity = null;
  let lastActivity = null;
  for (const p of list) {
    addTotals(totals, p.totals);
    turns += p.turns;
    for (const m of p.models) models.add(m);
    if (p.first_activity && (!firstActivity || p.first_activity < firstActivity)) firstActivity = p.first_activity;
    if (p.last_activity && (!lastActivity || p.last_activity > lastActivity)) lastActivity = p.last_activity;
  }

  return {
    session_id: main.session_id,
    claude_project: extra.claude_project || null,
    name: extra.name || null,
    ended: extra.ended === undefined ? null : extra.ended,
    transcript_path: main.transcript_path,
    agents: list.length,
    first_activity: firstActivity,
    last_activity: lastActivity,
    models: [...models],
    turns,
    totals,
    // Main-transcript-only totals, i.e. the number status.json reports for
    // this session. Kept so the two are directly comparable instead of
    // looking like a discrepancy.
    main_totals: main.totals,
    cwd_stability: {
      distinct_cwds: new Set(allSlices.map((s) => s.cwd).filter(Boolean)).size,
      transitions: list.reduce((n, p) => n + p.cwd_stability.transitions, 0),
      turns_with_cwd_conflict: list.reduce((n, p) => n + p.cwd_stability.turns_with_cwd_conflict, 0),
    },
    attribution,
    unattributed: unattributed.turns > 0 ? unattributed : null,
  };
}

module.exports = {
  parseTranscript,
  attributeSession,
  emptyTotals,
  addTotals,
  TOTALS_KEYS,
};
