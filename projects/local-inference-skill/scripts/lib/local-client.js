'use strict';

// Shared plumbing for the local-inference skill's scripts.
//
// Self-contained on purpose -- this file gets copied wholesale into
// ~/.claude/skills/local-inference/scripts/lib/ by install.ps1, and the
// installed copy must keep working even if claude-token-monitor moves,
// breaks, or stops existing. So the connection/spawn logic here is a
// deliberate duplicate of packages/llama-local-server/{config,server}.js
// rather than a `require` across the repo boundary (same rule
// token-usage-skill/scripts/lookup.js follows).
//
// Where the settings come from, highest priority first:
//   1. env vars (LLAMA_HOST / LLAMA_PORT / LLAMA_SERVER_EXE / LLAMA_MODEL_PATH)
//      -- the same names llama-local-server/config.js honours, so overriding
//      one overrides both.
//   2. config.json at the skill root, written by install.ps1 at install time
//      (the installed copy has no relative path back to the suite).
//   3. discovery -- an Ollama manifest lookup and a search of the usual
//      llama.cpp build locations, mirroring llama-local-server/config.js.
//      This used to be a pair of hardcoded absolute paths, including a bare
//      sha256 blob digest, which was correct on exactly one machine; the
//      resolver keeps the source-tree copy runnable without installing first
//      *and* keeps a copy installed on another machine working.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function loadConfigFile() {
  // <skill root>/config.json -- this file lives at <skill root>/scripts/lib/.
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  try {
    // Strip a leading BOM: PowerShell 5.1 emits one unless the writer goes
    // out of its way not to, and JSON.parse throws on it outright.
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const fileCfg = loadConfigFile();

// Compact duplicates of llama-local-server/config.js's resolvers. Kept in
// step with that file by intent, not by import -- see the header for why this
// file may not reach across the repo boundary.
const EXE_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function findServerExe() {
  const roots = [
    process.env.LLAMA_CPP_DIR,
    path.join(os.homedir(), 'llama.cpp'),
    path.join(os.homedir(), 'src', 'llama.cpp'),
    path.join(os.homedir(), 'projects', 'llama.cpp'),
    process.platform === 'win32' ? 'C:\\llama.cpp' : '/opt/llama.cpp',
  ].filter(Boolean);
  const candidates = roots.flatMap((r) => [
    path.join(r, 'build', 'bin', 'Release', EXE_NAME),
    path.join(r, 'build', 'bin', EXE_NAME),
    path.join(r, 'bin', EXE_NAME),
    path.join(r, EXE_NAME),
  ]);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, EXE_NAME));
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return EXE_NAME; // let the spawn's 'error' event name it
}

// Ollama keeps a manifest per model reference that points at the content-
// addressed blob. Reading it is what replaced the pasted-in digest.
function resolveOllamaModel(ref) {
  const dir = process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
  const [name, tag = 'latest'] = String(ref).split(':');
  const parts = name.split('/');
  const repo = parts.length === 1 ? ['registry.ollama.ai', 'library', parts[0]] : ['registry.ollama.ai', ...parts];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifests', ...repo, tag), 'utf8'));
    const layer = (manifest.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
    if (!layer) return null;
    const blob = path.join(dir, 'blobs', layer.digest.replace(':', '-'));
    return fs.statSync(blob).isFile() ? blob : null;
  } catch {
    return null;
  }
}

const LLAMA_HOST = process.env.LLAMA_HOST || fileCfg.llamaHost || '127.0.0.1';
const LLAMA_PORT = Number(process.env.LLAMA_PORT) || Number(fileCfg.llamaPort) || 8090;
const LLAMA_MODEL = process.env.LLAMA_MODEL || fileCfg.llamaModel || 'llama3.2:latest';
const LLAMA_SERVER_EXE = process.env.LLAMA_SERVER_EXE || fileCfg.llamaServerExe || findServerExe();
const LLAMA_MODEL_PATH =
  process.env.LLAMA_MODEL_PATH || fileCfg.llamaModelPath || resolveOllamaModel(LLAMA_MODEL);

// Where llama-local-server/managed.js records who owns the shared instance.
// Duplicated for the same reason as everything else here, but the *path* must
// match exactly: it is the only thing that lets the watcher discover a server
// this skill started and shut it down when the last Claude session closes.
// Get it wrong and a one-shot skill call leaks a resident model.
const RUNTIME_DIR = process.env.LLAMA_RUNTIME_DIR || path.join(os.homedir(), '.claude', 'llama-local-server');
const RECORD_FILE = path.join(RUNTIME_DIR, 'chat-shared.json');

const BASE_URL = `http://${LLAMA_HOST}:${LLAMA_PORT}`;

async function isUp() {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Records this process's spawn in managed.js's ownership file so the watcher
// can stop it later. These scripts still never kill the server themselves --
// they are one-shot and other clients share the instance -- but "never kill
// it" used to mean "nobody ever kills it", and a skill call that happened to
// be the first thing to touch the port left a resident model behind for good.
// Writing the record hands the lifetime to the watcher, which stops the shared
// instance once no Claude Code session is live.
function recordSpawn(pid) {
  if (!pid) return;
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    const tmp = `${RECORD_FILE}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        {
          pid,
          port: LLAMA_PORT,
          host: LLAMA_HOST,
          model_path: LLAMA_MODEL_PATH,
          started_at: new Date().toISOString(),
          started_by: 'local-inference-skill',
        },
        null,
        2
      )
    );
    fs.renameSync(tmp, RECORD_FILE);
  } catch {
    // Best effort. Failing to record costs a leaked server, which is bad, but
    // failing the user's subtask over a bookkeeping write would be worse.
  }
}

// Mirrors llama-local-server/server.js's ensureRunning() -- reuses an
// already-running instance (the common case: token-monitor-core's watcher, or
// a previous invocation of one of these scripts, already has it up) and only
// spawns + waits if nothing answered. Throws if it can't get healthy; callers
// catch that and tell Claude to do the subtask itself.
async function ensureRunning() {
  if (await isUp()) return;

  if (!LLAMA_MODEL_PATH) {
    throw new Error(
      `no model found for '${LLAMA_MODEL}' -- pull it with \`ollama pull ${LLAMA_MODEL}\`, ` +
        `or set LLAMA_MODEL_PATH to a .gguf file`
    );
  }

  const child = spawn(
    LLAMA_SERVER_EXE,
    ['-m', LLAMA_MODEL_PATH, '-a', 'local', '--host', LLAMA_HOST, '--port', String(LLAMA_PORT), '-ngl', '999', '-c', '4096', '--no-warmup'],
    { stdio: 'ignore', detached: true }
  );
  child.unref?.();

  // An unhandled 'error' event on a ChildProcess is a hard throw in Node, and
  // a missing/wrong LLAMA_SERVER_EXE is the single most likely way this fails
  // on a machine that isn't the one it was built on. Capture it and bail
  // immediately rather than eating the full 30s timeout waiting on a process
  // that never started. (The watcher, being long-lived, never hits this --
  // it's specific to one-shot CLI use.)
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not start llama-server (${spawnError.message})`);
    if (await isUp()) {
      // Only once it is actually serving: recording a pid that never came up
      // would point the watcher's shutdown at a dead process.
      recordSpawn(child.pid);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('llama-server did not become healthy within 30s');
}

// Truncates from the middle (keeps head + tail) so both the start and end of
// arbitrarily long input survive -- matches
// token-monitor-core/lib/semantic-classifier.js's truncate().
function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-tail)}`;
}

// Plain-text completion -- one fetch, no retry loop. On any failure (server
// down, timeout, non-2xx, empty content) returns null; the caller decides
// what null means for its contract. Intentionally the same
// try/catch-and-return-null shape as token-monitor-core's llm-client.js and
// semantic-classifier.js: a momentarily-down or restarting llama-server is an
// expected condition on this machine, not an exceptional one worth building
// retry logic around.
async function chatText(systemPrompt, userContent, { maxTokens = 200, temperature = 0.2, timeoutMs = 20000 } = {}) {
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    return content || null;
  } catch {
    return null;
  }
}

// Structured completion via json_schema + strict:true -- grammar-constrained
// decoding, so an `enum` in the schema is a hard guarantee about the output
// rather than a request the 3B model may ignore. Returns the parsed object,
// or null on any failure (including a response that doesn't parse as JSON).
async function chatJSON(systemPrompt, userContent, schema, schemaName, { maxTokens = 300, temperature = 0.1, timeoutMs = 20000 } = {}) {
  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Every script here takes its input as one JSON object -- never as argv text
// -- specifically to dodge shell quoting: Claude may invoke these from
// PowerShell or from Git Bash, and arbitrary content (quotes, newlines,
// backticks, $) survives a file or a pipe intact where it would not survive
// being spliced into a command line.
//
// `--in <path>` is the preferred form and what SKILL.md tells Claude to use.
// Piping to stdin also works, but *only* safely from a POSIX shell: Windows
// PowerShell 5.1 re-encodes anything piped to a native exe through the
// console codepage, which silently mangles every non-ASCII character on the
// way in (verified: "R\u00E9sum\u00E9" arrives as "R\u00C3\u00A9sum\u00C3\u00A9"). Reading the file
// ourselves with an explicit utf8 decode sidesteps the shell entirely.
function readInputJSON(argv) {
  const i = argv.indexOf('--in');
  const file = i !== -1 ? argv[i + 1] : null;
  if (i !== -1 && !file) throw new Error('--in given with no file path');

  let raw;
  if (file) {
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`could not read --in file ${file}: ${err.message}`);
    }
  } else {
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch {
      throw new Error('failed to read stdin -- pass --in <file.json> or pipe a JSON payload in (see SKILL.md)');
    }
  }

  raw = raw.replace(/^\uFEFF/, '');
  if (!raw.trim()) throw new Error(`no input ${file ? `in ${file}` : 'on stdin'} -- expected a JSON payload (see SKILL.md)`);
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`input was not valid JSON: ${err.message}`);
  }
}

// Uniform failure exit for every script here: reason on stderr, exit 1.
// SKILL.md tells Claude exit 1 means "delegation itself failed (bad input,
// server unreachable/couldn't start, or an unusable model response) -- do the
// subtask yourself, don't retry the script."
function failAndExit(message) {
  console.error(`local-inference: ${message}`);
  process.exitCode = 1;
}

module.exports = { BASE_URL, isUp, ensureRunning, truncate, chatText, chatJSON, readInputJSON, failAndExit };
