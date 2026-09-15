#!/usr/bin/env node
'use strict';

// Runs outside the suite: require() nothing from it, hardcode no suite path.
// see CLAUDE.md "The installed copy must stay self-contained"

const fs = require('fs');
const path = require('path');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    console.log(`No config.json found at ${configPath} -- re-run install.ps1 from the suite's packages/token-usage-skill/ to regenerate it.`);
    process.exit(1);
  }
}

const { statusFile: STATUS_FILE, watcherCmd: WATCHER_CMD } = loadConfig();

// Mirrors token-monitor-core's STATUS_MAX_AGE_MS, which cannot be required
// from here -- see CLAUDE.md "The installed copy must stay self-contained".
const STATUS_MAX_AGE_MS = 60 * 1000;

function parseArgs(argv) {
  const args = { json: false, session: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--session') args.session = argv[++i];
    else if (argv[i] === '--project') args.project = argv[++i];
  }
  return args;
}

function sanitizeCwd(p) {
  return p.replace(/[:\\/]/g, '-');
}

function fmtK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtCost(n) {
  return `$${n.toFixed(2)}`;
}

function thinkingLine(t, sem) {
  const base = `thinking: ${fmtK(t.thinking)} (est.)`;
  const classified = sem ? (sem.thinking_productive || 0) + (sem.thinking_wasted || 0) : 0;
  if (classified < 1) return base;
  const pct = Math.round((sem.thinking_productive / classified) * 100);
  return `${base} — ${pct}% judged productive`;
}

function renderSession(s, label) {
  const t = s.totals;
  const total = t.context + t.cache_write + t.cache_read + t.thinking + t.writing + t.tool_calls;
  const lines = [
    `${label}${s.name}`,
    `  cost: ${fmtCost(t.cost_usd)}`,
    `  context+cache-read: ${fmtK(t.context + t.cache_read)}  cache-write: ${fmtK(t.cache_write)}`,
    `  ${thinkingLine(t, s.semantic)}  writing: ${fmtK(t.writing)} (est.)  tool-calls: ${fmtK(t.tool_calls)} (est.)`,
    `  total tokens: ~${fmtK(total)}`,
  ];
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = fs.readFileSync(STATUS_FILE, 'utf8');
  } catch {
    console.log(
      `No usage data available -- the watcher isn't running (or hasn't written its first snapshot yet).\nStart it with: ${WATCHER_CMD}`
    );
    process.exitCode = 1;
    return;
  }

  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    console.log('status.json exists but failed to parse -- the watcher may be mid-write. Try again in a moment.');
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const snapshotAge = Date.now() - Date.parse(status.updated_at || '');
  if (!(snapshotAge <= STATUS_MAX_AGE_MS)) {
    console.log(
      `Usage data is stale (last written ${status.updated_at || 'never'}) -- the watcher is not running, so these\n` +
        `numbers are a frozen snapshot, not live sessions.\nStart it with: ${WATCHER_CMD}`
    );
    process.exitCode = 1;
    return;
  }

  // Ended sessions linger in status.json for other consumers; every bar drops
  // them itself, and so must this. Counting them made "active session(s)" and
  // the total both wrong.
  const all = Object.values(status.sessions || {});
  const sessions = all.filter((s) => !s.ended);
  const endedCount = all.length - sessions.length;
  if (sessions.length === 0) {
    console.log(
      endedCount
        ? `Watcher is running; no active sessions right now (${endedCount} recently ended).`
        : 'Watcher is running but reports no active sessions right now.'
    );
    return;
  }

  const wantId = args.session || process.env.CLAUDE_CODE_SESSION_ID || null;
  const wantProject = args.project ? sanitizeCwd(args.project) : !wantId ? sanitizeCwd(process.cwd()) : null;

  sessions.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));

  const blocks = [];
  let grandTotal = 0;
  let matchedCurrent = false;
  for (const s of sessions) {
    grandTotal += s.totals.cost_usd;
    const isCurrent = !matchedCurrent && ((wantId && s.session_id === wantId) || (!wantId && wantProject && s.project === wantProject));
    if (isCurrent) matchedCurrent = true;
    blocks.push(renderSession(s, isCurrent ? '→ ' : '  '));
  }

  console.log(`Claude Code token usage (as of ${status.updated_at})\n`);
  console.log(blocks.join('\n\n'));
  console.log(`\nΣ total across ${sessions.length} active session(s): ${fmtCost(grandTotal)}`);
  if (endedCount) {
    console.log(`(${endedCount} recently-ended session(s) not counted — use --json to see them)`);
  }
  if (!matchedCurrent) {
    console.log('(none of these matched the current session/project -- shown by recency instead)');
  }
}

main();
