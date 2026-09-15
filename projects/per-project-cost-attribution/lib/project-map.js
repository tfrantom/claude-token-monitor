'use strict';

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

// see CLAUDE.md "cwd -> project: deepest of three candidate roots"

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
  // Case-insensitive on Windows, or `C:\Projects\foo` mis-buckets against `C:\projects\foo`.
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

/**
 * Which repo a working directory belongs to.
 *
 * @param {string} cwd
 * @returns {{project: string, project_root: string|null, resolver: string, subpath: string|null}}
 *   `resolver` names which rule decided — an explicit override, a workspace
 *   child, a git root, or none. **Deepest root wins**, so a package inside a
 *   monorepo is attributed to the package, not the outer repo.
 *   `'(unknown)'` for an unresolvable cwd; results are memoised per directory.
 */
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
    // `>` not `>=`: on a depth tie the earlier candidate (override > git > workspace) keeps it.
    if (!winner || c.root.length > winner.root.length) winner = c;
  }
  if (!winner) {
    if (cfg.WORKSPACE_ROOTS.map(norm).some((r) => r && pathEq(r, dir))) {
      winner = { root: dir, resolver: 'workspace-root', name: `${path.basename(dir)} (root)` };
    } else {
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
