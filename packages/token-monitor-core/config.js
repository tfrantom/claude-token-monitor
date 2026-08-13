'use strict';

const os = require('os');
const path = require('path');

const HOME = os.homedir();
// Both locations are Claude Code's, not ours, and the env overrides exist so
// the lifecycle logic that reads them can be exercised against a fixture
// directory -- "no live sessions" is otherwise untestable from inside a live
// session, which is the only place this code ever runs.
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const STATE_DIR = process.env.TOKEN_MONITOR_STATE_DIR || path.join(__dirname, 'state');

module.exports = {
  PROJECTS_DIR,
  STATE_DIR,
  STATUS_FILE: path.join(STATE_DIR, 'status.json'),
  NAMES_CACHE_FILE: path.join(STATE_DIR, 'names-cache.json'),
  SEMANTIC_CACHE_FILE: path.join(STATE_DIR, 'semantic-cache.json'),

  // Diagnostic: logs one line per statusline invocation (render cadence +
  // how stale status.json was at render time). Left in, off by default --
  // it's the tool that diagnosed the "name lags a prompt" issue, which
  // turned out to be Claude Code's idle render behavior, not our data. Flip
  // to true if the bar ever looks stale again.
  STATUSLINE_TRACE: false,
  STATUSLINE_TRACE_FILE: path.join(STATE_DIR, 'statusline-trace.jsonl'),

  // Claude Code's own process registry: one <pid>.json per live interactive
  // session (sessionId, pid, status, ...), removed on clean exit. Cross-
  // referenced against actual OS process liveness in watcher.js to tell
  // "ended" apart from "just idle" -- a transcript's mtime alone can't do
  // that, since it freezes at the last message either way.
  CLAUDE_SESSIONS_DIR: process.env.CLAUDE_SESSIONS_DIR || path.join(HOME, '.claude', 'sessions'),

  // Sessions untouched longer than this drop out of status.json entirely.
  // Note this governs the *data*, not the bars: an ended session (see
  // CLAUDE_SESSIONS_DIR above) keeps its entry here, flagged `ended: true`,
  // for the rest of this window so downstream consumers can observe the
  // ended transition -- the statusline and nvim plugin filter ended sessions
  // out on their own, immediately, rather than the watcher dropping them
  // early and hiding the signal from everything else.
  ACTIVE_SESSION_WINDOW_MS: 30 * 60 * 1000,
  POLL_INTERVAL_MS: 5000,

  // --- lifecycle -----------------------------------------------------------
  // The watcher is started on demand by statusline.js (see lib/supervisor.js)
  // and stops itself once CLAUDE_SESSIONS_DIR reports no live session for this
  // long, taking the shared llama-server down with it. That closes the loop
  // the suite was missing: nothing had to be started by hand, and a ~2.5 GB
  // model no longer stays resident on the GPU after the last session closes.
  //
  // The grace period exists because "no live sessions" is a completely normal
  // reading *between* sessions -- closing one terminal and opening another,
  // or Claude Code restarting itself. Tearing down on the first zero would
  // mean paying a cold model load (~4s) for a gap of a few seconds. Two
  // minutes is long enough to cover that and short enough that a forgotten
  // session's VRAM comes back while you are still at the desk.
  // Set to 0 to disable idle shutdown and run the watcher until killed.
  IDLE_SHUTDOWN_MS: Number(process.env.TOKEN_MONITOR_IDLE_SHUTDOWN_MS ?? 2 * 60 * 1000),

  // Set TOKEN_MONITOR_NO_AUTOSTART=1 to stop the status line starting a
  // watcher -- the escape hatch for running one by hand in a terminal where
  // you can see its logs.
  AUTOSTART_WATCHER: process.env.TOKEN_MONITOR_NO_AUTOSTART !== '1',

  // The status line renders ~10x/second, and every render in every open
  // session asks "is the watcher alive?". The check itself is two syscalls, but
  // a *spawn* must not be: without this floor, a watcher that fails to start
  // would be retried ten times a second by every session at once. One attempt
  // per this many ms, machine-wide (the stamp file is shared).
  WATCHER_SPAWN_COOLDOWN_MS: 10_000,

  // How long a subagent transcript can go unwritten before we call the agent
  // finished. Liveness is measured by write activity because a background
  // agent tool_use is resolved immediately at launch -- see buildAgentList.
  // Generous enough to survive one slow model call without flickering off.
  AGENT_ACTIVE_WINDOW_MS: 90 * 1000,

  // Semantic (LLM-judged) classification of thinking/tool_use blocks, layered
  // on top of the deterministic proration — see
  // ../../projects/ (or lesson-sessions/token-classifier-demo/PLAN.md for the
  // original design doc). Flip to false to fall back to the pre-semantic-layer
  // behavior exactly: watcher.js skips the classifier entirely (no LLM calls,
  // no cache reads/writes) and status.json sessions carry no `semantic` key at
  // all, which statusline.js and the nvim plugin already render identically to
  // before that key existed.
  SEMANTIC_CLASSIFICATION_ENABLED: true,
  // Backfilling is time-boxed rather than count-boxed so one tick can never
  // stall the poll loop by more than this, no matter how many turns a fresh
  // session dumps in at once.
  SEMANTIC_TIME_BUDGET_MS: 8000,
  SEMANTIC_RETRY_MS: 60 * 1000, // how long a failed classification stays "don't retry yet"

  // Session renaming: no trigger word, no mode -- every tick does a cheap
  // local diff (any new user turns since the last check?) and only if that's
  // non-empty does it ask the model. The model itself decides whether the
  // topic actually changed (structured true/false, see checkNameChange in
  // lib/llm-client.js) rather than a word-count heuristic guessing at that.
  // RENAME_MIN_INTERVAL_MS is a pure rate-limit backstop -- it exists so a
  // burst of rapid-fire short messages can't fire a model call on every
  // single 5s poll tick, not to delay noticing a real change. This is local
  // inference on an otherwise-idle GPU, so the floor is "don't call more
  // often than roughly once per exchange," not cost -- 15s comfortably
  // covers that without ever being a visible delay.
  RENAME_MIN_INTERVAL_MS: 15 * 1000,
  // Minimum new user text (chars) since the last check before it's worth
  // spending a round trip on -- guards against asking the model to judge a
  // one-word reply that's overwhelmingly likely to be "no change". Small on
  // purpose; the model, not this number, is what should catch "did the user
  // actually change what they're doing".
  RENAME_MIN_NEW_CHARS: 20,
  // How many of the most recent user messages to re-name from. A rolling
  // window, not just the unseen ones: every check advances the seen-counter,
  // so naming off only-new text means one bad answer loses that topic change
  // permanently. Re-sending the last few makes a bad answer self-correcting.
  RENAME_RECENT_MESSAGES: 3,
};
