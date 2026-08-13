'use strict';

// Offline checks: tier math, the dedup gate, -File quote safety, and a
// missing or mid-write status.json. Fires no notifications, needs no watcher.
//
//   node test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { crossedTier, shouldNotify, loadJson, safeName } = require('./monitor');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const TIERS = [10, 25, 50, 100];

// ── tier math ────────────────────────────────────────────────────────────
check('below lowest tier -> null', crossedTier(9.99, TIERS), null);
check('exactly on a tier counts as crossed', crossedTier(10, TIERS), 10);
check('between tiers -> lower one', crossedTier(24.99, TIERS), 10);
check('highest tier reached', crossedTier(101, TIERS), 100);
check('zero cost -> null', crossedTier(0, TIERS), null);

// ── the dedup gate ───────────────────────────────────────────────────────
check('first crossing fires', shouldNotify(10, undefined), true);
check('same tier again stays silent', shouldNotify(10, { tier: 10 }), false);
check('higher tier fires again', shouldNotify(25, { tier: 10 }), true);
check('lower tier than already notified stays silent', shouldNotify(10, { tier: 50 }), false);

// Cost climbs, then sits still for many ticks: one alert per tier genuinely
// crossed, not one per tick.
const costSequence = [
  0, 5, 9.99,                 // below any tier
  10.01, 11, 14, 18, 22, 24,  // crossed $10, then drifts under $25
  25.5, 26, 30, 40, 49,       // crossed $25, then drifts under $50
];
let entry;
const fired = [];
for (const cost of costSequence) {
  const tier = crossedTier(cost, TIERS);
  if (tier === null) continue;
  if (!shouldNotify(tier, entry)) continue;
  fired.push(tier);
  entry = { tier };
}
check('15 ticks spanning two crossings -> exactly 2 alerts', fired, [10, 25]);

// A tick that leaps several tiers produces one alert naming the highest tier
// reached, not one per skipped tier.
let jumpEntry;
const jumpFired = [];
for (const cost of [8, 60]) {
  const tier = crossedTier(cost, TIERS);
  if (tier === null) continue;
  if (!shouldNotify(tier, jumpEntry)) continue;
  jumpFired.push(tier);
  jumpEntry = { tier };
}
check('$8 -> $60 in one tick -> single $50 alert', jumpFired, [50]);

// ── message safety (regression: -File truncated on embedded quotes) ──────
check('spaces in a name survive', safeName('Project Setup'), 'Project Setup');
check('embedded double quotes stripped', safeName('the "big" refactor'), 'the big refactor');
check('backticks stripped', safeName('fix `foo`'), 'fix foo');
check('missing name falls back', safeName(null), '(unnamed session)');
check('whitespace-only name falls back', safeName('   '), '(unnamed session)');
check('a name that is only quotes falls back', safeName('""'), '(unnamed session)');

// ── resilience of the status.json read ───────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-alerts-test-'));
check('missing file -> fallback', loadJson(path.join(tmp, 'nope.json'), null), null);

const truncated = path.join(tmp, 'truncated.json');
fs.writeFileSync(truncated, '{"updated_at":"2026-08-06T00:00:00Z","sessi');
check('mid-write / truncated JSON -> fallback', loadJson(truncated, null), null);

const empty = path.join(tmp, 'empty.json');
fs.writeFileSync(empty, '');
check('empty file -> fallback', loadJson(empty, null), null);

const valid = path.join(tmp, 'valid.json');
fs.writeFileSync(valid, '{"sessions":{"abc":{"totals":{"cost_usd":12.5}}}}');
check('valid JSON still parses', loadJson(valid, null).sessions.abc.totals.cost_usd, 12.5);
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
