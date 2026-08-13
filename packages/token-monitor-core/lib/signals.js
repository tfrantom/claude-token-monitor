'use strict';

// Session and agent activity signals: what a session says it is doing, as
// opposed to what the watcher can infer from its transcript.
//
// See CLAUDE.md "Activity signals".

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const STATES = ['working', 'waiting_user', 'waiting_agents', 'done', 'blocked', 'idle'];

const DIR = cfg.SIGNAL_DIR;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

// One file per publisher, never one per session: a session and each of its
// subagents can publish concurrently, and a shared file would need a lock.
function fileFor(sessionId, agent) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
  if (agent != null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) throw new Error(`unsafe agent id: ${agent}`);
  return path.join(DIR, agent ? `${sessionId}.agent-${agent}.json` : `${sessionId}.json`);
}

function publish({ sessionId, agent = null, state, detail = null, pid = null, source = 'cli', at = null }) {
  if (!sessionId) throw new Error('publish() needs a sessionId');
  if (!STATES.includes(state)) {
    throw new Error(`unknown state '${state}'. Valid: ${STATES.join(', ')}`);
  }
  ensureDir();
  const file = fileFor(sessionId, agent);
  const record = {
    session_id: sessionId,
    agent,
    state,
    detail: detail ? String(detail).slice(0, 200) : null,
    pid: pid == null ? null : Number(pid),
    source,
    at: at || new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
  return record;
}

function clear(sessionId, agent = null) {
  try {
    fs.unlinkSync(fileFor(sessionId, agent));
    return true;
  } catch {
    return false;
  }
}

function readAll() {
  let files;
  try {
    files = fs.readdirSync(DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (rec && rec.session_id && rec.state) out.push(rec);
    } catch {
      /* a torn write is re-published on the publisher's next signal */
    }
  }
  return out;
}

function isFresh(rec, now) {
  const at = Date.parse(rec.at);
  return Number.isFinite(at) && now - at <= cfg.SIGNAL_TTL_MS;
}

// -> { '<session-id>': { state, detail, at, source, agents: [...] } }
//
// A stale signal is dropped rather than shown: "done" from three hours ago
// describes a session nobody is sitting at, and rendering it as current is
// worse than rendering nothing.
function bySession({ now = Date.now() } = {}) {
  const out = {};
  for (const rec of readAll()) {
    if (!isFresh(rec, now)) continue;
    const entry = (out[rec.session_id] ||= { state: null, detail: null, at: null, source: null, agents: [] });
    if (rec.agent) {
      entry.agents.push({ agent: rec.agent, state: rec.state, detail: rec.detail, at: rec.at });
      continue;
    }
    if (!entry.at || Date.parse(rec.at) >= Date.parse(entry.at)) {
      entry.state = rec.state;
      entry.detail = rec.detail;
      entry.at = rec.at;
      entry.source = rec.source;
    }
  }
  for (const entry of Object.values(out)) {
    entry.agents.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }
  return out;
}

// Drops signals whose session the watcher is no longer reporting, and anything
// past its TTL. Called by the watcher; safe from anywhere.
function prune(knownSessionIds, { now = Date.now() } = {}) {
  const known = knownSessionIds instanceof Set ? knownSessionIds : new Set(knownSessionIds || []);
  let removed = 0;
  let files;
  try {
    files = fs.readdirSync(DIR);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(DIR, f);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      /* unparseable: fall through to the mtime check below */
    }
    const stale = rec ? !isFresh(rec, now) : true;
    const orphaned = rec && rec.session_id ? !known.has(rec.session_id) : false;
    if (!stale && !orphaned) continue;
    try {
      fs.unlinkSync(full);
      removed += 1;
    } catch {
      /* raced with a republish */
    }
  }
  return removed;
}

module.exports = { STATES, DIR, publish, clear, readAll, bySession, prune, fileFor };
