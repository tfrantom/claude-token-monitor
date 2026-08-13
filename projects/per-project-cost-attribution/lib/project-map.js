'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// cwd -> project resolution.
//
// Three candidate roots, and the DEEPEST one wins rather than a fixed
// priority order:
//
//   1. override  -- longest matching prefix in cfg.PROJECT_OVERRIDES
//   2. git       -- nearest ancestor containing `.git` (dir for a normal
//                   clone, file for a worktree/submodule)
//   3. workspace -- nearest ancestor that is an immediate child of one of
//                   cfg.WORKSPACE_ROOTS
//
// Why deepest-wins instead of "git first": a workspace root that itself
// becomes a repo one day (`git init C:\projects`) would otherwise collapse
// every sub-project into one bucket. Deepest-wins keeps
// `C:\projects\bug-me-claude` resolving to `bug-me-claude` either way.
//
// The suite counter-example from the brief is decided here deliberately:
// `claude-token-monitor` has no `.git`, so rule 3 fires and
// `...\claude-token-monitor\packages\token-monitor-core` rolls up to the
// suite, NOT to the package. The package-level detail is not lost -- every
// distinct cwd is still reported as a `paths[]` slice under its project,
// with a `subpath` relative to the project root. Rolling up is the default
// because a suite is one unit of work; splitting it is one line in
// PROJECT_OVERRIDES if that ever stops being true.

const cache = new Map();

function norm(p) {
  if (!p) return null;
  return path.resolve(p);
}

function ancestors(dir) {
  const out = [];
  let cur = dir;
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out; // deepest first
}

function gitRoot(dir) {
  for (const a of ancestors(dir)) {
    if (fs.existsSync(path.join(a, '.git'))) return a;
  }
  return null;
}

function workspaceChildRoot(dir) {
  const roots = cfg.WORKSPACE_ROOTS.map(norm).filter(Boolean);
  for (const a of ancestors(dir)) {
    const parent = path.dirname(a);
    if (parent === a) continue;
    if (roots.some((r) => pathEq(r, parent))) return a;
  }
  return null;
}

function pathEq(a, b) {
  // Windows paths are case-insensitive; comparing raw strings mis-buckets
  // `C:\Projects\foo` against `C:\projects\foo`.
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isUnder(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function overrideRoot(dir) {
  let best = null;
  for (const [prefix, name] of Object.entries(cfg.PROJECT_OVERRIDES || {})) {
    const p = norm(prefix);
    if (!isUnder(dir, p)) continue;
    if (!best || p.length > best.root.length) best = { root: p, name };
  }
  return best;
}

// -> { project, project_root, resolver, subpath }
function resolveProject(cwd) {
  const dir = norm(cwd);
  if (!dir) {
    return { project: '(unknown)', project_root: null, resolver: 'none', subpath: null };
  }
  if (cache.has(dir)) return cache.get(dir);

  const candidates = [];
  const ov = overrideRoot(dir);
  if (ov) candidates.push({ root: ov.root, resolver: 'override', name: ov.name });
  const g = gitRoot(dir);
  if (g) candidates.push({ root: g, resolver: 'git', name: path.basename(g) });
  const w = workspaceChildRoot(dir);
  if (w) candidates.push({ root: w, resolver: 'workspace-child', name: path.basename(w) });

  let winner = null;
  for (const c of candidates) {
    if (!winner || c.root.length > winner.root.length) winner = c;
    // Tie on depth: earlier candidate (override > git > workspace) keeps it.
  }
  if (!winner) {
    if (cfg.WORKSPACE_ROOTS.map(norm).some((r) => r && pathEq(r, dir))) {
      // Sitting at the workspace root itself: real work, but genuinely not
      // attributable to any sub-project. Labelled distinctly rather than as
      // a project named after the root, because that row reads exactly like
      // the coarse `C--projects` bucket this whole project exists to split
      // up, and conflating the two would be the worst possible outcome.
      winner = { root: dir, resolver: 'workspace-root', name: `${path.basename(dir)} (root)` };
    } else {
      // Somewhere outside every workspace root and not in a repo -- the
      // directory is its own project rather than being silently merged with
      // unrelated siblings.
      winner = { root: dir, resolver: 'cwd', name: path.basename(dir) || dir };
    }
  }

  const rel = path.relative(winner.root, dir);
  const result = {
    project: winner.name,
    project_root: winner.root,
    resolver: winner.resolver,
    subpath: rel === '' ? '.' : rel.split(path.sep).join('/'),
  };
  cache.set(dir, result);
  return result;
}

module.exports = { resolveProject, _internals: { gitRoot, workspaceChildRoot, isUnder } };
