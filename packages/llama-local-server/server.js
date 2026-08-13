'use strict';

const { spawn } = require('child_process');
const cfg = require('./config');
const ports = require('./ports');

const BASE_URL = `http://${cfg.LLAMA_HOST}:${cfg.LLAMA_PORT}`;

function baseUrlFor(port = cfg.LLAMA_PORT, host = cfg.LLAMA_HOST) {
  return `http://${host}:${port}`;
}

async function isUp(port = cfg.LLAMA_PORT, host = cfg.LLAMA_HOST) {
  try {
    const res = await fetch(`${baseUrlFor(port, host)}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// `owned` is a per-process contract and is not enough for the shared instance
// -- see CLAUDE.md "For the shared instance, use managed.js".
async function ensureRunning(opts = {}) {
  const {
    host = cfg.LLAMA_HOST,
    port = cfg.LLAMA_PORT,
    modelPath = cfg.LLAMA_MODEL_PATH,
    exePath = cfg.LLAMA_SERVER_EXE,
    alias = 'local',
    contextSize = 4096,
    gpuLayers = 999,
    extraArgs = [],
    detached = false,
    timeoutMs = 30000,
  } = opts;

  if (await isUp(port, host)) return { owned: false, proc: null, baseUrl: baseUrlFor(port, host) };

  if (!modelPath) {
    throw new Error(
      `no model found for '${cfg.LLAMA_MODEL}'. Pull it (\`ollama pull ${cfg.LLAMA_MODEL}\`), ` +
        `or set LLAMA_MODEL_PATH to a .gguf, or set LLAMA_MODEL to a model you already have.`
    );
  }

  const args = [
    '-m', modelPath,
    '-a', alias,
    '--host', host,
    '--port', String(port),
    '-ngl', String(gpuLayers),
    '-c', String(contextSize),
    '--no-warmup',
    ...extraArgs,
  ];

  const child = spawn(exePath, args, { stdio: 'ignore', detached });

  // Capturing this is required -- see CLAUDE.md "Spawn failures arrive as an
  // event, not a throw".
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = err;
  });

  child.unref?.();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new Error(`failed to start llama-server (${exePath}): ${spawnError.message}`);
    }
    if (await isUp(port, host)) return { owned: true, proc: child, baseUrl: baseUrlFor(port, host) };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

// Preferred over ensureRunning for anything but the shared chat instance: the
// port comes from the registry and is checked before spawning.
async function ensureRunningFor(name, opts = {}) {
  const claim = ports.get(name);

  if (opts.port != null && opts.port !== claim.port) {
    throw new Error(
      `ensureRunningFor('${name}') was passed port ${opts.port}, but the registry ` +
        `claims ${claim.port} for it. Change the claim in ports.js -- that is the ` +
        `single place a port is decided.`
    );
  }

  const host = opts.host ?? claim.host;
  const modelPath = opts.modelPath ?? cfg.LLAMA_MODEL_PATH;

  const { reuse } = await ports.assertAvailable(name, { expectModelPath: modelPath, host });
  if (reuse) {
    return { owned: false, proc: null, baseUrl: baseUrlFor(claim.port, host) };
  }

  return ensureRunning({
    alias: claim.alias || name,
    ...opts,
    host,
    port: claim.port,
    modelPath,
  });
}

module.exports = { ensureRunning, ensureRunningFor, isUp, baseUrlFor, BASE_URL, ports };
