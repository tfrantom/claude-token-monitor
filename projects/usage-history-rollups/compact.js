'use strict';

// Retention: rollup-then-truncate for history.jsonl.
//
// POLICY: for any UTC day older than --keep-days (default 7), keep only the
// LAST snapshot per session per day; drop the rest. Recent days are left
// completely untouched.
//
// Why last-per-session-per-day specifically: entries are cumulative, and
// report.js derives per-period numbers by differencing consecutive snapshots
// of the same session. Keeping the last snapshot of each day preserves that
// session's cumulative value at each day boundary exactly, so all daily and
// coarser totals stay bit-for-bit correct after compaction -- the only thing
// lost is sub-day resolution on data older than a week, which is precisely
// the resolution nobody asks for at that age. Dropping the *first* or an
// arbitrary entry instead would corrupt the differencing.
//
// Dry run by default. Pass --apply to actually rewrite the file.
//
//   node compact.js                    # show what would be dropped
//   node compact.js --apply
//   node compact.js --keep-days 30 --apply

const fs = require('fs');
const cfg = require('./config');
const { readHistoryLines } = require('./poller');

function parseArgs(argv) {
  const args = { keepDays: 7, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep-days') args.keepDays = Number(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
  }
  return args;
}

function compact(entries, cutoffMs) {
  const kept = [];
  // For old entries, index the last one per (session, UTC day). Entries are
  // appended in time order, so a later match simply overwrites an earlier one.
  const lastPerSessionDay = new Map();
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t) || t >= cutoffMs) {
      kept.push(e);
      continue;
    }
    lastPerSessionDay.set(`${e.session_id}|${e.ts.slice(0, 10)}`, e);
  }
  const rolled = [...lastPerSessionDay.values()];
  return [...rolled, ...kept].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries = readHistoryLines(cfg.HISTORY_FILE);
  if (entries.length === 0) {
    console.log(`Nothing to compact at ${cfg.HISTORY_FILE}.`);
    return;
  }
  const cutoff = Date.now() - args.keepDays * 24 * 60 * 60 * 1000;
  const result = compact(entries, cutoff);
  const dropped = entries.length - result.length;

  console.log(`${cfg.HISTORY_FILE}`);
  console.log(`  ${entries.length} entries -> ${result.length} (${dropped} rolled up, keeping full detail for the last ${args.keepDays} day(s))`);

  if (!args.apply) {
    console.log('  dry run — pass --apply to rewrite');
    return;
  }
  if (dropped === 0) {
    console.log('  nothing to do');
    return;
  }
  // Write via a temp file + rename so an interrupted compaction can never
  // leave a truncated history behind. The .bak is kept as a one-generation
  // undo, since this is the only operation in the project that deletes data.
  const tmp = `${cfg.HISTORY_FILE}.tmp`;
  fs.writeFileSync(tmp, result.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.copyFileSync(cfg.HISTORY_FILE, `${cfg.HISTORY_FILE}.bak`);
  fs.renameSync(tmp, cfg.HISTORY_FILE);
  console.log(`  rewritten (previous copy at ${cfg.HISTORY_FILE}.bak)`);
}

module.exports = { compact };

if (require.main === module) main();
