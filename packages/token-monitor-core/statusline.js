#!/usr/bin/env node
'use strict';

// Invoked by Claude Code's statusLine hook on every render: reads the file the
// watcher wrote and formats it, and starts the watcher when none is running.
// It must do no other work — see CLAUDE.md "The status line starts the
// watcher, and that budget is tiny".

const fs = require('fs');
const cfg = require('./config');
const { ensureWatcher } = require('./lib/supervisor');

// One line per invocation, off by default. Wrapped because diagnostics must
// never break rendering.
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

// Drops a trailing ".0" -- the line is space-constrained.
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

// The percentage annotates the thinking total; it does not replace it. With
// nothing classified yet, fall back to the plain number rather than show a
// misleading 0%.
function renderThinking(thinkingTotal, sem) {
  const classified = sem ? sem.thinking_productive + sem.thinking_wasted : 0;
  if (classified < 1) return `thk ${fmtK(thinkingTotal)}`;
  const pct = Math.round((sem.thinking_productive / classified) * 100);
  return `thk ${fmtK(thinkingTotal)} (${pct}%p)`;
}

function fmtCostShort(n) {
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`;
}

function totalTokens(t) {
  return t.context + t.cache_write + t.cache_read + t.thinking + t.writing + t.tool_calls;
}

// Only the active session gets the per-agent breakdown; otherwise N terminal
// tabs each render N agent lists and the line is unusable.
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

  const badge = agents.length ? `${DIM} ${agents.length}A${RESET}` : ''; // "3A" == three running agents
  return `${DIM}${s.name}${RESET}${badge}${DIM} ${fmtCostShort(t.cost_usd)}${RESET}`;
}

// What to show before the watcher has ever written a status.json. Each state
// must read differently: a user has to be able to tell "coming up in a second"
// from "broken, go look".
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

// Returns the line rather than printing it, so another statusLine entry point
// can delegate here without a second node startup. `statusOverride` is for
// tests only -- see CLAUDE.md "Do not touch the live status.json in a test".
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

  // The watcher keeps ended sessions in status.json for other consumers, so
  // the bar has to filter them here rather than upstream.
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
  // status.json is written by a process that upgrades independently of this
  // one, and an uncaught throw here is a stack trace ten times a second. One
  // dim line is the only acceptable failure mode.
  let line;
  try {
    const watcherState = ensureWatcher();
    line = renderLine(input, undefined, watcherState);
  } catch (err) {
    line = `${DIM}token-monitor: render failed (${err.message})${RESET}`;
  }
  process.stdout.write(line);
}

// Script only, so tests can require the renderer.
if (require.main === module) main();

module.exports = { renderLine, renderSession, fmtK, fmtCostShort, watcherMessage };
