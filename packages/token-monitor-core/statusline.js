#!/usr/bin/env node
'use strict';

// Invoked by Claude Code's statusLine hook on every render. Must be fast and
// must never do real work itself (no parsing transcripts, no LLM calls) —
// it only reads the file the watcher already wrote and formats it.
//
// The one exception is supervision: because Claude Code guarantees to invoke
// this on every render of every session, it is also the suite's liveness
// signal, and it starts the watcher when none is running (see
// lib/supervisor.js — two syscalls on the happy path, and it never touches
// llama.cpp itself). That is what makes opening a Claude Code session
// sufficient to bring the whole thing up.

const fs = require('fs');
const cfg = require('./config');
const { ensureWatcher } = require('./lib/supervisor');

// TEMPORARY DIAGNOSTIC (cfg.STATUSLINE_TRACE, default off). Records one line
// per invocation so we can see Claude Code's actual render cadence -- in
// particular whether it keeps re-rendering while idle or stops until the next
// prompt. Wrapped so a trace failure can never break the status line itself.
function trace(fields) {
  if (!cfg.STATUSLINE_TRACE) return;
  try {
    fs.appendFileSync(cfg.STATUSLINE_TRACE_FILE, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n');
  } catch {
    /* diagnostics must never break rendering */
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Drops a trailing ".0" -- on a space-constrained line "150M" beats "150.0M",
// and one decimal is only meaningful below ~10 of a unit anyway.
function fmtK(n) {
  const scale = (v, suffix) => `${v >= 10 ? Math.round(v) : Number(v.toFixed(1))}${suffix}`;
  if (n >= 1e6) return scale(n / 1e6, 'M');
  if (n >= 1000) return scale(n / 1000, 'k');
  return String(Math.round(n));
}

function fmtCost(n) {
  return `$${n.toFixed(2)}`;
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// Semantic layer only ever annotates the thinking bucket's existing total —
// see token-classifier-demo/PLAN.md §4 — so a session with no classified
// turns yet (cold start, or llama-server unreachable) just falls back to the
// plain number instead of showing a misleading 0%.
function renderThinking(thinkingTotal, sem) {
  const classified = sem ? sem.thinking_productive + sem.thinking_wasted : 0;
  if (classified < 1) return `thk ${fmtK(thinkingTotal)}`;
  const pct = Math.round((sem.thinking_productive / classified) * 100);
  return `thk ${fmtK(thinkingTotal)} (${pct}%p)`;
}

// Cost without the trailing cents noise -- the line is space-constrained and
// nobody is reading agent spend to the penny.
function fmtCostShort(n) {
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`;
}

function totalTokens(t) {
  return t.context + t.cache_write + t.cache_read + t.thinking + t.writing + t.tool_calls;
}

// Only the session this status line belongs to gets the per-agent breakdown;
// every other session collapses to a count badge. Detail where you're
// looking, glanceable everywhere else -- otherwise N terminal tabs each
// render N agent lists and the line is unusable.
function renderSession(s, isActive) {
  const t = s.totals;
  const agents = s.agents || [];

  if (isActive) {
    const parts = agents.map((a) => `${fmtK(a.tokens)}-${fmtCostShort(a.cost_usd).replace('$', '')}`);
    const agentStr = parts.length ? `${parts.join('/')} · ` : '';
    return (
      `${BOLD}${CYAN}● ${s.name}${RESET} ` +
      `${DIM}(${agentStr}${fmtK(totalTokens(t))}/${fmtCostShort(t.cost_usd)})${RESET}`
    );
  }

  // "3A" = three agents running under that session, without listing them.
  const badge = agents.length ? `${DIM} ${agents.length}A${RESET}` : '';
  return `${DIM}${s.name}${RESET}${badge}${DIM} ${fmtCostShort(t.cost_usd)}${RESET}`;
}

// Returns the rendered line rather than printing it, so another statusLine
// entry point can delegate here without paying a second node startup --
// Claude Code already re-invokes this ~10x/second (measured: ~102ms median).
// `statusOverride` exists for tests only: renderLine otherwise reads the live
// status.json, which the watcher is actively rewriting every 5s -- exercising
// the renderer against fixtures would mean either racing it or swapping the
// real file out from under a running daemon. Production callers pass one arg.
// What to show before the watcher has ever written a status.json. On a fresh
// install this is the first thing a user sees, and "watcher not running" was
// a dead end — it stated a fact and left them to find the command. Now the
// supervisor is already fixing it, so the line reports which of those states
// it is actually in.
function watcherMessage(watcherState) {
  switch (watcherState) {
    case 'starting':
      return 'token-monitor: starting watcher…';
    case 'cooldown':
      return 'token-monitor: waiting for watcher…';
    case 'failed':
      return 'token-monitor: watcher failed to start (run `node watcher.js` to see why)';
    case 'disabled':
      return 'token-monitor: watcher not running (autostart disabled)';
    default:
      return 'token-monitor: watcher not running';
  }
}

function renderLine(input, statusOverride, watcherState) {
  const activeId = input.session_id || input.sessionId || null;

  let status;
  if (statusOverride !== undefined) {
    status = statusOverride;
  } else {
    try {
      status = JSON.parse(fs.readFileSync(cfg.STATUS_FILE, 'utf8'));
    } catch {
      return `${DIM}${watcherMessage(watcherState)}${RESET}`;
    }
  }

  // Ended sessions are dropped from the bar the moment they're detected --
  // the watcher deliberately keeps them in status.json (flagged `ended`) for
  // other consumers, so the filtering has to happen here, not upstream.
  const sessions = Object.values(status.sessions || {})
    .filter((s) => !s.ended)
    .sort((a, b) => {
      if (a.session_id === activeId) return -1;
      if (b.session_id === activeId) return 1;
      return (b.mtime_ms || 0) - (a.mtime_ms || 0);
    });

  if (sessions.length === 0) {
    return `${DIM}token-monitor: no active sessions${RESET}`;
  }

  // Captures what the bar *would* show for the active session vs. what the
  // watcher had already written -- if these ever disagree, the lag is in the
  // render cadence, not in the data.
  const active = sessions.find((s) => s.session_id === activeId);
  trace({
    active_name: active ? active.name : null,
    status_updated_at: status.updated_at,
    status_age_ms: status.updated_at ? Date.now() - Date.parse(status.updated_at) : null,
  });

  const grandTotal = sessions.reduce((sum, s) => sum + s.totals.cost_usd, 0);
  const parts = sessions.map((s) => renderSession(s, s.session_id === activeId));
  parts.push(`${DIM}Σ ${fmtCost(grandTotal)}${RESET}`);
  return parts.join(`${DIM} │ ${RESET}`);
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  // renderLine already handles "no status.json" and "no sessions", but it
  // still walks a JSON structure written by a separate process that upgrades
  // independently of this one. A watcher running newer code that renames or
  // drops a key would otherwise throw here -- and an uncaught throw in a
  // statusLine command is not a quiet failure: Claude Code surfaces the
  // stack, on every render, ~10x/second. Degrading to one dim line is the
  // only acceptable failure mode for something on screen this often.
  // Before rendering, not after: on a cold start this is what causes there to
  // be anything to render at all. ensureWatcher() is documented never to
  // throw, and is inside the try regardless -- nothing in this file is allowed
  // to turn a render into a stack trace.
  let line;
  try {
    const watcherState = ensureWatcher();
    line = renderLine(input, undefined, watcherState);
  } catch (err) {
    line = `${DIM}token-monitor: render failed (${err.message})${RESET}`;
  }
  process.stdout.write(line);
}

// Only run when invoked as a script -- being require()-able lets the
// renderer be exercised against fixtures without swapping the live
// status.json out from under the watcher (which is actively writing it).
if (require.main === module) main();

module.exports = { renderLine, renderSession, fmtK, fmtCostShort, watcherMessage };
