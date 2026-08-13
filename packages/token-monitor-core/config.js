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

  SEMANTIC_CLASSIFICATION_ENABLED: true,
  SEMANTIC_TIME_BUDGET_MS: 8000,
  SEMANTIC_RETRY_MS: 60 * 1000,

  RENAME_MIN_INTERVAL_MS: 15 * 1000,
  RENAME_MIN_NEW_CHARS: 20,
  RENAME_RECENT_MESSAGES: 3,
};
