'use strict';

const os = require('os');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'state');

// see README.md for the settings table
module.exports = {
  STATUS_FILE: path.join(__dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'),

  STATE_DIR,
  NOTIFIED_FILE: path.join(STATE_DIR, 'notified.json'),

  NOTIFY_SCRIPT: path.join(os.homedir(), '.claude', 'bin', 'notify-done.ps1'),

  POLL_INTERVAL_MS: 5000,

  // Must stay ascending -- crossedTier() relies on it.
  COST_THRESHOLDS_USD: [10, 25, 50, 100],
};
