'use strict';

const { spawn } = require('child_process');
const cfg = require('./config');
const ports = require('./ports');

const BASE_URL = `http://${cfg.LLAMA_HOST}:${cfg.LLAMA_PORT}`;

function baseUrlFor(port = cfg.LLAMA_PORT, host = cfg.LLAMA_HOST) {
  return `http://${host}:${port}`;
}

/**
 * @param {number} [port]
 * @param {string} [host]
 * @returns {Promise<boolean>} Whether `/health` answers — a liveness probe of
 *   the socket, not of any record. Never throws.
 */
async function isUp(port = cfg.LLAMA_PORT, host = cfg.LLAMA_HOST) {
  try {
    const res = await fetch(`${baseUrlFor(port, host)}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts a llama-server on the given port unless one already answers there.
 *
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.modelPath]
 * @param {string} [opts.exePath]
 * @param {string} [opts.alias]
 * @param {number} [opts.contextSize]
 * @param {number} [opts.gpuLayers]
 * @param {string[]} [opts.extraArgs]
 * @param {boolean} [opts.detached] Required for anything meant to outlive the
 *   caller, which is nearly everything here.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{owned: boolean, proc: object|null, baseUrl: string}>}
 *   `owned` is a **per-process** contract: true only if *this* call spawned it.
 *   It cannot express "live as long as someone needs it", which is why anything
 *   shared goes through managed.js and its on-disk records instead -- see
 *   CLAUDE.md "For the shared instance, use managed.js".
 */
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

/**
 * Preferred over ensureRunning for anything but the shared chat instance: the
 * port comes from the registry and is checked before spawning.
 *
 * @param {string} name A registered claim.
 * @param {object} [opts] As ensureRunning, minus `port`.
 * @returns {Promise<{owned: boolean, proc: object|null, baseUrl: string}>}
 * @throws {Error} If `opts.port` disagrees with the registry, or the port is
 *   occupied by something that is not a reusable instance of the same model.
 */
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
