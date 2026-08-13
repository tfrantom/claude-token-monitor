'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

// see README.md for what each setting does, CLAUDE.md for how they interact
module.exports = {
  PROJECTS_DIR: path.join(HOME, '.claude', 'projects'),

  STATUS_FILE: path.join(
    __dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'
  ),

  WORKSPACE_ROOTS: [
    path.join('C:', path.sep, 'projects'),
    path.join(HOME, 'projects'),
  ],

  // e.g. 'C:\\projects\\claude-token-monitor\\packages\\llama-local-server': 'llama-local-server'
  PROJECT_OVERRIDES: {},

  ASSUME_ENDED_WHEN_ABSENT: true,
};
