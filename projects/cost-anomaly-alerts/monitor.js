'use strict';

// cost-anomaly-alerts: a standalone daemon, deliberately not folded into
// token-monitor-core/watcher.js. It only ever reads status.json (never the
// raw transcripts, never anything under packages/) and only ever calls
// bug-me-claude's notify-done.ps1 -- see the project README for why this is
// a separate process.

const fs = require('fs');
const { spawn } = require('child_process');
const cfg = require('./config');

fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing file, truncated/mid-write JSON (e.g. watcher.js's
    // writeJsonAtomic caught between the tmp-write and the rename), or any
    // other read error -- all treated the same: skip this tick, the file
    // will be readable again on the next poll.
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Highest configured tier that `cost` has reached, or null if it hasn't
// crossed the lowest one yet. cfg.COST_THRESHOLDS_USD must be ascending.
function crossedTier(cost, thresholds) {
  let tier = null;
  for (const t of thresholds) {
    if (cost >= t) tier = t;
    else break;
  }
  return tier;
}

// Fire-and-forget by design: notify-done.ps1 blocks its own process until the
// user dismisses the popup. Nothing here awaits it, so a popup left sitting
// unread never stalls the poll loop -- the next tick runs on schedule.
//
// Deliberately NOT `detached: true`. That was the first attempt and it
// silently failed to launch the child at all under some parent contexts
// (child spawned into a new process group, parent exits/continues, no popup
// and no entry in wt-focus's own debug log). unref() alone already gives the
// property that actually matters: the daemon isn't held open by a pending
// popup. A popup dying with the daemon on Ctrl+C is fine -- preferable, even.
function fireNotification(message) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.NOTIFY_SCRIPT, '-Message', message],
    { stdio: 'ignore' }
  );
  child.on('error', (err) => console.error('[cost-anomaly-alerts] notify failed:', err.message));
  child.unref();
}

// Session names come from an LLM (watcher.js's nameSession) and land in a
// `powershell.exe -File ... -Message <text>` argument. `-File` does its own
// parsing on top of CommandLineToArgvW and an embedded double quote silently
// truncates the argument there -- a name of `Project Setup` wrapped in quotes
// arrived as `Cost alert: session Project` and lost the cost entirely. So the
// message never wraps the name in quotes, and any quote characters inside the
// name itself are stripped rather than escaped.
function safeName(name) {
  const cleaned = String(name || '').replace(/["`]/g, '').trim();
  return cleaned || '(unnamed session)';
}

// The dedup/re-notify gate. Same shape as watcher.js's shouldCheckForRename:
// a persisted "already acted on this" record checked every tick, not a mode.
// Once a session's highest-crossed tier has been notified, only a *higher*
// tier is worth another notification -- crossing $10 once must not re-fire
// every 5s for as long as the session stays above $10.
//
// Storing the tier (not a boolean, and not a notified-at timestamp) is what
// makes the three interesting cases fall out for free:
//   - stays above $10 forever  -> 10 > 10 false, silent for the rest of the session
//   - later climbs past $25    -> 25 > 10 true, one more alert
//   - jumps $8 -> $60 in one tick -> crossedTier gives 50, one alert naming the
//     highest tier actually reached, not three stacked popups
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}

// Entries are never pruned, deliberately. A session drops out of status.json
// after ACTIVE_SESSION_WINDOW_MS (30min) of inactivity but can come back --
// evicting its record on disappearance would re-fire every alert it already
// sent the moment the user resumes it. Each entry is a few dozen bytes, so
// unbounded-but-tiny beats correct-until-someone-idles.
function tick(notified, deps = {}) {
  const notify = deps.notify || fireNotification;
  const status = loadJson(cfg.STATUS_FILE, null);
  if (!status || typeof status.sessions !== 'object' || status.sessions === null) return;

  let dirty = false;
  for (const [sessionId, session] of Object.entries(status.sessions)) {
    const cost = session && session.totals && typeof session.totals.cost_usd === 'number' ? session.totals.cost_usd : null;
    if (cost === null) continue;

    const tier = crossedTier(cost, cfg.COST_THRESHOLDS_USD);
    if (tier === null) continue;

    if (!shouldNotify(tier, notified[sessionId])) continue;

    notify(`Cost alert: session ${safeName(session.name)} crossed $${tier}, now at $${cost.toFixed(2)}`);

    notified[sessionId] = { tier, cost_at_notify: cost, notified_at: new Date().toISOString() };
    dirty = true;
  }

  if (dirty) writeJsonAtomic(cfg.NOTIFIED_FILE, notified);
}

function main() {
  const notified = loadJson(cfg.NOTIFIED_FILE, {});

  console.log(`[cost-anomaly-alerts] watching ${cfg.STATUS_FILE}`);
  console.log(`[cost-anomaly-alerts] thresholds: ${cfg.COST_THRESHOLDS_USD.map((t) => `$${t}`).join(', ')}`);
  console.log(`[cost-anomaly-alerts] polling every ${cfg.POLL_INTERVAL_MS}ms`);

  const shutdown = () => process.exit(0);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const loop = () => {
    try {
      tick(notified);
    } catch (err) {
      console.error('[cost-anomaly-alerts] tick failed:', err.message);
    }
    setTimeout(loop, cfg.POLL_INTERVAL_MS);
  };
  loop();
}

// Only start polling when run as a program. Required as a module (test.js)
// this exposes the pure decision logic instead, so the dedup gate can be
// exercised without a live status.json or a real popup.
if (require.main === module) main();

module.exports = { crossedTier, shouldNotify, tick, loadJson, fireNotification, safeName };
