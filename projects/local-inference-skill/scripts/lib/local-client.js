'use strict';

// Runs outside the suite once installed: require() nothing from it.
// see CLAUDE.md "local-client.js duplicates rather than requires"

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function loadConfigFile() {
  const configPath = path.join(__dirname, '..', '..', 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

const fileCfg = loadConfigFile();

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
    } catch { }
  }
  return EXE_NAME; // let the spawn's 'error' event name it
}

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

// Must match managed.js's path exactly -- see CLAUDE.md "The ownership record path"
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

/**
 * Writes the ownership record for a server this process started.
 *
 * Skipping this leaks a resident model -- see CLAUDE.md "The ownership record
 * path". This is a vendored copy of the record format, not a require across the
 * repo boundary, so anything that spawns a server can still be cleaned up by a
 * reaper that knows nothing about this skill.
 *
 * @param {number|null} pid No record is written for a falsy pid, since a record
 *   naming nothing cannot be verified before a kill.
 */
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
          // Stated rather than left to managed.js's default-on-missing. This
          // is the shared chat instance, which is supervised by design and
          // dies with the watcher -- not `idle`, which would reap a server
          // that exists to stay warm.
          last_used_at: new Date().toISOString(),
          reap_policy: 'supervised',
          idle_ttl_ms: 0,
        },
        null,
        2
      )
    );
    fs.renameSync(tmp, RECORD_FILE);
  } catch { }
}

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

  // Capturing this is what makes a bad exe path bail in ms, not 30s.
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not start llama-server (${spawnError.message})`);
    if (await isUp()) {
      // Only once it is serving: a recorded pid that never came up misdirects the watcher's kill.
      recordSpawn(child.pid);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('llama-server did not become healthy within 30s');
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-tail)}`;
}

/**
 * @param {string} systemPrompt
 * @param {string} userContent Always framed as data by the caller; this does no
 *   escaping of its own.
 * @param {{maxTokens?: number, temperature?: number, timeoutMs?: number}} [options]
 * @returns {Promise<string|null>} null on an unreachable server, a non-2xx, a
 *   timeout, or an empty completion. Never throws — callers fall back rather
 *   than fail.
 */
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

/**
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {object} schema A JSON Schema, sent with `strict: true` so the server
 *   constrains generation rather than the caller validating afterwards.
 * @param {string} schemaName
 * @param {{maxTokens?: number, temperature?: number, timeoutMs?: number}} [options]
 * @returns {Promise<object|null>} The parsed object, or null on any failure —
 *   including a reply that is not the schema. Never throws.
 */
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

/**
 * --in, never argv text, and stdin only from a POSIX shell -- see ../CLAUDE.md
 *
 * @param {string[]} argv
 * @returns {object} The parsed payload.
 * @throws {Error} If `--in` is given without a path, or the input is not JSON.
 */
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

function failAndExit(message) {
  console.error(`local-inference: ${message}`);
  process.exitCode = 1;
}

module.exports = { BASE_URL, isUp, ensureRunning, truncate, chatText, chatJSON, readInputJSON, failAndExit };
