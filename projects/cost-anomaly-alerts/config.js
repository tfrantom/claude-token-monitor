'use strict';

const os = require('os');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');

module.exports = {
  // Read-only feed produced by token-monitor-core's watcher.js -- this
  // project never writes here, never `require()`s anything from
  // packages/token-monitor-core, and treats the file as an opaque, possibly
  // stale or mid-write, JSON blob (see loadJson in monitor.js).
  STATUS_FILE: path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'),

  STATE_DIR,
  // This project's own state -- "highest cost tier already notified" per
  // session id. Lives here, not in packages/token-monitor-core/state/,
  // because it's this project's concern, not the watcher's.
  NOTIFIED_FILE: path.join(STATE_DIR, 'notified.json'),

  // bug-me-claude's notify-done entry point. Pre-approved, blocks until the
  // user dismisses the popup -- see fireNotification in monitor.js for why
  // that means it must be spawned detached, never awaited.
  NOTIFY_SCRIPT: path.join(os.homedir(), '.claude', 'bin', 'notify-done.ps1'),

  // How often to re-read status.json. status.json itself is only refreshed
  // every watcher.js tick (5s, see token-monitor-core/config.js), so there's
  // no benefit to polling faster than that; matching it keeps a cost crossing
  // noticed within one watcher tick.
  POLL_INTERVAL_MS: 5000,

  // Fixed tiers checked against cumulative session cost. Must stay in
  // ascending order -- crossedTier() in monitor.js relies on that. Extend or
  // edit freely; no other code needs to change to add/remove/move a tier.
  COST_THRESHOLDS_USD: [10, 25, 50, 100],
};
