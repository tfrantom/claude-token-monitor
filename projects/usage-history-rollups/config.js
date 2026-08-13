'use strict';

const path = require('path');

const CORE_STATE_DIR = path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state');

const STATE_DIR = process.env.ROLLUP_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  // Read by path, never require()d across the package boundary. Overridable
  // so the test harness can point at a scratch fixture.
  STATUS_FILE: process.env.ROLLUP_STATUS_FILE || path.join(CORE_STATE_DIR, 'status.json'),

  STATE_DIR,
  HISTORY_FILE: path.join(STATE_DIR, 'history.jsonl'),
  LAST_SEEN_FILE: path.join(STATE_DIR, 'last-seen.json'),

  // On every line, so a reader can tell old entries from new without guessing
  // from which keys happen to be present. Bumped only on a breaking change.
  SCHEMA_VERSION: 1,

  // Independent of the watcher's own 5s tick, and much longer on purpose: an
  // ended session stays in status.json for 30 minutes, so there is no hurry.
  POLL_INTERVAL_MS: Number(process.env.ROLLUP_POLL_INTERVAL_MS) || 60 * 1000,

  // Consecutive polls a session must read `ended: true` before its final
  // snapshot is written. Guards the mass-false-positive mode where an
  // unreadable ~/.claude/sessions/ makes every session read as ended at once.
  ENDED_CONFIRM_POLLS: Number(process.env.ROLLUP_ENDED_CONFIRM_POLLS) || 2,

  // Not only a safety net: consecutive snapshots of the same session are what
  // let report.js compute per-period deltas, instead of dumping a whole
  // multi-hour session's cost onto whichever day it happened to end.
  PERIODIC_SNAPSHOT_MS: Number(process.env.ROLLUP_PERIODIC_SNAPSHOT_MS) || 60 * 60 * 1000,
};
