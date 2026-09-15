'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

/**
 * @param {{since?: number|null, project?: string|null}} [filter] `since` is
 *   compared against file mtime, so it bounds which files are opened rather
 *   than which turns are counted.
 * @returns {Array<{sessionId: string, project: string, path: string, mtimeMs: number}>}
 *   Empty when the transcripts directory is unreadable — indistinguishable
 *   from "none yet", which is acceptable here because the caller only reports.
 */
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
    } catch { }
    agents.push({
      path: path.join(dir, f),
      agent: id,
      agent_type: meta.agentType || null,
      agent_description: meta.description || null,
    });
  }
  return agents;
}

function loadStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.STATUS_FILE, 'utf8'));
    return raw && raw.sessions ? raw.sessions : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, object>} statusSessions
 * @param {string} sessionId
 * @returns {{name: string|null, ended: boolean|null, ended_source: string}}
 *   `ended: null` means unknown, which is not `false`. A session absent from
 *   `status.json` is only assumed ended when `ASSUME_ENDED_WHEN_ABSENT` says
 *   so, because absence also means "older than the watcher's window".
 */
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
