'use strict';

// Keeps the LAST snapshot per session per day, never the first -- see
// CLAUDE.md "Retention".
//
//   node compact.js [--keep-days 30] [--apply]

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
  // Entries arrive in time order, so a later match overwrites an earlier one.
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
  const tmp = `${cfg.HISTORY_FILE}.tmp`;
  fs.writeFileSync(tmp, result.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.copyFileSync(cfg.HISTORY_FILE, `${cfg.HISTORY_FILE}.bak`);
  fs.renameSync(tmp, cfg.HISTORY_FILE);
  console.log(`  rewritten (previous copy at ${cfg.HISTORY_FILE}.bak)`);
}

module.exports = { compact };

if (require.main === module) main();
