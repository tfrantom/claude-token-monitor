'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
// Claude Code's directories, not ours. The env overrides exist so the
// lifecycle logic can be tested against a fixture -- "no live sessions" is
// otherwise untestable from inside a live session.
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const STATE_DIR = process.env.TOKEN_MONITOR_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  PROJECTS_DIR,
  STATE_DIR,
  STATUS_FILE: path.join(STATE_DIR, 'status.json'),
  NAMES_CACHE_FILE: path.join(STATE_DIR, 'names-cache.json'),
  SEMANTIC_CACHE_FILE: path.join(STATE_DIR, 'semantic-cache.json'),

  // Logs render cadence and status.json staleness. Flip on if the bar ever
  // looks stale.
  STATUSLINE_TRACE: false,
  STATUSLINE_TRACE_FILE: path.join(STATE_DIR, 'statusline-trace.jsonl'),

  // Claude Code's process registry: one <pid>.json per live session, removed
  // on clean exit. Cross-checked against OS liveness in watcher.js, because a
  // transcript's mtime freezes at the last message either way.
  CLAUDE_SESSIONS_DIR: process.env.CLAUDE_SESSIONS_DIR || path.join(HOME, '.claude', 'sessions'),

  // Governs the data, not the bars: an ended session keeps its entry, flagged,
  // for this window so consumers can observe the transition. See CLAUDE.md.
  ACTIVE_SESSION_WINDOW_MS: 30 * 60 * 1000,
  POLL_INTERVAL_MS: 5000,

  // --- lifecycle -----------------------------------------------------------
  // How long with no live Claude Code session before the watcher exits and
  // stops the servers it manages. The grace period matters: zero sessions is a
  // normal reading *between* sessions, and tearing down on the first one costs
  // a cold model load for a few seconds of gap. 0 disables idle shutdown.
  IDLE_SHUTDOWN_MS: Number(process.env.TOKEN_MONITOR_IDLE_SHUTDOWN_MS ?? 2 * 60 * 1000),

  // TOKEN_MONITOR_NO_AUTOSTART=1 to run a watcher by hand instead.
  AUTOSTART_WATCHER: process.env.TOKEN_MONITOR_NO_AUTOSTART !== '1',

  // Machine-wide floor between spawn attempts. Without it, a watcher that
  // fails to start is retried ten times a second by every open session.
  WATCHER_SPAWN_COOLDOWN_MS: 10_000,

  // How long a subagent transcript may go unwritten before the agent counts as
  // finished. Liveness is write activity, not tool_result -- see CLAUDE.md.
  AGENT_ACTIVE_WINDOW_MS: 90 * 1000,

  // LLM-judged classification of thinking/tool_use blocks, layered over the
  // deterministic proration. False reproduces the pre-semantic shape exactly:
  // no LLM calls, and no `semantic` key at all, which consumers already handle.
  SEMANTIC_CLASSIFICATION_ENABLED: true,
  // Time-boxed, not count-boxed, so one tick cannot stall the poll loop.
  SEMANTIC_TIME_BUDGET_MS: 8000,
  SEMANTIC_RETRY_MS: 60 * 1000, // how long a failed classification stays "don't retry yet"

  // Rate-limit backstop only, so a burst of short messages cannot fire a model
  // call on every 5s tick. Not a delay on noticing a real topic change.
  RENAME_MIN_INTERVAL_MS: 15 * 1000,
  // Minimum new user text before a round trip is worth it. Small on purpose --
  // the model, not this number, decides whether the topic changed.
  RENAME_MIN_NEW_CHARS: 20,
  // A rolling window, not just the unseen messages: every check advances the
  // seen-counter, so re-sending the last few makes a bad answer self-correcting.
  RENAME_RECENT_MESSAGES: 3,
};
