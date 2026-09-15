'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');
const { classifySession } = require('./lib/transcript');
const managed = require('../llama-local-server/managed');
const { nameSession, cleanName } = require('./lib/llm-client');
const { classifyTurn } = require('./lib/semantic-classifier');
const signals = require('./lib/signals');
// The lock path is defined once, in the supervisor: the status line's
// "is a watcher running?" check and this refusal to start must agree.
const supervisor = require('./lib/supervisor');

fs.mkdirSync(cfg.STATE_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Writes to a temp file and renames, so a reader never sees a partial file.
 * Every consumer of `status.json` depends on this.
 *
 * @param {string} file
 * @param {unknown} data
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * @typedef {object} SessionFile
 * @property {string} sessionId Transcript filename, which is also the
 *   `status.json` key and `CLAUDE_CODE_SESSION_ID`.
 * @property {string} project Sanitised cwd, e.g. `C--projects`.
 * @property {string} path
 * @property {number} mtimeMs
 * @property {Array<{path: string, mtimeMs: number, toolUseId: string|null, description: string|null, agentType: string|null}>} subagentPaths
 */

/**
 * @returns {SessionFile[]} Transcripts written inside
 *   `ACTIVE_SESSION_WINDOW_MS`. Anything older is invisible to the watcher
 *   entirely — this window, not `ended`, is what bounds the work per tick.
 */
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

const BOOT_CLOCK_SLACK_MS = 60 * 1000;

/**
 * @param {{sessionId?: string, pid?: number, startedAt?: number}} entry One
 *   `~/.claude/sessions/<pid>.json`.
 * @param {number} [bootMs] The machine's boot instant.
 * @returns {boolean} Whether the session that wrote this entry is still the
 *   process holding its pid -- see CLAUDE.md "A registry entry outlives the
 *   session that wrote it".
 */
function isRegistryEntryLive(entry, bootMs = Date.now() - os.uptime() * 1000) {
  if (!entry || !entry.sessionId || !entry.pid) return false;
  if (Number.isFinite(entry.startedAt) && entry.startedAt < bootMs - BOOT_CLOCK_SLACK_MS) return false;
  return isPidAlive(entry.pid);
}

/**
 * Reads Claude Code's own live-session registry.
 *
 * `known` is not optional -- see CLAUDE.md "Idle shutdown, and the reading
 * that must not be guessed".
 *
 * @returns {{live: Set<string>, known: boolean}} `known` is false when the
 *   registry could not be read at all. An empty `live` with `known: false`
 *   means "cannot tell", not "nothing is running" — treating the two alike
 *   marks every session ended at once and triggers an idle shutdown.
 */
function loadLiveSessions() {
  const live = new Set();
  const bootMs = Date.now() - os.uptime() * 1000;
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
    if (isRegistryEntryLive(entry, bootMs)) live.add(entry.sessionId);
  }
  return { live, known: true };
}

/**
 * @param {Record<string, string|{name: string}>} namesCache Older entries are a
 *   bare string, newer ones an object.
 * @param {string} sessionId
 * @returns {string|null}
 */
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

/**
 * Classifies turns not yet in the cache, within a time budget.
 *
 * @param {Record<string, object>} semanticCache Mutated and persisted. A failed
 *   turn is stored as `{failedAt}` so it is retried later rather than
 *   immediately, and never mistaken for a real verdict.
 * @param {Array<import('./lib/transcript').ParsedSession>} parsedSessions
 * @returns {Promise<void>} Returns early when the budget runs out; whatever was
 *   not reached this tick is picked up on a later one.
 */
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

/**
 * @param {Array<object>} turns
 * @param {Record<string, object>} semanticCache
 * @returns {object} Token counts per verdict. Unclassified tokens land in the
 *   `*_unclassified` buckets rather than being dropped, so the totals still add
 *   up while the model is unreachable or behind.
 */
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

/**
 * Builds the naming prompt's context window.
 *
 * Newest message first and labelled, and truncation is per-message from the
 * front. Do not reorder or tail-slice -- see CLAUDE.md "Three traps that had to
 * be fixed together".
 *
 * @param {string[]} texts Oldest first, as the transcript yields them.
 * @returns {string} '' for no input.
 */
function joinRecent(texts) {
  if (texts.length === 0) return '';
  const picked = [texts[texts.length - 1]];
  for (let i = texts.length - 2; i >= 0 && picked.join('').length < MIN_CONTEXT_CHARS; i--) {
    picked.unshift(texts[i]);
  }
  const perMessage = Math.max(200, Math.floor(MAX_DIFF_CHARS / picked.length));
  const clip = (t) => (t.length > perMessage ? t.slice(0, perMessage) : t);
  const newest = picked[picked.length - 1];
  const earlier = picked.slice(0, -1);
  if (earlier.length === 0) return `LATEST MESSAGE:\n${clip(newest)}`;
  return `LATEST MESSAGE:\n${clip(newest)}\n\nEARLIER CONTEXT (background only):\n${earlier.map(clip).join('\n\n')}`;
}

// One shared word suppresses a rename, so a word left out of here freezes a
// session's name permanently -- see CLAUDE.md "Naming".
const TOPIC_STOPWORDS = new Set([
  'session', 'sessions', 'work', 'working', 'task', 'tasks', 'issue', 'issues',
  'and', 'the', 'a', 'an', 'for', 'with', 'to', 'of', 'in', 'on', 'is', 'it',
  'setup', 'project', 'update', 'updates', 'new', 'demo',
  'explanation', 'summary', 'request', 'review', 'overview', 'analysis',
  'investigation', 'discussion', 'question', 'questions', 'help', 'fixing',
  'fixes', 'debugging', 'testing', 'implementation', 'implementing',
  'refactor', 'refactoring', 'cleanup', 'changes', 'error', 'errors',
]);

// The project's own name says nothing inside that project: every session in
// claude-token-monitor could be called something "token monitor". Derived per
// session rather than listed, so this works for any repo.
function projectStopwords(project) {
  return new Set(
    String(project || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2)
  );
}

function topicWords(name, extra) {
  return new Set(
    String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w) && !(extra && extra.has(w)))
  );
}

/**
 * @param {string} a
 * @param {string} b
 * @param {Set<string>} [extra] Project-derived stopwords, so a name is not held
 *   still merely by naming the repo it is in.
 * @returns {boolean} True when the two names share any non-stopword — one
 *   shared word suppresses a rename, which is why the stopword lists matter.
 */
function sameTopic(a, b, extra) {
  const wa = topicWords(a, extra);
  if (wa.size === 0) return false;
  for (const w of topicWords(b, extra)) if (wa.has(w)) return true;
  return false;
}

/**
 * The session's display name, renaming it when the topic has moved on.
 *
 * @param {Record<string, object>} namesCache Mutated and persisted by the caller.
 * @param {string} sessionId
 * @param {string[]} userTexts Human messages only, oldest first.
 * @param {string} project
 * @returns {Promise<string|null>} The cached name unchanged when nothing
 *   warrants a rename, or null if there has never been one. The model is asked
 *   for a name and never asked *whether* to rename -- see CLAUDE.md "Naming".
 */
async function getOrUpdateName(namesCache, sessionId, userTexts, project) {
  if (userTexts.length === 0) return null;

  let entry = namesCache[sessionId];
  if (typeof entry === 'string') entry = { name: entry, named_at_ms: 0, named_at_turn_count: 0 }; // pre-rename cache format
  const storedTurns = entry ? entry.named_at_turn_count ?? 0 : 0;
  // Keep this clamp -- see CLAUDE.md "Changing what counts as a turn strands
  // the cache".
  const staleBasis = storedTurns > userTexts.length;
  const seenTurns = Math.min(storedTurns, userTexts.length);
  const newTexts = userTexts.slice(seenTurns);

  // Re-validated on read, not just on write: renames only fire on new user
  // turns, so without this a name accepted by an older cleanName() sticks to a
  // quiet session forever.
  const cachedIsInvalid = !!(entry && entry.name && !cleanName(entry.name));

  if (!staleBasis && !cachedIsInvalid && !shouldCheckForRename(entry, newTexts.length)) {
    return entry ? entry.name : null;
  }

  if (!entry) {
    const name = await nameSession(userTexts[0]);
    namesCache[sessionId] = { name: name || null, named_at_ms: Date.now(), named_at_turn_count: userTexts.length };
    writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
    return namesCache[sessionId].name;
  }

  // Returning early leaves named_at_turn_count untouched on purpose, so this
  // text is reconsidered next tick rather than dropped from the seen window.
  if (!staleBasis && !cachedIsInvalid && newTexts.join('').length < cfg.RENAME_MIN_NEW_CHARS) return entry.name;

  // A rolling window, and the model is only ever asked to NAME -- both are
  // measured findings, see CLAUDE.md "Naming".
  const recent = joinRecent(userTexts.slice(-cfg.RENAME_RECENT_MESSAGES));
  const fresh = await nameSession(recent);

  namesCache[sessionId] = {
    name: fresh && (cachedIsInvalid || !sameTopic(fresh, entry.name, projectStopwords(project))) ? fresh : entry.name,
    named_at_ms: Date.now(),
    named_at_turn_count: userTexts.length,
  };
  writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
  return namesCache[sessionId].name;
}

// Deliberately does NOT merge `userTexts` -- see CLAUDE.md "Naming".
/**
 * Folds a subagent's transcript into its parent session's totals.
 *
 * Subagent turns are NOT duplicated in the parent transcript, so this adds
 * spend rather than double counting it.
 *
 * @param {import('./lib/transcript').ParsedSession} parent Mutated in place.
 * @param {import('./lib/transcript').ParsedSession} sub
 */
function mergeSubagent(parent, sub) {
  for (const [key, value] of Object.entries(sub.totals)) {
    if (typeof value === 'number') parent.totals[key] = (parent.totals[key] || 0) + value;
  }
  parent.turns.push(...sub.turns);
  // A subagent's writes are the parent session's writes: same race, same file.
  if (sub.fileWrites) parent.fileWrites.push(...sub.fileWrites);
  for (const m of sub.models) if (!parent.models.includes(m)) parent.models.push(m);
  if (sub.lastTimestamp && (!parent.lastTimestamp || sub.lastTimestamp > parent.lastTimestamp)) {
    parent.lastTimestamp = sub.lastTimestamp;
  }
}

// Liveness is transcript write activity, NOT whether the Agent tool_use has a
// tool_result -- see CLAUDE.md "Running vs finished subagents".
/**
 * @param {import('./lib/transcript').ParsedSession} parsed
 * @param {Map<string, {meta: object, parsed: object}>} byToolUseId
 * @returns {Array<{description: string, agent_type: string|null, tokens: number, cost_usd: number}>}
 *   Only agents whose sidechain was written inside `AGENT_ACTIVE_WINDOW_MS` —
 *   a finished agent drops off rather than accumulating on the bar forever.
 */
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

/**
 * Newest write per path, recent ones only: the consumers ask "is this file
 * being edited right now", which an unbounded history answers no better.
 *
 * @param {Array<{path: string, at: string|null}>} fileWrites
 * @param {number} now
 * @returns {Array<{path: string, at: string}>} Newest first, one entry per path.
 */
function recentWrites(fileWrites, now) {
  const cutoff = now - cfg.RECENT_WRITES_WINDOW_MS;
  const newest = new Map();
  for (const w of fileWrites || []) {
    const at = Date.parse(w.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    const prev = newest.get(w.path);
    if (!prev || at > Date.parse(prev.at)) newest.set(w.path, w);
  }
  return [...newest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * What a session says it is doing, falling back to what can be inferred.
 * Supersede needs its wide margin because publishing is itself a tool call --
 * see CLAUDE.md "Staleness is the hard part".
 *
 * @param {import('./lib/signals').SessionSignal|undefined} signal What the
 *   session published. A `hook`-sourced one is never superseded: it is
 *   bracketed by the next hook, so there is nothing for a heuristic to resolve.
 * @param {Array<object>} agents Running subagents; they refine a bare
 *   `working`, but never override a more specific published state.
 * @param {boolean} ended
 * @param {number} lastActivityMs Transcript mtime, the inference's only input.
 * @param {number} [now]
 * @returns {{state: string|null, detail: string|null, at: string|null, source: string|null, agents: Array<object>}}
 *   `state: null` means nothing is known — render nothing rather than idle.
 */
function buildActivity(signal, agents, ended, lastActivityMs, now = Date.now()) {
  const running = (agents || []).length;
  const writingNow = Number.isFinite(lastActivityMs) && now - lastActivityMs <= cfg.ACTIVITY_ACTIVE_WINDOW_MS;

  let inferred = { state: null, detail: null, source: null };
  if (running) {
    inferred = {
      state: 'waiting_agents',
      detail: `${running} agent${running === 1 ? '' : 's'} running`,
      source: 'inferred',
    };
  } else if (writingNow) {
    inferred = { state: 'working', detail: null, source: 'inferred' };
  }

  if (ended) return { state: 'ended', detail: null, at: null, source: 'watcher', agents: [] };

  // Only a hand-published signal can go stale. A hook one is bracketed by the
  // next hook -- UserPromptSubmit opens a turn, Stop closes it -- so there is
  // nothing for a heuristic to resolve, and applying it anyway silently
  // discarded every `done`: the transcript keeps being written after a turn
  // ends, so the gap crossed the threshold and the session went blank.
  const at = signal && signal.at ? Date.parse(signal.at) : NaN;
  const fromHook = !!(signal && signal.source === 'hook');
  const superseded =
    !fromHook &&
    Number.isFinite(at) &&
    Number.isFinite(lastActivityMs) &&
    lastActivityMs - at > cfg.SIGNAL_SUPERSEDE_MS;

  if (signal && signal.state && !superseded) {
    // `working` is the least specific thing a session can say, and the
    // UserPromptSubmit hook publishes it for a whole turn -- so running agents
    // refine it rather than being hidden by it. Every other state (done,
    // blocked, waiting_user) is more specific than the inference and wins.
    if (signal.state === 'working' && running) {
      return { ...inferred, at: signal.at, source: 'inferred', agents: signal.agents || [] };
    }
    return {
      state: signal.state,
      detail: signal.detail,
      at: signal.at,
      source: signal.source || 'signal',
      agents: signal.agents || [],
    };
  }

  return { ...inferred, at: null, agents: (signal && signal.agents) || [] };
}

/**
 * One full pass: read every active transcript, price it, name it, classify it,
 * and publish `status.json`.
 *
 * @param {Record<string, object>} namesCache Mutated in place.
 * @param {Record<string, object>} semanticCache Mutated in place.
 * @returns {Promise<{liveCount: number, registryKnown: boolean}>} Both feed the
 *   idle-shutdown decision, which must not act on `liveCount === 0` unless
 *   `registryKnown` is true.
 */
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

  const signalsBySession = signals.bySession();

  const sessions = {};
  for (const { f, parsed, ended, agents } of parsedByFile) {
    const name = ended
      ? getCachedName(namesCache, f.sessionId)
      : await getOrUpdateName(namesCache, f.sessionId, parsed.userTexts, f.project);
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
      recent_writes: recentWrites(parsed.fileWrites, Date.now()),
      activity: buildActivity(signalsBySession[f.sessionId], agents, ended, f.mtimeMs),
    };
    if (cfg.SEMANTIC_CLASSIFICATION_ENABLED) session.semantic = aggregateSemantic(parsed.turns, semanticCache);
    sessions[f.sessionId] = session;
  }

  writeJsonAtomic(cfg.STATUS_FILE, { updated_at: new Date().toISOString(), sessions });
  signals.prune(Object.keys(sessions));

  return { liveCount: liveSessionIds.size, registryKnown };
}

/**
 * See CLAUDE.md "The singleton rule".
 *
 * @returns {boolean} False when another live watcher holds the lock, and the
 *   caller must exit. A lock naming a dead pid is taken over, not honoured.
 */
function acquireLock() {
  const lockPath = supervisor.LOCK_FILE;
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

module.exports = { sameTopic, topicWords, projectStopwords, joinRecent, buildActivity, recentWrites, isRegistryEntryLive };
