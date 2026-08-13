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

// Reuses an already-running server on the target port (e.g. one started by a
// previous run, or by another process on this machine) instead of
// double-spawning. Returns the child handle only when this call is the one
// that started it, so callers know whether they own its lifecycle.
//
// Multi-instance by design: `llama-server.exe`'s --embedding is an exclusive
// server *mode*, so embeddings need their own process on their own port with
// a dedicated model. Rather than have each consumer copy this function, pass
// the differences in. Every option defaults to the shared chat instance, so
// ensureRunning() with no arguments behaves exactly as it always has.
//
//   ensureRunning()                                   // shared chat server, :8090
//   ensureRunning({ port: 8091, modelPath: EMBED,     // dedicated embedding server
//                   extraArgs: ['--embedding', '-b', '2048', '-ub', '2048'],
//                   detached: true })
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
    // false = child dies with the parent (right for a long-lived daemon).
    // true  = survives (right for one-shot CLI callers, which would
    //         otherwise re-pay model load on every invocation).
    detached = false,
    timeoutMs = 30000,
  } = opts;

  if (await isUp(port, host)) return { owned: false, proc: null, baseUrl: baseUrlFor(port, host) };

  // config.js resolves the model rather than hardcoding a path, so "not
  // found" is now a real state and it must be reported here, in terms of what
  // to do about it. Left unchecked it reaches spawn() as `-m null`, which
  // llama-server rejects by exiting immediately -- surfacing as the health
  // loop's useless "did not become healthy after 30s".
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

  // A spawn failure (bad exe path being the likeliest) arrives as an 'error'
  // EVENT, not a thrown exception -- and an unhandled 'error' on a
  // ChildProcess is a hard crash with a stack trace. Capture it so callers
  // get a clean message immediately instead of either crashing or sitting
  // through the full health-check timeout waiting for a process that never
  // started. Two separate agents hit this independently before it was fixed.
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

// The preferred entry point for anything that is not the shared chat
// instance. Same as ensureRunning(), except the port comes from the registry
// (./ports) by name instead of being hardcoded in the caller's config, and
// the port is checked *before* spawning.
//
// That pre-check is the whole point. Without it, a taken port means
// llama-server.exe fails to bind, exits at once, and the loop above spends
// 30s to report "did not become healthy" -- true, useless. Worse, if the
// squatter happens to be some *other* llama-server, isUp() says yes and you
// silently get answers from the wrong model. assertAvailable() names the
// occupant and its model instead.
//
// Add the claim to ports.js first, then:
//
//   ensureRunningFor('my-embedding-server', {
//     modelPath: cfg.EMBED_MODEL_PATH,
//     extraArgs: ['--embedding', '-b', '2048', '-ub', '2048'],
//     detached: true,
//   })
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
