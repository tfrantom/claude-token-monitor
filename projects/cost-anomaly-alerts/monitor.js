'use strict';

// A standalone daemon: reads token-monitor-core's status.json by path, calls
// bug-me-claude's notify-done.ps1, requires nothing under packages/.

const fs = require('fs');
const { spawn } = require('child_process');
const cfg = require('./config');

fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Missing, mid-write, or unreadable all mean the same thing here: skip
    // this tick, the file will be readable again on the next poll.
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

// Fire-and-forget: notify-done.ps1 blocks its own process until the popup is
// dismissed, so awaiting it would stall the poll loop. Not `detached: true` --
// see ../CLAUDE.md, it silently fails to launch under some parent contexts.
function fireNotification(message) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.NOTIFY_SCRIPT, '-Message', message],
    { stdio: 'ignore' }
  );
  child.on('error', (err) => console.error('[cost-anomaly-alerts] notify failed:', err.message));
  child.unref();
}

// Session names are LLM-generated and land in a `powershell.exe -File ...
// -Message <text>` argument, where an embedded double quote silently truncates
// the rest. Quotes are stripped rather than escaped, and the message never
// wraps the name in quotes either. See ../CLAUDE.md.
function safeName(name) {
  const cleaned = String(name || '').replace(/["`]/g, '').trim();
  return cleaned || '(unnamed session)';
}

// The dedup gate. Cost is monotonic, so crossing $10 once must not re-fire
// every 5s for as long as the session stays above $10: what is persisted is
// the highest tier already notified, and only a higher one fires again.
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}

// Entries are never pruned. A session drops out of status.json after 30min
// idle but can come back, and evicting its record would re-fire every alert it
// already sent the moment the user resumes it.
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

// Required as a module (test.js), this exposes the pure decision logic without
// starting the poll loop -- nothing in it can reach notify-done.ps1.
if (require.main === module) main();

module.exports = { crossedTier, shouldNotify, tick, loadJson, fireNotification, safeName };
