'use strict';

// Standalone rollup poller for token-monitor-core's status.json.
//
// Deliberately NOT a hook inside packages/token-monitor-core/watcher.js: this
// process reads status.json by path on its own cadence, the same
// arms-length way statusline.js and the nvim plugin consume it. Nothing under
// packages/ is imported or modified.
//
// WHEN TO SNAPSHOT -- resolved. The original brief proposed diffing
// consecutive ticks' session sets to synthesize a "session ended" signal.
// That is no longer the best available signal: the watcher now publishes
// `ended: true` per session, derived from cross-checking Claude Code's own
// ~/.claude/sessions/<pid>.json registry against live PIDs, and deliberately
// keeps ended sessions in status.json for the rest of the 30-minute window so
// a consumer like this one can see the transition. That is a true "the user
// closed this session" edge, not "the transcript went quiet for a while,"
// and it does not depend on this poller having observed the immediately
// preceding tick. So:
//
//   1. `ended` (primary)   -- session read ended: true on ENDED_CONFIRM_POLLS
//                             consecutive polls. The real end-of-session
//                             checkpoint. Written once per session lifetime.
//   2. `vanished` (fallback) -- session left status.json entirely without ever
//                             being finalized. Covers the gaps `ended` can't:
//                             poller was down across the whole 30-min window,
//                             or the session aged out while the registry was
//                             unreadable. Uses last-known totals.
//   3. `periodic` (sampling) -- a still-live session every PERIODIC_SNAPSHOT_MS.
//                             Gives long sessions a real time-series instead
//                             of one lump attributed to the day they ended.
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

// Reads status.json defensively. The watcher writes it atomically (tmp +
// rename) so a torn read shouldn't happen, but the file may not exist yet
// (poller started before the watcher's first tick), or the watcher may be
// mid-restart, or not running at all. All of those return null and the caller
// skips the poll entirely. This distinction is load-bearing: "couldn't read
// status.json" must never be mistaken for "zero sessions are active," which
// would roll up every live session as vanished.
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

// One append-only line. Cumulative, NOT a delta: `totals` is the session's
// lifetime total as of `ts`, exactly the shape lib/transcript.js already
// produces. Summing every line for a session would multiply-count it --
// consumers take the latest line per session, or difference consecutive
// lines to get a per-period delta (see report.js).
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
    // The join point for per-project-cost-attribution. That project adds a
    // finer repo/cwd dimension alongside the coarse `project` above; when it
    // lands a breakdown on the session object in status.json, it appears here
    // automatically with no change to this file and no reprocessing of lines
    // already written (older lines carry null, which is a valid value for
    // this field rather than a schema break). Deliberately a nested object
    // rather than extra top-level keys, so the two dimensions -- time (one
    // line per snapshot) and project (this field) -- compose instead of
    // fighting over the same namespace.
    by_project: s.by_project || null,
  };
}

// Per-session bookkeeping carried across polls and persisted to
// last-seen.json, so a poller restart doesn't lose the in-flight state or
// re-append finals for sessions already rolled up.
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

  // 1. Sessions that left status.json entirely. Only a fallback now: a
  //    session that ended cleanly was already finalized by the `ended` branch
  //    below, ~30 minutes before it aged out of the window.
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
      // Confirmed-ended and not yet written: this is the checkpoint.
      if (!seen.finalized && seen.ended_polls >= cfg.ENDED_CONFIRM_POLLS) {
        appendHistory(snapshotEntry('ended', sessionId, seen));
        wrote.push({ sessionId, reason: 'ended' });
        seen.finalized = true;
        seen.last_snapshot_at = now;
      }
      // A finalized session just sits in status.json until it ages out. No
      // periodic sampling for it -- its totals can't change anymore.
      continue;
    }

    // Live. Reset the ended counter (a flicker shouldn't accumulate toward
    // the confirm threshold) and clear `finalized` -- a session can genuinely
    // come back via `claude --resume`, which reuses the session id under a
    // new PID, and its continued cost deserves a second final snapshot when
    // it ends again.
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
// missing or stale. Without this, deleting last-seen.json while an ended
// session is still inside its 30-minute window would append a duplicate
// final for it. A session seen live again clears the flag on the first poll
// (see above), so this can't wrongly suppress a resumed session's second end.
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
