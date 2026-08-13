'use strict';

// see CLAUDE.md "When it snapshots"

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
    } catch { }
  }
  return entries;
}

// null means "skip this poll" -- see CLAUDE.md "Unreadable is not no sessions"
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

// Cumulative, NOT a delta -- see CLAUDE.md "Entries are cumulative, not deltas"
function snapshotEntry(reason, sessionId, seen) {
  const s = seen.session;
  return {
    v: cfg.SCHEMA_VERSION,
    ts: new Date().toISOString(),
    reason,
    session_id: sessionId,
    project: s.project,
    name: s.name,
    models: s.models,
    first_seen_at: seen.first_seen_at,
    last_activity: s.last_activity,
    totals: s.totals,
    semantic: s.semantic || null,
    by_project: s.by_project || null,
  };
}

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
  if (!status) return { state, wrote: [] };

  const current = status.sessions;
  const wrote = [];

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
      continue;
    }

    // A flicker must not accumulate toward the confirm threshold; a resume must re-finalize.
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
