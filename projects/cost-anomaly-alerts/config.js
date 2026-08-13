'use strict';

const os = require('os');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');

module.exports = {
  // Read-only feed produced by token-monitor-core's watcher.js, treated as an
  // opaque and possibly mid-write JSON blob (see loadJson in monitor.js).
  STATUS_FILE: path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'),

  STATE_DIR,
  // Highest cost tier already notified, per session id. This project's
  // concern, so it lives here rather than in the watcher's state dir.
  NOTIFIED_FILE: path.join(STATE_DIR, 'notified.json'),

  // bug-me-claude's notify-done entry point. Blocks until the popup is
  // dismissed -- see fireNotification in monitor.js.
  NOTIFY_SCRIPT: path.join(os.homedir(), '.claude', 'bin', 'notify-done.ps1'),

  // Matched to the watcher's own 5s tick; status.json changes no faster.
  POLL_INTERVAL_MS: 5000,

  // Must stay ascending -- crossedTier() in monitor.js relies on it. Nothing
  // else needs to change to add, remove, or move a tier.
  COST_THRESHOLDS_USD: [10, 25, 50, 100],
};
