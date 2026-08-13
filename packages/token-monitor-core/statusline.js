#!/usr/bin/env node
'use strict';

// Invoked on every render, so it must do no work beyond formatting -- see
// CLAUDE.md "The status line starts the watcher, and that budget is tiny".

const fs = require('fs');
const cfg = require('./config');
const { ensureWatcher } = require('./lib/supervisor');

function trace(fields) {
  if (!cfg.STATUSLINE_TRACE) return;
  try {
    fs.appendFileSync(cfg.STATUSLINE_TRACE_FILE, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n');
  } catch {}
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

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
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// Glyph before colour: the bar is read at a glance and across terminals that
// render 256-colour and dim differently, so shape has to carry the meaning on
// its own. Unknown states fall through to a neutral marker rather than being
// dropped, so a newer publisher's vocabulary still shows up on an older bar.
const ACTIVITY = {
  working: { glyph: '▶', color: CYAN },
  waiting_agents: { glyph: '⋯', color: CYAN },
  waiting_user: { glyph: '?', color: YELLOW },
  done: { glyph: '✓', color: GREEN },
  blocked: { glyph: '!', color: RED },
  idle: { glyph: '·', color: DIM },
  ended: { glyph: '·', color: DIM },
};

function activityMark(activity) {
  if (!activity || !activity.state) return null;
  return ACTIVITY[activity.state] || { glyph: '•', color: DIM };
}

function fmtCostShort(n) {
  return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`;
}

function totalTokens(t) {
  return t.context + t.cache_write + t.cache_read + t.thinking + t.writing + t.tool_calls;
}

function renderSession(s, isActive) {
  const t = s.totals;
  const agents = s.agents || [];
  const mark = activityMark(s.activity);

  // One glyph, one meaning, in both positions: the same session must not
  // render differently depending on whose bar it appears in. `●` used to be
  // the active-session marker AND the no-activity fallback, so a session
  // showed `●` in its own bar and nothing in everyone else's. The active
  // session is already identified by bold cyan and by being first.
  const dot = mark ? `${mark.color}${mark.glyph}${RESET} ` : '';

  if (isActive) {
    const parts = agents.map((a) => `${fmtK(a.tokens)}-${fmtCostShort(a.cost_usd).replace('$', '')}`);
    const agentStr = parts.length ? `${parts.join('/')} · ` : '';
    const detail = s.activity && s.activity.detail ? ` ${DIM}${s.activity.detail}${RESET}` : '';
    return (
      `${dot}${BOLD}${CYAN}${s.name}${RESET}${detail} ` +
      `${DIM}(${agentStr}${fmtK(totalTokens(t))}/${fmtCostShort(t.cost_usd)})${RESET}`
    );
  }

  const badge = agents.length ? `${DIM} ${agents.length}A${RESET}` : '';
  return `${dot}${DIM}${s.name}${RESET}${badge}${DIM} ${fmtCostShort(t.cost_usd)}${RESET}`;
}

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

// `statusOverride` is test-only -- see CLAUDE.md "Do not touch the live
// status.json in a test".
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

  // Ended sessions stay in status.json for other consumers, so filtering them
  // is the bar's job, not the watcher's.
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
  // An uncaught throw here is a stack trace ten times a second; one dim line is
  // the only acceptable failure mode.
  let line;
  try {
    const watcherState = ensureWatcher();
    line = renderLine(input, undefined, watcherState);
  } catch (err) {
    line = `${DIM}token-monitor: render failed (${err.message})${RESET}`;
  }
  process.stdout.write(line);
}

if (require.main === module) main();

module.exports = { renderLine, renderSession, fmtK, fmtCostShort, watcherMessage, activityMark, ACTIVITY };
