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

// Subagent (Task tool) turns live in their own sidechain transcripts at
// <project>/<session-id>/subagents/agent-*.jsonl, with their own `usage`.
// They are NOT duplicated in the parent -- the parent only records the Task
// tool_result -- so before this they were invisible to status.json, the
// status bars, and the token-usage skill alike.
//
// Verified on this machine at the time of the fix: 401 subagent turns vs 335
// parent turns in one session, zero overlapping message ids, ~18% of total
// spend unaccounted for. Worse on Task-heavy sessions.
function findSubagentTranscripts(sessionDir) {
  const dir = path.join(sessionDir, 'subagents');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // no subagents dir is the common case, not an error
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    // The sidecar meta.json carries the toolUseId that links this transcript
    // back to its Agent tool_use in the parent -- that link is what lets us
    // report agents in UI order and tell running from finished.
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
    } catch {
      /* meta is a nicety; totals still merge without it */
    }
    const full = path.join(dir, f);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      /* raced with creation; treat as cold */
    }
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
    process.kill(pid, 0); // signal 0: no-op existence check, cross-platform including Windows
    return true;
  } catch {
    return false;
  }
}

// Claude Code writes ~/.claude/sessions/<pid>.json for every live interactive
// session and removes it on clean exit -- but a hard kill (task manager,
// terminal window closed, OOM) can leave a stale one behind, so the file's
// mere presence isn't proof of life either. Cross-checking the PID against
// the OS is what makes this robust to both a graceful exit (file gone) and
// an ungraceful one (file present, process gone).
//
// `known` distinguishes "the registry says nobody is running" from "there is
// no readable registry". They used to collapse to the same empty set, which
// was harmless when the only consumer was an `ended` flag. It is not harmless
// now that an empty set triggers shutdown: on a Claude Code build with no
// sessions directory, unknowable would read as "no sessions", the watcher
// would exit, the status line would start it again, and the two would spin
// forever -- restarting llama.cpp on every cycle.
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

// Time-boxed, not count-boxed: walks every session's uncached turns and
// classifies them against llama.cpp until the budget runs out, so one slow
// tick can never stall the poll loop by more than SEMANTIC_TIME_BUDGET_MS
// regardless of how many turns showed up since the last tick. Failed turns
// get a cooldown sentinel instead of an immediate retry, so a down/overloaded
// llama-server doesn't turn every tick into a wall of doomed requests.
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

// Sub-splits each block's already-prorated token count per the cached
// verdict — never a competing total. A block with no usable verdict (never
// classified, or classification failed) falls into the *_unclassified
// bucket so its tokens are still accounted for somewhere.
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

// Tail-truncated, not head-truncated: if there's ever a large gap (watcher
// was down, cache just upgraded from the old shape), the most recent text is
// what actually matters for "what's the user doing right now" -- and this
// keeps the prompt comfortably inside the model's 4096-token context
// regardless of how much history piled up.
const MAX_DIFF_CHARS = 3000;

// No trigger word, no mode -- every tick does a cheap, model-free check:
// is there anything new since we last looked, and has the rate-limit
// backstop cleared? Nothing to get "stuck" in: a tick that doesn't qualify
// just returns the existing name, same as if this function didn't exist.
function shouldCheckForRename(entry, newTurnCount) {
  if (!entry) return true; // never named yet -- always attempt, off the opening message
  if (newTurnCount === 0) return false; // nothing new to judge
  return Date.now() - (entry.named_at_ms || 0) >= cfg.RENAME_MIN_INTERVAL_MS;
}

// Enough text for the model to have something to work with; below this a
// single terse message ("now do the other thing") gets the previous message
// pulled in as context.
const MIN_CONTEXT_CHARS = 180;

// The newest message, and only as many older ones as are needed to reach
// MIN_CONTEXT_CHARS. Measured against this session's own transcript: naming
// off the newest message alone gave "Token Monitor Issue Found"; widening to
// the last three made it name the session after the OLDEST message in the
// window ("Claude Code Presentation Investigation") because a topic change
// puts several subjects in the prompt at once and the model picks the first.
// Recency is the signal -- extra history is noise that competes with it.
//
// Truncation is per-message and from the FRONT, never a tail-slice of the
// joined string: one long message used to be able to push every other
// message, including the newest, entirely out of the prompt.
function joinRecent(texts) {
  if (texts.length === 0) return '';
  const picked = [texts[texts.length - 1]];
  for (let i = texts.length - 2; i >= 0 && picked.join('').length < MIN_CONTEXT_CHARS; i--) {
    picked.unshift(texts[i]);
  }
  const perMessage = Math.max(200, Math.floor(MAX_DIFF_CHARS / picked.length));
  return picked.map((t) => (t.length > perMessage ? t.slice(0, perMessage) : t)).join('\n\n');
}

// Generic scaffolding words that say nothing about the topic -- two names
// sharing only these are not about the same thing.
const TOPIC_STOPWORDS = new Set([
  'session', 'sessions', 'work', 'working', 'task', 'tasks', 'issue', 'issues',
  'and', 'the', 'a', 'an', 'for', 'with', 'to', 'of', 'in', 'on', 'is', 'it',
  'setup', 'project', 'update', 'updates', 'new', 'demo',
]);

// Names come back in mixed shapes ("Tagoto Exploration", "DebuggingWatcherCache"),
// so split camelCase as well as separators before comparing.
function topicWords(name) {
  return new Set(
    String(name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w))
  );
}

// Any shared significant word means "still the same subject" -- this is what
// stops the name flapping between synonymous rewordings of one topic
// ("Tagoto Exploration" vs "Tagoto Experimentation Session") while still
// catching a genuine subject change.
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
  // A stored counter ABOVE the current count means the two were counted on
  // different bases -- which happens whenever what qualifies as a user turn
  // changes (filtering injected task-notifications out of userTexts dropped
  // this session from 18 to 14). Left alone the counter sits permanently
  // ahead of reality, slice() returns nothing, and the session can never be
  // renamed again. Treat that as a stale entry: clamp, and force one check
  // so it re-syncs instead of silently freezing.
  const staleBasis = storedTurns > userTexts.length;
  const seenTurns = Math.min(storedTurns, userTexts.length);
  const newTexts = userTexts.slice(seenTurns);

  if (!staleBasis && !shouldCheckForRename(entry, newTexts.length)) return entry ? entry.name : null;

  if (!entry) {
    // Cold start: nothing to diff against yet, just name off the opening message.
    const name = await nameSession(userTexts[0]);
    namesCache[sessionId] = { name: name || null, named_at_ms: Date.now(), named_at_turn_count: userTexts.length };
    writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
    return namesCache[sessionId].name;
  }

  // Too little new text to be worth a round trip yet -- leave
  // named_at_turn_count untouched so this same text (plus whatever comes
  // next) is reconsidered on the next tick instead of getting silently
  // dropped from the "seen" window.
  // (skipped on a stale basis -- there are no "new" turns to measure, the
  // counter just needs re-syncing against a fresh name)
  if (!staleBasis && newTexts.join('').length < cfg.RENAME_MIN_NEW_CHARS) return entry.name;

  // Name from a ROLLING WINDOW of the most recent messages, not just the
  // unseen ones. Every check advances named_at_turn_count, so an unseen-only
  // diff gets consumed by the attempt -- and if that one attempt happened to
  // answer badly, the topic change was gone forever. Re-sending the last few
  // messages each time makes a bad answer self-correcting on the next tick.
  const recent = joinRecent(userTexts.slice(-cfg.RENAME_RECENT_MESSAGES));

  // Ask the model only to NAME the text, never to judge whether the name
  // should change -- then decide that here. Measured on this machine: shown
  // its current name and asked "same or different?", llama3.2 answered "no
  // change" 8/8 on a blatant topic switch (coding project -> a different
  // project entirely). Repeating the name it was just handed is the
  // lowest-effort token path and a 3B model takes it. Asked to name the same
  // text cold, with no current name in the prompt, it was correct 8/8.
  // Same lesson as the semantic classifier: get an artifact out of the model,
  // derive the decision from it in code.
  const fresh = await nameSession(recent);

  namesCache[sessionId] = {
    name: fresh && !sameTopic(fresh, entry.name) ? fresh : entry.name,
    named_at_ms: Date.now(),
    named_at_turn_count: userTexts.length,
  };
  writeJsonAtomic(cfg.NAMES_CACHE_FILE, namesCache);
  return namesCache[sessionId].name;
}

// Folds a subagent sidechain's parse into its parent session's.
//
// Deliberately does NOT merge `userTexts`: a subagent transcript's "user"
// entries are the *prompt this session sent to the agent*, not anything the
// human typed. Merging them would feed the renamer text the user never
// wrote and let a subagent's task hijack the session name. Naming stays
// driven by real user turns only.
function mergeSubagent(parent, sub) {
  for (const [key, value] of Object.entries(sub.totals)) {
    if (typeof value === 'number') parent.totals[key] = (parent.totals[key] || 0) + value;
  }
  // Turn ids are globally unique (verified: zero overlap between a parent and
  // its subagents), so semantic classification treats these as ordinary
  // additional turns and its per-turn cache keys can't collide.
  parent.turns.push(...sub.turns);
  for (const m of sub.models) if (!parent.models.includes(m)) parent.models.push(m);
  if (sub.lastTimestamp && (!parent.lastTimestamp || sub.lastTimestamp > parent.lastTimestamp)) {
    parent.lastTimestamp = sub.lastTimestamp;
  }
}

// Currently-running agents only, in the order the UI shows them (the order
// their Agent tool_use blocks appear in the parent transcript).
//
// Liveness is measured by transcript ACTIVITY, not by whether the Agent
// tool_use has a tool_result. That distinction matters: a *background* agent
// gets its tool_result immediately (the "launched successfully" ack carrying
// the agent id) and only reports completion much later, so resolution marks
// every background agent finished the instant it starts. Transcript mtime is
// the one signal that works for both background and synchronous agents --
// a working agent writes constantly, a finished one stops.
//
// Deliberately excludes finished agents: their spend is already folded into
// the session total by mergeSubagent, and keeping them listed would grow the
// line monotonically -- this session has spawned 13. Consumers wanting the
// full history should read the transcripts (see projects/per-project-cost-attribution).
function buildAgentList(parsed, byToolUseId) {
  const agents = [];
  const liveCutoff = Date.now() - cfg.AGENT_ACTIVE_WINDOW_MS;
  for (const use of parsed.agentUses || []) {
    const hit = byToolUseId.get(use.toolUseId);
    // No transcript yet == just spawned, still counts as running. Otherwise
    // require recent writes.
    if (hit && hit.meta.mtimeMs && hit.meta.mtimeMs < liveCutoff) continue;
    const t = hit ? hit.parsed.totals : null;
    agents.push({
      description: use.description || (hit && hit.meta.description) || 'agent',
      agent_type: hit ? hit.meta.agentType : null,
      // A just-spawned agent has no transcript on disk yet -- report zeros
      // rather than dropping it, so it appears on the line immediately.
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
    // Ended sessions are deliberately NOT dropped early here -- they stay in
    // status.json (flagged) until they age out of ACTIVE_SESSION_WINDOW_MS
    // like anything else. The status bars filter them out themselves; other
    // consumers (see projects/usage-history-rollups, which wants exactly this
    // "session just ended" checkpoint) need the transition to stay visible.
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
    // Don't spend model calls renaming a session that can't change anymore --
    // its name is final. Just reuse whatever's already cached.
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
      // Running agents only, UI order. Empty array (never absent) so
      // consumers can render unconditionally without a presence check.
      agents: agents || [],
    };
    // Gated so disabling the flag reproduces the pre-semantic-layer
    // status.json shape exactly -- no `semantic` key at all, not just a
    // zeroed-out one -- which is what lets statusline.js and the nvim
    // plugin fall back to their original rendering with no changes needed.
    if (cfg.SEMANTIC_CLASSIFICATION_ENABLED) session.semantic = aggregateSemantic(parsed.turns, semanticCache);
    sessions[f.sessionId] = session;
  }

  writeJsonAtomic(cfg.STATUS_FILE, { updated_at: new Date().toISOString(), sessions });

  // Handed back so the poll loop can decide about idle shutdown without
  // re-reading the session registry it just read.
  return { liveCount: liveSessionIds.size, registryKnown };
}

// The watcher is a singleton over shared state: every instance writes the
// same status.json on the same cadence, so N instances don't divide work,
// they race -- last writer wins, and an instance running older code silently
// clobbers a newer one's output.
//
// This is not hypothetical. Three watchers were found running at once
// (started by three different Claude Code sessions on this machine); the two
// stale ones were overwriting the subagent-cost fix and the `agents` key
// with old-format data, which read as the *new* code being broken. A stale
// writer is worse than no writer, because the output still looks plausible.
//
// PID-file guard: a live PID means refuse to start; a dead one means the
// previous watcher crashed and we take over.
function acquireLock() {
  const lockPath = path.join(cfg.STATE_DIR, 'watcher.lock');
  try {
    const prev = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (prev && prev !== process.pid) {
      let alive = false;
      try {
        process.kill(prev, 0); // signal 0 == liveness probe, sends nothing
        alive = true;
      } catch {
        alive = false; // ESRCH: stale lock from a crashed run
      }
      if (alive) {
        console.error(`[watcher] another watcher is already running (pid ${prev}).`);
        console.error('[watcher] refusing to start -- two watchers race on status.json and the');
        console.error('[watcher] stale one wins half the time. Kill it first if you want this one.');
        process.exit(1);
      }
      console.warn(`[watcher] taking over stale lock from dead pid ${prev}`);
    }
  } catch {
    /* no lock file yet -- normal first start */
  }
  fs.writeFileSync(lockPath, String(process.pid));
  return lockPath;
}

async function main() {
  const lockPath = acquireLock();
  const releaseLock = () => {
    try {
      if (Number(fs.readFileSync(lockPath, 'utf8').trim()) === process.pid) fs.unlinkSync(lockPath);
    } catch {
      /* already gone, or taken over */
    }
  };
  // Registered immediately after acquiring, not after ensureRunning() below:
  // a failed llama-server spawn is the single most likely way a fresh install
  // dies, and it must not leave the lock behind. A stale lock is recoverable
  // (the next start sees a dead pid and takes over) but it prints a scary
  // "taking over stale lock" warning that reads like a second watcher ran.
  process.on('exit', releaseLock);

  // managed.ensureShared() rather than ensureRunning(): the shared chat
  // instance's lifetime is "as long as some Claude Code session needs it",
  // which is not something a single process's `owned` flag can express. See
  // packages/llama-local-server/managed.js.
  const shared = await managed.ensureShared({ startedBy: `watcher pid ${process.pid}` });
  console.log(
    `[watcher] llama-server ${shared.started ? 'started' : 'reused running instance'} on port ${shared.port}` +
      `${shared.pid ? ` (pid ${shared.pid})` : ''}${shared.managed ? '' : ' [unmanaged -- will not be stopped]'}`
  );

  const namesCache = loadJson(cfg.NAMES_CACHE_FILE, {});
  const semanticCache = cfg.SEMANTIC_CLASSIFICATION_ENABLED ? loadJson(cfg.SEMANTIC_CACHE_FILE, {}) : null;

  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return; // a second SIGINT must not race the first one's kill
    shuttingDown = true;
    // stopAll, not stopShared: by the time the last Claude Code session is
    // gone, nothing this suite started should survive it -- including
    // dedicated instances started by a one-shot CLI that exited long ago and
    // was never going to come back and clean up after itself.
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
  // process.exit() inside an async shutdown would cut the kill short, so the
  // signal handlers deliberately do not exit themselves.
  process.on('SIGINT', () => void shutdown('interrupted'));
  process.on('SIGTERM', () => void shutdown('terminated'));

  console.log(`[watcher] polling ${cfg.PROJECTS_DIR} every ${cfg.POLL_INTERVAL_MS}ms`);
  if (cfg.IDLE_SHUTDOWN_MS > 0) {
    console.log(`[watcher] will exit and stop llama-server after ${cfg.IDLE_SHUTDOWN_MS}ms with no live sessions`);
  }

  // When the last Claude Code session went away, or null while any is alive.
  // Time-based rather than a tick counter so POLL_INTERVAL_MS can change
  // without silently changing the grace period.
  let idleSince = null;

  for (;;) {
    try {
      // Re-ensure BEFORE the tick, because the tick is what uses the server.
      //
      // This used to run once at startup, which quietly made the watcher the
      // weakest link in its own chain: kill llama-server (task manager, a
      // crash, an OOM) and the watcher kept polling forever against a dead
      // backend. Nothing looked wrong -- status.json still updated, the status
      // line still rendered -- but session naming and semantic classification
      // failed on every tick and silently returned null, which the callers are
      // designed to tolerate. Found by killing the server by hand and watching
      // the watcher not care.
      //
      // Cheap in the normal case: one /health request against localhost.
      if (!(await managed.isUpFor(shared.claim))) {
        const again = await managed.ensureShared({ startedBy: `watcher pid ${process.pid}` });
        console.log(
          `[watcher] llama-server was gone -- ${again.started ? 'restarted' : 'found'} on port ${again.port}` +
            `${again.pid ? ` (pid ${again.pid})` : ''}`
        );
      } else {
        // Keeps the shared instance's record fresh. It is 'supervised' and so
        // never idle-reaped, but the timestamp is what `managed.js`'s CLI
        // shows and what makes an abandoned record obvious.
        managed.touch(shared.claim);
      }

      // Reap dedicated instances nobody is using any more. The watcher is the
      // only long-lived process on the machine that is guaranteed to be
      // running whenever any of this matters, which makes it the right reaper
      // -- including for instances started by separate repositories, since
      // the records are machine-level.
      for (const a of await managed.reap()) {
        if (a.action !== 'cleared-stale-record') {
          console.log(`[watcher] ${a.action} ${a.claim} (pid ${a.pid})${a.detail ? ` -- ${a.detail}` : ''}`);
        }
      }

      const { liveCount, registryKnown } = await tick(namesCache, semanticCache);

      // Only an authoritative "zero sessions" counts. An unreadable registry
      // leaves the watcher running: staying up costs one idle node process,
      // whereas exiting on a false reading costs a model reload for the
      // session that is still there.
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

// Only run as a daemon when invoked directly. Being require()-able lets the
// naming helpers be exercised against real transcripts without starting a
// second watcher (which the lock would refuse anyway) -- same guard
// statusline.js uses.
//
// The .catch() is load-bearing: main() is async, so anything it throws before
// the poll loop starts (overwhelmingly: ensureRunning() failing on a bad
// LLAMA_SERVER_EXE path) becomes an unhandled rejection. Node prints a raw
// stack and exits non-zero, which buries the one line that actually tells a
// new user what to fix.
if (require.main === module) {
  main().catch((err) => {
    console.error(`[watcher] failed to start: ${err.message}`);
    console.error('[watcher] most often this is the llama.cpp server path. Check');
    console.error('[watcher] packages/llama-local-server/config.js, or set LLAMA_SERVER_EXE.');
    process.exit(1);
  });
}

module.exports = { sameTopic, topicWords, joinRecent };
