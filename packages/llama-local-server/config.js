'use strict';

// Resolution order for both machine-specific values: env var ->
// ./config.local.js (gitignored) -> discovery. Nothing here throws when
// resolution fails -- see CLAUDE.md "Machine-specific config is resolved".

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

function loadLocalOverrides() {
  try {
    return require('./config.local.js') || {};
  } catch {
    return {};
  }
}
const local = loadLocalOverrides();

function firstExistingFile(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// llama-server.exe
// ---------------------------------------------------------------------------

const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

// The layouts a llama.cpp build actually produces: CMake on Windows puts
// binaries under build/bin/<Config>/, the Makefile build drops them in the
// repo root, and the prebuilt release zips unpack flat.
function llamaCppCandidates(root) {
  return [
    path.join(root, 'build', 'bin', 'Release', EXE),
    path.join(root, 'build', 'bin', EXE),
    path.join(root, 'build', 'Release', EXE),
    path.join(root, 'build', EXE),
    path.join(root, 'bin', EXE),
    path.join(root, EXE),
  ];
}

function discoverServerExe() {
  const suiteParent = path.resolve(__dirname, '..', '..', '..');
  const roots = [
    process.env.LLAMA_CPP_DIR,
    path.join(suiteParent, 'llama.cpp'),
    path.join(HOME, 'llama.cpp'),
    path.join(HOME, 'src', 'llama.cpp'),
    path.join(HOME, 'projects', 'llama.cpp'),
    process.platform === 'win32' ? 'C:\\llama.cpp' : '/opt/llama.cpp',
    process.platform === 'win32' ? 'C:\\tools\\llama.cpp' : '/usr/local/opt/llama.cpp',
  ].filter(Boolean);

  const built = firstExistingFile(roots.flatMap(llamaCppCandidates));
  if (built) return built;

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const onPath = firstExistingFile(pathDirs.map((d) => path.join(d, EXE)));
  if (onPath) return onPath;

  // The bare name rather than null, so the spawn's own 'error' event reports a
  // path-shaped value (server.js names the exe it tried).
  return EXE;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

// Ollama stores a pulled model as content-addressed blobs plus a manifest that
// maps a human reference ("llama3.2:latest") onto them. Use this rather than
// pasting a digest, which is correct on exactly one machine.
function resolveOllamaModel(ref, { modelsDir } = {}) {
  const dir = modelsDir || process.env.OLLAMA_MODELS || path.join(HOME, '.ollama', 'models');
  const [nameWithRepo, tag = 'latest'] = String(ref).split(':');
  const parts = nameWithRepo.split('/');
  // Bare "llama3.2" means the official library namespace.
  const repo = parts.length === 1 ? ['registry.ollama.ai', 'library', parts[0]] : ['registry.ollama.ai', ...parts];

  const manifestPath = path.join(dir, 'manifests', ...repo, tag);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }

  const layer = (manifest.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
  if (!layer || !layer.digest) return null;

  // Blobs are stored with the digest's ':' replaced by '-'.
  const blob = path.join(dir, 'blobs', layer.digest.replace(':', '-'));
  try {
    return fs.statSync(blob).isFile() ? blob : null;
  } catch {
    return null;
  }
}

// A reference, not a path, so it stays meaningful across machines and cannot
// drift from ports.js's human-readable claim.
const LLAMA_MODEL = process.env.LLAMA_MODEL || local.LLAMA_MODEL || 'llama3.2:latest';

function discoverModelPath() {
  const fromOllama = resolveOllamaModel(LLAMA_MODEL);
  if (fromOllama) return fromOllama;

  // A loose GGUF in a models/ dir, for people not using Ollama at all.
  const suiteRoot = path.resolve(__dirname, '..', '..');
  for (const dir of [process.env.LLAMA_MODEL_DIR, path.join(suiteRoot, 'models'), path.join(HOME, 'models')]) {
    if (!dir) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const gguf = entries.filter((f) => f.toLowerCase().endsWith('.gguf')).sort();
    if (gguf.length) return path.join(dir, gguf[0]);
  }

  return null;
}

module.exports = {
  LLAMA_SERVER_EXE: process.env.LLAMA_SERVER_EXE || local.LLAMA_SERVER_EXE || discoverServerExe(),
  LLAMA_MODEL,
  LLAMA_MODEL_PATH: process.env.LLAMA_MODEL_PATH || local.LLAMA_MODEL_PATH || discoverModelPath(),
  LLAMA_HOST: process.env.LLAMA_HOST || local.LLAMA_HOST || '127.0.0.1',
  LLAMA_PORT: Number(process.env.LLAMA_PORT) || local.LLAMA_PORT || 8090,

  // Machine-level, not the suite's `state/` dir: installed skill copies and
  // separate repos start these servers too and must compute the same path.
  // See CLAUDE.md "For the shared instance, use managed.js".
  LLAMA_RUNTIME_DIR: process.env.LLAMA_RUNTIME_DIR || path.join(HOME, '.claude', 'llama-local-server'),

  resolveOllamaModel,
};
