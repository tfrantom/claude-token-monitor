'use strict';

const path = require('path');

// TOKEN_MONITOR_STATE_DIR is mirrored, not require()d -- the arms-length rule
// stands, but reconstructing the default while ignoring the override left this
// reading a stale file at the old path while the watcher wrote to the new one.
const CORE_STATE_DIR =
  process.env.TOKEN_MONITOR_STATE_DIR || path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state');

const STATE_DIR = process.env.ROLLUP_STATE_DIR || path.join(__dirname, 'state');

// see README.md for the settings table, CLAUDE.md for why the defaults are these
module.exports = {
  STATUS_FILE: process.env.ROLLUP_STATUS_FILE || path.join(CORE_STATE_DIR, 'status.json'),

  STATE_DIR,
  HISTORY_FILE: path.join(STATE_DIR, 'history.jsonl'),
  LAST_SEEN_FILE: path.join(STATE_DIR, 'last-seen.json'),

  SCHEMA_VERSION: 1,

  POLL_INTERVAL_MS: Number(process.env.ROLLUP_POLL_INTERVAL_MS) || 60 * 1000,

  ENDED_CONFIRM_POLLS: Number(process.env.ROLLUP_ENDED_CONFIRM_POLLS) || 2,

  PERIODIC_SNAPSHOT_MS: Number(process.env.ROLLUP_PERIODIC_SNAPSHOT_MS) || 60 * 60 * 1000,
};
