'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();

module.exports = {
  // Same transcript source token-monitor-core watches. Read-only here.
  PROJECTS_DIR: path.join(HOME, '.claude', 'projects'),

  // Read-only and optional: supplies the `ended` flag and display name for
  // sessions still inside the active window.
  STATUS_FILE: path.join(
    __dirname, '..', '..', 'packages', 'token-monitor-core', 'state', 'status.json'
  ),

  // Directories whose *immediate children* are each considered a project.
  // Deepest match wins over a shallower one (see lib/project-map.js), so
  // nesting these is safe.
  WORKSPACE_ROOTS: [
    path.join('C:', path.sep, 'projects'),
    path.join(HOME, 'projects'),
  ],

  // Explicit escape hatch, checked before any heuristic: longest matching
  // path prefix wins. Use it for anything the two heuristics get wrong
  // (vendored checkouts, a repo you deliberately want split, etc.).
  //   'C:\\projects\\claude-token-monitor\\packages\\llama-local-server': 'llama-local-server',
  PROJECT_OVERRIDES: {},

  // Sessions absent from status.json have fallen out of the 30-min active
  // window, so their cost is final.
  ASSUME_ENDED_WHEN_ABSENT: true,
};
