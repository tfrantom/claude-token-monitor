'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// Every transcript on disk, not just the currently-active ones. The watcher
// deliberately only looks at the last 30 minutes; attribution is a
// look-back question, so the default scope here is "all of history".
function findTranscripts({ since = null, project = null } = {}) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(cfg.PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    if (project && dirent.name !== project) continue;
    const dir = path.join(cfg.PROJECTS_DIR, dirent.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (since && stat.mtimeMs < since) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      out.push({
        sessionId,
        claudeProject: dirent.name,
        path: full,
        mtimeMs: stat.mtimeMs,
        agents: findSubagents(path.join(dir, sessionId)),
      });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// Sidechain transcripts live in `<projects>/<claude-project>/<session-id>/
// subagents/agent-*.jsonl`, each with an `agent-*.meta.json` naming the
// agent type and the task it was spawned for. They hold real API turns with
// their own `usage` and their own `cwd`, and nothing in token-monitor-core
// reads them.
function findSubagents(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const agents = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf8'));
    } catch { /* meta is a nicety, not a requirement */ }
    agents.push({
      path: path.join(dir, f),
      agent: id,
      agent_type: meta.agentType || null,
      agent_description: meta.description || null,
    });
  }
  return agents;
}

// token-monitor-core's live snapshot, read-only and optional. Supplies the
// `ended` flag (its PID-registry cross-reference is a far more reliable
// "this session's cost is final" signal than mtime staleness) plus the
// auto-generated session name, for sessions currently in the active window.
function loadStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.STATUS_FILE, 'utf8'));
    return raw && raw.sessions ? raw.sessions : {};
  } catch {
    return {};
  }
}

function sessionMeta(statusSessions, sessionId) {
  const s = statusSessions[sessionId];
  if (!s) {
    return {
      name: null,
      ended: cfg.ASSUME_ENDED_WHEN_ABSENT ? true : null,
      ended_source: cfg.ASSUME_ENDED_WHEN_ABSENT ? 'absent-from-status' : 'unknown',
    };
  }
  return {
    name: s.name || null,
    ended: s.ended === undefined ? null : s.ended,
    ended_source: s.ended === undefined ? 'unknown' : 'status.json',
  };
}

module.exports = { findTranscripts, findSubagents, loadStatus, sessionMeta };
