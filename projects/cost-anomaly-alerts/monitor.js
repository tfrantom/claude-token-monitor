'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const cfg = require('./config');

fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// `thresholds` must be ascending.
function crossedTier(cost, thresholds) {
  let tier = null;
  for (const t of thresholds) {
    if (cost >= t) tier = t;
    else break;
  }
  return tier;
}

// Never awaited, and never `detached: true` -- see CLAUDE.md "Notification delivery"
function fireNotification(message) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.NOTIFY_SCRIPT, '-Message', message],
    { stdio: 'ignore' }
  );
  child.on('error', (err) => console.error('[cost-anomaly-alerts] notify failed:', err.message));
  child.unref();
}

// An embedded " truncates a -File argument -- see CLAUDE.md "Notification delivery"
function safeName(name) {
  const cleaned = String(name || '').replace(/["`]/g, '').trim();
  return cleaned || '(unnamed session)';
}

// see CLAUDE.md "The dedup / re-notify gate"
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}

// `notified` entries are never pruned -- see CLAUDE.md "The dedup / re-notify gate"
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

if (require.main === module) main();

module.exports = { crossedTier, shouldNotify, tick, loadJson, fireNotification, safeName };
