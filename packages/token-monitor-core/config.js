'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const STATE_DIR = process.env.TOKEN_MONITOR_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  PROJECTS_DIR,
  STATE_DIR,
  STATUS_FILE: path.join(STATE_DIR, 'status.json'),
  NAMES_CACHE_FILE: path.join(STATE_DIR, 'names-cache.json'),
  SEMANTIC_CACHE_FILE: path.join(STATE_DIR, 'semantic-cache.json'),

  STATUSLINE_TRACE: false,
  STATUSLINE_TRACE_FILE: path.join(STATE_DIR, 'statusline-trace.jsonl'),

  CLAUDE_SESSIONS_DIR: process.env.CLAUDE_SESSIONS_DIR || path.join(HOME, '.claude', 'sessions'),

  ACTIVE_SESSION_WINDOW_MS: 30 * 60 * 1000,
  POLL_INTERVAL_MS: 5000,

  IDLE_SHUTDOWN_MS: Number(process.env.TOKEN_MONITOR_IDLE_SHUTDOWN_MS ?? 2 * 60 * 1000),

  AUTOSTART_WATCHER: process.env.TOKEN_MONITOR_NO_AUTOSTART !== '1',

  WATCHER_SPAWN_COOLDOWN_MS: 10_000,

  AGENT_ACTIVE_WINDOW_MS: 90 * 1000,

  RECENT_WRITES_WINDOW_MS: 10 * 60 * 1000,

  SEMANTIC_CLASSIFICATION_ENABLED: true,
  SEMANTIC_TIME_BUDGET_MS: 8000,
  SEMANTIC_RETRY_MS: 60 * 1000,

  RENAME_MIN_INTERVAL_MS: 15 * 1000,
  RENAME_MIN_NEW_CHARS: 20,
  RENAME_RECENT_MESSAGES: 3,

  // Machine-level, not STATE_DIR: publishers are other sessions, installed
  // skill copies and separate repos, none of which can resolve a path into
  // this checkout. Same reasoning as llama-local-server's runtime dir.
  SIGNAL_DIR: process.env.TOKEN_MONITOR_SIGNAL_DIR || path.join(HOME, '.claude', 'token-monitor', 'signals'),
  SIGNAL_TTL_MS: Number(process.env.TOKEN_MONITOR_SIGNAL_TTL_MS ?? 60 * 60 * 1000),
  SIGNAL_SUPERSEDE_MS: Number(process.env.TOKEN_MONITOR_SIGNAL_SUPERSEDE_MS ?? 90 * 1000),

  // How recently a transcript must have been written for a session that has
  // published nothing to read as `working`. A heuristic, and the reason it is
  // not tighter: a long thinking block writes nothing for a while, so a short
  // window would flicker a busy session to idle. Hooks supersede this with the
  // real answer.
  ACTIVITY_ACTIVE_WINDOW_MS: Number(process.env.TOKEN_MONITOR_ACTIVITY_WINDOW_MS ?? 45 * 1000),
};
