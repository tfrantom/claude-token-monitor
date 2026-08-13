'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { classifySession } = require('./lib/transcript');
const managed = require('../llama-local-server/managed');
const { nameSession } = require('./lib/llm-client');
const { classifyTurn } = require('./lib/semantic-classifier');

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

function findActiveSessionFiles() {
  const cutoff = Date.now() - cfg.ACTIVE_SESSION_WINDOW_MS;
  const results = [];
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(cfg.PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory()) continue;
    const projectDir = path.join(cfg.PROJECTS_DIR, dirent.name);
    let files;
    try {
      files = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projectDir, f);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      results.push({
        sessionId,
        project: dirent.name,
        path: full,
        mtimeMs: stat.mtimeMs,
        subagentPaths: findSubagentTranscripts(path.join(projectDir, sessionId)),
      });
    }
  }
  return results;
}

// Subagent turns are NOT duplicated in the parent transcript -- see CLAUDE.md
// "Subagent transcripts are counted, and they are not in the parent".
function findSubagentTranscripts(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
    } catch {}
    const full = path.join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {}
    out.push({
      path: full,
      mtimeMs,
      toolUseId: meta.toolUseId || null,
      description: meta.description || null,
      agentType: meta.agentType || null,
    });
  }
  return out;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// `known` is not optional -- see CLAUDE.md "Idle shutdown, and the reading
// that must not be guessed".
function loadLiveSessions() {
  const live = new Set();
  let files;
  try {
    files = fs.readdirSync(cfg.CLAUDE_SESSIONS_DIR);
  } catch {
    return { live, known: false };
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(cfg.CLAUDE_SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (entry.sessionId && entry.pid && isPidAlive(entry.pid)) live.add(entry.sessionId);
  }
  return { live, known: true };
}

function getCachedName(namesCache, sessionId) {
  const entry = namesCache[sessionId];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.name;
}

function emptySemanticTotals() {
  return {
    thinking_productive: 0,
    thinking_wasted: 0,
    thinking_unclassified: 0,
    tool_explore: 0,
    tool_mutate: 0,
    tool_verify: 0,
    tool_redundant: 0,
    tool_other: 0,
    tool_unclassified: 0,
  };
}

async function backfillSemantic(semanticCache, parsedSessions) {
  const deadline = Date.now() + cfg.SEMANTIC_TIME_BUDGET_MS;
  let dirty = false;
  for (const parsed of parsedSessions) {
    for (const turn of parsed.turns) {
      if (Date.now() > deadline) {
        if (dirty) writeJsonAtomic(cfg.SEMANTIC_CACHE_FILE, semanticCache);
        return;
      }
      const cached = semanticCache[turn.id];
      if (cached) {
        if (!cached.failedAt || Date.now() - cached.failedAt < cfg.SEMANTIC_RETRY_MS) continue;
      }
      const result = await classifyTurn(turn);
      semanticCache[turn.id] = result ? Object.fromEntries(result) : { failedAt: Date.now() };
      dirty = true;
    }
  }
  if (dirty) writeJsonAtomic(cfg.SEMANTIC_CACHE_FILE, semanticCache);
}

function aggregateSemantic(turns, semanticCache) {
  const sem = emptySemanticTotals();
  for (const turn of turns) {
    const cached = semanticCache[turn.id];
    const verdicts = cached && !cached.failedAt ? cached : null;
    for (const block of turn.blocks) {
      const v = verdicts ? verdicts[block.index] : null;
      if (block.type === 'thinking') {
        if (v) {
          sem.thinking_productive += block.tokens * v.productive_fraction;
          sem.thinking_wasted += block.tokens * (1 - v.productive_fraction);
        } else {
          sem.thinking_unclassified += block.tokens;
        }
      } else if (block.type === 'tool_use') {
        const key = v && v.purpose && v.purpose !== 'na' ? `tool_${v.purpose}` : null;
        if (key && key in sem) sem[key] += block.tokens;
        else if (v) sem.tool_other += block.tokens;
        else sem.tool_unclassified += block.tokens;
      }
    }
  }
  return sem;
}

const MAX_DIFF_CHARS = 7000;

function shouldCheckForRename(entry, newTurnCount) {
  if (!entry) return true;
  if (newTurnCount === 0) return false;
  return Date.now() - (entry.named_at_ms || 0) >= cfg.RENAME_MIN_INTERVAL_MS;
}

const MIN_CONTEXT_CHARS = 600;

// The recency bias and the per-message front truncation are both load-bearing
// -- see CLAUDE.md "Three traps that had to be fixed together".
function joinRecent(texts) {
  if (texts.length === 0) return '';
  const picked = [texts[texts.length - 1]];
  for (let i = texts.length - 2; i >= 0 && picked.join('').length < MIN_CONTEXT_CHARS; i--) {
    picked.unshift(texts[i]);
  }
  const perMessage = Math.max(200, Math.floor(MAX_DIFF_CHARS / picked.length));
  return picked.map((t) => (t.length > perMessage ? t.slice(0, perMessage) : t)).join('\n\n');
}

const TOPIC_STOPWORDS = new Set([
  'session', 'sessions', 'work', 'working', 'task', 'tasks', 'issue', 'issues',
  'and', 'the', 'a', 'an', 'for', 'with', 'to', 'of', 'in', 'on', 'is', 'it',
  'setup', 'project', 'update', 'updates', 'new', 'demo',
]);

function topicWords(name) {
  return new Set(
    String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w))
  );
}

function sameTopic(a, b) {
  const wa = topicWords(a);
  if (wa.size === 0) return false;
  for (const w of topicWords(b)) if (wa.has(w)) return true;
  return false;
}

async function getOrUpdateName(namesCache, sessionId, userTexts) {
  if (userTexts.length === 0) return null;

  let entry = namesCache[sessionId];
  if (typeof entry === 'string') entry = { name: entry, named_at_ms: 0, named_at_turn_count: 0 }; // pre-rename cache format
  const storedTurns = entry ? entry.named_at_turn_count ?? 0 : 0;
  // Keep this clamp -- see CLAUDE.md "Changing what counts as a turn strands
  // the cache".
  const staleBasis = storedTurns > userTexts.length;
  const seenTurns = Math.min(storedTurns, userTexts.length);
  const newTexts = userTexts.slice(seenTurns);

  if (!staleBasis && !shouldCheckForRename(entry, newTexts.length)) return entry ? entry.name : null;

  if (!entry) {
    const name = await nameSession(userTexts[0]);
    namesCache[sessionId] = { name: name || null, named_at_ms: Date.now(), named_at_turn_count: userTexts.length };
    writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
    return namesCache[sessionId].name;
  }

  // Returning early leaves named_at_turn_count untouched on purpose, so this
  // text is reconsidered next tick rather than dropped from the seen window.
  if (!staleBasis && newTexts.join('').length < cfg.RENAME_MIN_NEW_CHARS) return entry.name;

  // A rolling window, and the model is only ever asked to NAME -- both are
  // measured findings, see CLAUDE.md "Naming".
  const recent = joinRecent(userTexts.slice(-cfg.RENAME_RECENT_MESSAGES));
  const fresh = await nameSession(recent);

  namesCache[sessionId] = {
    name: fresh && !sameTopic(fresh, entry.name) ? fresh : entry.name,
    named_at_ms: Date.now(),
    named_at_turn_count: userTexts.length,
  };
  writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
  return namesCache[sessionId].name;
}

// Deliberately does NOT merge `userTexts` -- see CLAUDE.md "Naming".
function mergeSubagent(parent, sub) {
  for (const [key, value] of Object.entries(sub.totals)) {
    if (typeof value === 'number') parent.totals[key] = (parent.totals[key] || 0) + value;
  }
  parent.turns.push(...sub.turns);
  for (const m of sub.models) if (!parent.models.includes(m)) parent.models.push(m);
  if (sub.lastTimestamp && (!parent.lastTimestamp || sub.lastTimestamp > parent.lastTimestamp)) {
    parent.lastTimestamp = sub.lastTimestamp;
  }
}

// Liveness is transcript write activity, NOT whether the Agent tool_use has a
// tool_result -- see CLAUDE.md "Running vs finished subagents".
function buildAgentList(parsed, byToolUseId) {
  const agents = [];
  const liveCutoff = Date.now() - cfg.AGENT_ACTIVE_WINDOW_MS;
  for (const use of parsed.agentUses || []) {
    const hit = byToolUseId.get(use.toolUseId);
    if (hit && hit.meta.mtimeMs && hit.meta.mtimeMs < liveCutoff) continue;
    const t = hit ? hit.parsed.totals : null;
    agents.push({
      description: use.description || (hit && hit.meta.description) || 'agent',
      agent_type: hit ? hit.meta.agentType : null,
      tokens: t ? t.context + t.cache_write + t.cache_read + t.thinking + t.writing + t.tool_calls : 0,
      cost_usd: t ? t.cost_usd : 0,
    });
  }
  return agents;
}

async function tick(namesCache, semanticCache) {
  const { live: liveSessionIds, known: registryKnown } = loadLiveSessions();
  const files = findActiveSessionFiles();
  const parsedByFile = [];

  for (const f of files) {
    // Flagged, not dropped -- see CLAUDE.md "Ended sessions stay in the data".
    const ended = !liveSessionIds.has(f.sessionId);
    const parsed = classifySession(f.path);
    if (!parsed) continue;
    const byToolUseId = new Map();
    for (const sub of f.subagentPaths) {
      const subParsed = classifySession(sub.path);
      if (!subParsed) continue;
      mergeSubagent(parsed, subParsed);
      if (sub.toolUseId) byToolUseId.set(sub.toolUseId, { meta: sub, parsed: subParsed });
    }
    parsedByFile.push({ f, parsed, ended, agents: buildAgentList(parsed, byToolUseId) });
  }

  if (cfg.SEMANTIC_CLASSIFICATION_ENABLED) {
    await backfillSemantic(semanticCache, parsedByFile.map((p) => p.parsed));
  }

  const sessions = {};
  for (const { f, parsed, ended, agents } of parsedByFile) {
    const name = ended
      ? getCachedName(namesCache, f.sessionId)
      : await getOrUpdateName(namesCache, f.sessionId, parsed.userTexts);
    const session = {
      session_id: f.sessionId,
      project: f.project,
      name: name || '(unnamed session)',
      ended,
      last_activity: parsed.lastTimestamp,
      mtime_ms: f.mtimeMs,
      models: parsed.models,
      totals: parsed.totals,
      agents: agents || [],
    };
    if (cfg.SEMANTIC_CLASSIFICATION_ENABLED) session.semantic = aggregateSemantic(parsed.turns, semanticCache);
    sessions[f.sessionId] = session;
  }

  writeJsonAtomic(cfg.STATUS_FILE, { updated_at: new Date().toISOString(), sessions });

  return { liveCount: liveSessionIds.size, registryKnown };
}

// See CLAUDE.md "The singleton rule".
function acquireLock() {
  const lockPath = path.join(cfg.STATE_DIR, 'watcher.lock');
  try {
    const prev = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (prev && prev !== process.pid) {
      let alive = false;
      try {
        process.kill(prev, 0);
        alive = true;
      } catch {
        alive = false;
      }
      if (alive) {
        console.error(`[watcher] another watcher is already running (pid ${prev}).`);
        console.error('[watcher] refusing to start -- two watchers race on status.json and the');
        console.error('[watcher] stale one wins half the time. Kill it first if you want this one.');
        process.exit(1);
      }
      console.warn(`[watcher] taking over stale lock from dead pid ${prev}`);
    }
  } catch {}
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

async function main() {
  const lockPath = acquireLock();
  const releaseLock = () => {
    try {
      if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) fs.unlinkSync(lockPath);
    } catch {}
  };
  // Registered before the ensureShared() below: a failed llama-server spawn
  // must not leave the lock behind.
  process.on('exit', releaseLock);

  const shared = await managed.ensureShared({ startedBy: `watcher pid ${process.pid}` });
  console.log(
    `[watcher] llama-server ${shared.started ? 'started' : 'reused running instance'} on port ${shared.port}` +
      `${shared.pid ? ` (pid ${shared.pid})` : ''}${shared.managed ? '' : ' [unmanaged -- will not be stopped]'}`
  );

  const namesCache = loadJson(cfg.NAMES_CACHE_FILE, {});
  const semanticCache = cfg.SEMANTIC_CLASSIFICATION_ENABLED ? loadJson(cfg.SEMANTIC_CACHE_FILE, {}) : null;

  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const results = await managed.stopAll({ reason: why });
    if (!results.length) {
      console.log(`[watcher] nothing managed to stop (${why})`);
    }
    for (const r of results) {
      console.log(
        r.stopped
          ? `[watcher] stopped ${r.claim} pid ${r.pid} (${why})`
          : `[watcher] left ${r.claim} running: ${r.reason}`
      );
    }
    releaseLock();
    process.exit(0);
  };
  // The handlers must not exit themselves; process.exit() would cut the async
  // kill short.
  process.on('SIGINT', () => void shutdown('interrupted'));
  process.on('SIGTERM', () => void shutdown('terminated'));

  console.log(`[watcher] polling ${cfg.PROJECTS_DIR} every ${cfg.POLL_INTERVAL_MS}ms`);
  if (cfg.IDLE_SHUTDOWN_MS > 0) {
    console.log(`[watcher] will exit and stop llama-server after ${cfg.IDLE_SHUTDOWN_MS}ms with no live sessions`);
  }

  let idleSince = null;

  for (;;) {
    try {
      // Every tick, not just at startup -- see CLAUDE.md "The watcher
      // re-ensures the shared server every tick".
      if (!(await managed.isUpFor(shared.claim))) {
        const again = await managed.ensureShared({ startedBy: `watcher pid ${process.pid}` });
        console.log(
          `[watcher] llama-server was gone -- ${again.started ? 'restarted' : 'found'} on port ${again.port}` +
            `${again.pid ? ` (pid ${again.pid})` : ''}`
        );
      } else {
        managed.touch(shared.claim);
      }

      for (const a of await managed.reap()) {
        if (a.action !== 'cleared-stale-record') {
          console.log(`[watcher] ${a.action} ${a.claim} (pid ${a.pid})${a.detail ? ` -- ${a.detail}` : ''}`);
        }
      }

      const { liveCount, registryKnown } = await tick(namesCache, semanticCache);

      if (cfg.IDLE_SHUTDOWN_MS > 0 && registryKnown && liveCount === 0) {
        if (idleSince === null) {
          idleSince = Date.now();
          console.log('[watcher] no live Claude sessions -- idle countdown started');
        } else if (Date.now() - idleSince >= cfg.IDLE_SHUTDOWN_MS) {
          await shutdown('no Claude sessions running');
          return;
        }
      } else if (idleSince !== null) {
        console.log('[watcher] a Claude session is live again -- idle countdown cancelled');
        idleSince = null;
      }
    } catch (err) {
      console.error('[watcher] tick failed:', err.message);
    }
    await new Promise((r) => setTimeout(r, cfg.POLL_INTERVAL_MS));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[watcher] failed to start: ${err.message}`);
    console.error('[watcher] most often this is the llama.cpp server path. Check');
    console.error('[watcher] packages/llama-local-server/config.js, or set LLAMA_SERVER_EXE.');
    process.exit(1);
  });
}

module.exports = { sameTopic, topicWords, joinRecent };
