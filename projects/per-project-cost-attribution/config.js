'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

module.exports = {
  // Same transcript source token-monitor-core watches. Read-only here.
  PROJECTS_DIR: path.join(HOME, '.claude', 'projects'),

  // token-monitor-core's live snapshot. Only ever read, never written, and
  // entirely optional -- it supplies the `ended` flag and the session's
  // display name when a session happens to be in the current active window.
  STATUS_FILE: path.join(
    __dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'
  ),

  // Directories whose *immediate children* are each considered a project.
  // This is what makes `C:\projects\claude-token-monitor\packages\
  // token-monitor-core` roll up to `claude-token-monitor` even though the
  // suite has no `.git` of its own. Deepest match wins over a shallower one
  // (see lib/project-map.js), so nesting these is safe.
  WORKSPACE_ROOTS: [
    path.join('C:', path.sep, 'projects'),
    path.join(HOME, 'projects'),
  ],

  // Explicit escape hatch, checked before any heuristic: longest matching
  // path prefix wins. Use it for anything the two heuristics get wrong
  // (vendored checkouts, a repo you deliberately want split, etc.).
  //   'C:\\projects\\claude-token-monitor\\packages\\llama-local-server': 'llama-local-server',
  PROJECT_OVERRIDES: {},

  // A session's cost is only final once the session is over. `ended` comes
  // from token-monitor-core's status.json; sessions absent from it are
  // assumed ended (they've fallen out of the 30-min active window).
  ASSUME_ENDED_WHEN_ABSENT: true,
};
