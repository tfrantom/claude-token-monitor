'use strict';

// Answers one question for the autonomous path: may a background process write
// this file right now? -- see CLAUDE.md "The autonomous path".

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

function readStatus(statusFile) {
  try {
    return JSON.parse(fs.readFileSync(statusFile || cfg.STATUS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function hasGitRecovery(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function norm(p) {
  return path.resolve(String(p || '')).toLowerCase();
}

// `recent_writes` is written by token-monitor-core's watcher. Absent on an
// older watcher, which downgrades this to the session-wide signal.
function lastWriteTo(status, filePath) {
  const target = norm(filePath);
  let newest = 0;
  let indexed = false;
  for (const session of Object.values(status.sessions || {})) {
    const writes = session.recent_writes;
    if (!Array.isArray(writes)) continue;
    indexed = true;
    for (const w of writes) {
      if (norm(w.path) !== target) continue;
      const at = Date.parse(w.at);
      if (Number.isFinite(at) && at > newest) newest = at;
    }
  }
  return { newest, indexed };
}

function newestActivity(status) {
  let newest = 0;
  for (const session of Object.values(status.sessions || {})) {
    if (session.ended) continue;
    const at = Date.parse(session.last_activity);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

/**
 * Whether it is safe to rewrite this file — nobody is mid-edit, and a mistake
 * would be recoverable.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.quiescentMs]
 * @param {boolean} [opts.requireGit] Only turn this off if losing the file is
 *   acceptable.
 * @returns {{ok: boolean, reason: string, signal: string}} Unknown is never
 *   `ok`: an unreadable status file, a missing repo and an active writer all
 *   refuse, because the default has to be the one that cannot corrupt a file
 *   someone is editing.
 */
function isQuiescent(filePath, opts = {}) {
  const now = opts.now ?? Date.now();
  const window = opts.quiescentMs ?? cfg.QUIESCENT_MS;

  if (opts.requireGit !== false && !hasGitRecovery(filePath)) {
    return { ok: false, reason: 'no git repository above this file — an unwanted delete would be unrecoverable', signal: 'git' };
  }

  const status = opts.status ?? readStatus(opts.statusFile);
  if (!status) {
    return { ok: false, reason: 'no status.json — cannot tell whether a session is mid-edit', signal: 'none' };
  }

  const stale = now - Date.parse(status.updated_at);
  if (!Number.isFinite(stale) || stale > 60_000) {
    return { ok: false, reason: 'status.json is stale — the watcher is not running', signal: 'none' };
  }

  const { newest, indexed } = lastWriteTo(status, filePath);
  if (indexed) {
    if (newest === 0) return { ok: true, reason: 'no session has written this file', signal: 'per-file' };
    const since = now - newest;
    if (since < window) {
      return { ok: false, reason: `a session wrote this file ${Math.round(since / 1000)}s ago`, signal: 'per-file' };
    }
    return { ok: true, reason: `last written ${Math.round(since / 1000)}s ago`, signal: 'per-file' };
  }

  const activity = newestActivity(status);
  if (activity === 0) return { ok: true, reason: 'no live session', signal: 'session-wide' };
  const idle = now - activity;
  if (idle < window) {
    return { ok: false, reason: `a session was active ${Math.round(idle / 1000)}s ago`, signal: 'session-wide' };
  }
  return { ok: true, reason: `all sessions idle for ${Math.round(idle / 1000)}s`, signal: 'session-wide' };
}

module.exports = { isQuiescent, hasGitRecovery, lastWriteTo, newestActivity };
