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

/**
 * @returns {string} Claude Code's session JSON, or '' when nothing was piped —
 *   which is the normal case when run by hand.
 */
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {number} n
 * @returns {string} e.g. `938`, `12.4k`, `1.2M`.
 */
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

/**
 * @param {{state?: string}|null|undefined} activity
 * @returns {{glyph: string, color: string}|null} null when the session
 *   published no activity at all. An *unknown* state is not null — it gets the
 *   neutral marker, so a newer watcher's vocabulary still renders here.
 */
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

/**
 * @param {object} s One `status.json` session entry.
 * @param {boolean} isActive Whether this is the bar's own session, which gets
 *   the agent breakdown and the activity detail; every other session is
 *   rendered compactly.
 * @returns {string} SGR-coloured, single line.
 */
function renderSession(s, isActive) {
  const t = s.totals;
  const agents = s.agents || [];
  const mark = activityMark(s.activity);

  // One glyph, one meaning, in both positions -- see CLAUDE.md "What the
  // status line renders".
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

/**
 * @param {import('./lib/supervisor').WatcherState} [watcherState]
 * @returns {string} What to show when there is no snapshot to render.
 */
function watcherMessage(watcherState) {
  switch (watcherState) {
    case 'starting':
      return 'token-monitor: starting watcher…';
    case 'running':
      return 'token-monitor: waiting for the first snapshot…';
    case 'failed':
      return 'token-monitor: watcher failed to start (run `node watcher.js` to see why)';
    case 'disabled':
      return 'token-monitor: watcher not running (autostart disabled)';
    default:
      return 'token-monitor: watcher not running';
  }
}

/**
 * @param {object} status A parsed `status.json`.
 * @param {number} [now]
 * @returns {boolean} False for a snapshot no live watcher can have written,
 *   including one with no `updated_at` at all. Every session in a stale
 *   snapshot is unfalsifiable, not live — see CLAUDE.md "A snapshot is only as
 *   live as the watcher that wrote it".
 */
function isSnapshotFresh(status, now = Date.now()) {
  const at = Date.parse((status && status.updated_at) || '');
  return Number.isFinite(at) && now - at <= cfg.STATUS_MAX_AGE_MS;
}

/**
 * @param {{session_id?: string, sessionId?: string}} input Claude Code's piped
 *   session JSON. Its id decides which session sorts first and renders active.
 * @param {object} [statusOverride] Test-only -- see CLAUDE.md "Do not touch the
 *   live status.json in a test". Pass `undefined` to read the real file;
 *   passing an explicit object bypasses reading it, not the freshness gate.
 * @param {import('./lib/supervisor').WatcherState} [watcherState] Rendered
 *   instead of sessions when `status.json` cannot be read or is stale.
 * @returns {string} One line. Ended sessions are filtered here, not by the
 *   watcher, which keeps them for other consumers.
 */
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

  if (!isSnapshotFresh(status)) {
    return `${DIM}${watcherMessage(watcherState)}${RESET}`;
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

module.exports = { renderLine, renderSession, fmtK, fmtCostShort, watcherMessage, activityMark, isSnapshotFresh, ACTIVITY };
