'use strict';

// This project reads packages/token-monitor-core's output file *by path*,
// the same way statusline.js and the nvim plugin do -- no `require()` across
// the package boundary, and nothing under packages/ is imported or modified.
// See the suite root README's dependency-direction note.

const path = require('path');

const CORE_STATE_DIR = path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state');

const STATE_DIR = process.env.ROLLUP_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  // Overridable so the test harness can point at a scratch fixture instead of
  // the real watcher output -- nothing under packages/ has to be touched to
  // exercise this in isolation.
  STATUS_FILE: process.env.ROLLUP_STATUS_FILE || path.join(CORE_STATE_DIR, 'status.json'),

  STATE_DIR,
  HISTORY_FILE: path.join(STATE_DIR, 'history.jsonl'),
  LAST_SEEN_FILE: path.join(STATE_DIR, 'last-seen.json'),

  // Bumped only on a breaking change to the entry shape. Every line in
  // history.jsonl carries it so a reader can tell old entries from new
  // without guessing from which keys happen to be present.
  SCHEMA_VERSION: 1,

  // How often this poller reads status.json. Independent of, and deliberately
  // much longer than, the watcher's own 5s POLL_INTERVAL_MS. The `ended` flag
  // is the primary checkpoint and an ended session stays in status.json for
  // the rest of ACTIVE_SESSION_WINDOW_MS (30 min), so this has a ~30 minute
  // budget to notice a transition -- 60s is already two orders of magnitude
  // of headroom, and every read is a single small file parse.
  POLL_INTERVAL_MS: Number(process.env.ROLLUP_POLL_INTERVAL_MS) || 60 * 1000,

  // Consecutive polls a session must read `ended: true` before its final
  // snapshot is written. Guards the one documented mass-false-positive mode
  // in the watcher's ended detection: loadLiveSessionIds() returns an empty
  // set if ~/.claude/sessions/ is missing or unreadable, which makes *every*
  // session read as ended at once (see token-monitor-core's README, "if the
  // registry directory is missing entirely, every session reads as ended").
  // Requiring the signal to persist costs one extra poll of latency against
  // a 30-minute window, which is free, and turns a transient filesystem
  // hiccup from "bogus final snapshots for every live session" into a no-op.
  ENDED_CONFIRM_POLLS: Number(process.env.ROLLUP_ENDED_CONFIRM_POLLS) || 2,

  // Safety-net snapshot cadence for sessions that stay live a long time.
  // Not just a safety net: consecutive snapshots of the same session are what
  // let report.js compute real per-period deltas (a session's cumulative
  // total, differenced against its own previous snapshot) instead of dumping
  // a whole multi-hour session's cost onto whichever day it happened to end.
  PERIODIC_SNAPSHOT_MS: Number(process.env.ROLLUP_PERIODIC_SNAPSHOT_MS) || 60 * 60 * 1000,
};
