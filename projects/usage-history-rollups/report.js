'use strict';

// Reads history.jsonl and answers the question the whole project exists for:
// "how much did this cost over some window," which status.json alone can't
// answer because it's overwritten every tick with only the live 30 minutes.
//
// Usage:
//   node report.js              # last 7 days, daily buckets
//   node report.js --days 30
//   node report.js --by session # per-session totals instead of per-day
//   node report.js --json
//
// THE ONE THING TO GET RIGHT: entries are cumulative per session, not deltas.
// A session with three snapshots at $2 / $5 / $9 cost $9 total, not $16.
// Summing lines is the obvious wrong answer and this file is the reference
// implementation of the right one -- for a per-period view, each entry is
// differenced against that same session's previous entry, and the difference
// is attributed to the bucket the later entry falls in.

const cfg = require('./config');
const { readHistoryLines } = require('./poller');

const TOTAL_KEYS = ['context', 'cache_write', 'cache_read', 'thinking', 'writing', 'tool_calls', 'cost_usd'];

function parseArgs(argv) {
  const args = { days: 7, by: 'day', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--by') args.by = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function emptyTotals() {
  return Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0]));
}

function addInto(target, src) {
  for (const k of TOTAL_KEYS) target[k] += src[k] || 0;
}

// Differences each session's consecutive cumulative snapshots into per-entry
// deltas. The first snapshot of a session contributes its full cumulative
// total (everything before it was never observed, so it can only be
// attributed to the moment it was first seen). Deltas are clamped at zero:
// totals should only ever grow, but a transcript re-parse or a resumed
// session shouldn't be able to produce negative cost.
function toDeltas(entries) {
  const bySession = new Map();
  for (const e of entries) {
    if (!bySession.has(e.session_id)) bySession.set(e.session_id, []);
    bySession.get(e.session_id).push(e);
  }
  const deltas = [];
  for (const [sessionId, list] of bySession) {
    list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let prev = null;
    for (const e of list) {
      const d = emptyTotals();
      for (const k of TOTAL_KEYS) {
        const cur = (e.totals || {})[k] || 0;
        const before = prev ? (prev.totals || {})[k] || 0 : 0;
        d[k] = Math.max(cur - before, 0);
      }
      deltas.push({ ts: e.ts, session_id: sessionId, name: e.name, project: e.project, reason: e.reason, delta: d });
      prev = e;
    }
  }
  return deltas;
}

function fmtUsd(n) {
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = readHistoryLines(cfg.HISTORY_FILE);
  if (all.length === 0) {
    console.log(`No history yet at ${cfg.HISTORY_FILE}. Is poller.js running?`);
    return;
  }

  const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;
  // Deltas are computed over the FULL history, then filtered by window --
  // doing it the other way round would make the first in-window snapshot of
  // an older session dump its entire pre-window lifetime into the report.
  const deltas = toDeltas(all).filter((d) => Date.parse(d.ts) >= cutoff);

  const buckets = new Map();
  for (const d of deltas) {
    const key = args.by === 'session' ? `${d.session_id}` : d.ts.slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, { key, label: args.by === 'session' ? d.name : d.ts.slice(0, 10), totals: emptyTotals(), sessions: new Set() });
    const b = buckets.get(key);
    addInto(b.totals, d.delta);
    b.sessions.add(d.session_id);
  }

  const rows = [...buckets.values()].sort((a, b) => (args.by === 'session' ? b.totals.cost_usd - a.totals.cost_usd : a.key.localeCompare(b.key)));

  if (args.json) {
    console.log(JSON.stringify(rows.map((r) => ({ key: r.key, label: r.label, sessions: r.sessions.size, totals: r.totals })), null, 2));
    return;
  }

  const grand = emptyTotals();
  for (const r of rows) addInto(grand, r.totals);

  const w = args.by === 'session' ? 34 : 12;
  console.log(`\nUsage over the last ${args.days} day(s) — ${all.length} snapshot(s) in ${cfg.HISTORY_FILE}\n`);
  console.log(`${(args.by === 'session' ? 'session' : 'day').padEnd(w)} ${'cost'.padStart(9)} ${'thinking'.padStart(9)} ${'writing'.padStart(9)} ${'tools'.padStart(9)} ${'cache rd'.padStart(9)}`);
  console.log('-'.repeat(w + 50));
  for (const r of rows) {
    const label = String(r.label || r.key).slice(0, w);
    console.log(
      `${label.padEnd(w)} ${fmtUsd(r.totals.cost_usd).padStart(9)} ${fmtTokens(r.totals.thinking).padStart(9)} ${fmtTokens(r.totals.writing).padStart(9)} ${fmtTokens(r.totals.tool_calls).padStart(9)} ${fmtTokens(r.totals.cache_read).padStart(9)}`
    );
  }
  console.log('-'.repeat(w + 50));
  console.log(
    `${'TOTAL'.padEnd(w)} ${fmtUsd(grand.cost_usd).padStart(9)} ${fmtTokens(grand.thinking).padStart(9)} ${fmtTokens(grand.writing).padStart(9)} ${fmtTokens(grand.tool_calls).padStart(9)} ${fmtTokens(grand.cache_read).padStart(9)}\n`
  );
}

module.exports = { toDeltas, TOTAL_KEYS };

if (require.main === module) main();
