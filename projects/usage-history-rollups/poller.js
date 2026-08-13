'use strict';

// Standalone rollup poller. Reads token-monitor-core's status.json by path on
// its own cadence; nothing under packages/ is imported or modified.
//
// Three snapshot triggers:
//   1. `ended`    -- session read ended: true on ENDED_CONFIRM_POLLS
//                    consecutive polls. Written once per session lifetime.
//   2. `vanished` -- session left status.json without ever being finalized,
//                    using last-known totals. Covers the gaps `ended` can't.
//   3. `periodic` -- a still-live session every PERIODIC_SNAPSHOT_MS, so a
//                    long session gets a time-series rather than one lump.
//
// Run:  node poller.js
// Fast cadence for testing (never touches packages/):
//   ROLLUP_POLL_INTERVAL_MS=3000 ROLLUP_PERIODIC_SNAPSHOT_MS=10000 node poller.js

const fs = require('fs');
const cfg = require('./config');

fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function appendHistory(entry) {
  fs.appendFileSync(cfg.HISTORY_FILE, `${JSON.stringify(entry)}\n`);
}

function readHistoryLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn final line (killed mid-append) is the only way this happens.
      // Skipping it is strictly better than refusing to read the whole log.
    }
  }
  return entries;
}

// Returns null for anything unreadable, and the caller skips the poll. That
// distinction is load-bearing: "couldn't read status.json" must never be
// mistaken for "zero sessions are active", which would roll up every live
// session as vanished.
function readStatus() {
  let raw;
  try {
    raw = fs.readFileSync(cfg.STATUS_FILE, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.sessions || typeof parsed.sessions !== 'object') return null;
  return parsed;
}

// Cumulative, NOT a delta: `totals` is the session's lifetime total as of
// `ts`. Summing every line for a session multiply-counts it -- consumers take
// the latest line, or difference consecutive ones (see report.js).
function snapshotEntry(reason, sessionId, seen) {
  const s = seen.session;
  return {
    v: cfg.SCHEMA_VERSION,
    ts: new Date().toISOString(),
    reason, // 'ended' | 'vanished' | 'periodic'
    session_id: sessionId,
    project: s.project, // Claude Code's coarse per-terminal grouping, e.g. "C--projects"
    name: s.name,
    models: s.models,
    first_seen_at: seen.first_seen_at, // first poll this poller saw the session, not session start
    last_activity: s.last_activity, // last transcript timestamp, from the watcher
    totals: s.totals,
    semantic: s.semantic || null,
    // Join point for per-project-cost-attribution's finer repo/cwd dimension.
    // Null until status.json carries such a breakdown; null is a valid value
    // for the field, so older lines are not a schema break.
    by_project: s.by_project || null,
  };
}

// Per-session bookkeeping persisted to last-seen.json, so a poller restart
// doesn't lose in-flight state or re-append finals for sessions already
// rolled up.
function trackNew(session, now) {
  return {
    session: session,
    first_seen_at: new Date(now).toISOString(),
    last_snapshot_at: now,
    ended_polls: 0,
    finalized: false,
  };
}

function poll(state, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const status = readStatus();
  if (!status) return { state, wrote: [] }; // nothing trustworthy this poll -- skip, don't infer

  const current = status.sessions;
  const wrote = [];

  // Sessions that left status.json entirely. A fallback only: one that ended
  // cleanly was finalized below, ~30 minutes before it aged out.
  for (const sessionId of Object.keys(state)) {
    if (current[sessionId]) continue;
    if (!state[sessionId].finalized) {
      appendHistory(snapshotEntry('vanished', sessionId, state[sessionId]));
      wrote.push({ sessionId, reason: 'vanished' });
    }
    delete state[sessionId];
  }

  for (const [sessionId, session] of Object.entries(current)) {
    let seen = state[sessionId];
    if (!seen) {
      seen = state[sessionId] = trackNew(session, now);
    }
    seen.session = session;

    if (session.ended) {
      seen.ended_polls += 1;
      if (!seen.finalized && seen.ended_polls >= cfg.ENDED_CONFIRM_POLLS) {
        appendHistory(snapshotEntry('ended', sessionId, seen));
        wrote.push({ sessionId, reason: 'ended' });
        seen.finalized = true;
        seen.last_snapshot_at = now;
      }
      // No periodic sampling once finalized -- its totals can't change.
      continue;
    }

    // Live. A flicker must not accumulate toward the confirm threshold, and
    // `claude --resume` reuses the session id, so its continued cost deserves
    // a second final snapshot when it ends again.
    seen.ended_polls = 0;
    seen.finalized = false;

    if (now - seen.last_snapshot_at >= cfg.PERIODIC_SNAPSHOT_MS) {
      appendHistory(snapshotEntry('periodic', sessionId, seen));
      wrote.push({ sessionId, reason: 'periodic' });
      seen.last_snapshot_at = now;
    }
  }

  writeJsonAtomic(cfg.LAST_SEEN_FILE, state);
  return { state, wrote };
}

// Rebuilds "already finalized" from history.jsonl when last-seen.json is
// missing, so losing it while an ended session is still inside its 30-minute
// window doesn't append a duplicate final. A session seen live again clears
// the flag, so this can't suppress a resumed session's second end.
function seedFinalizedFromHistory(state) {
  const finalized = new Set();
  for (const e of readHistoryLines(cfg.HISTORY_FILE)) {
    if (e.reason === 'ended' && e.session_id) finalized.add(e.session_id);
  }
  for (const id of finalized) {
    if (!state[id]) continue;
    state[id].finalized = true;
  }
  return state;
}

function main() {
  let state = seedFinalizedFromHistory(loadJson(cfg.LAST_SEEN_FILE, {}));
  console.log(`[rollup] status  <- ${cfg.STATUS_FILE}`);
  console.log(`[rollup] history -> ${cfg.HISTORY_FILE}`);
  console.log(
    `[rollup] poll ${cfg.POLL_INTERVAL_MS}ms | ended confirm ${cfg.ENDED_CONFIRM_POLLS} polls | periodic ${cfg.PERIODIC_SNAPSHOT_MS}ms`
  );

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const loop = () => {
    try {
      const res = poll(state);
      state = res.state;
      for (const w of res.wrote) console.log(`[rollup] ${w.reason.padEnd(8)} ${w.sessionId}`);
    } catch (err) {
      console.error('[rollup] poll failed:', err.message);
    }
    setTimeout(loop, cfg.POLL_INTERVAL_MS);
  };
  loop();
}

module.exports = { poll, readStatus, readHistoryLines, seedFinalizedFromHistory };

if (require.main === module) main();
