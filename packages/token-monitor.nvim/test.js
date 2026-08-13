#!/usr/bin/env node
'use strict';

// Runs test.lua under headless Neovim. Exits 3 (run-checks reads that as SKIP)
// when nvim is absent -- this package's tests need the real Lua runtime and a
// machine without Neovim is not a failing machine.

const { spawnSync } = require('child_process');
const path = require('path');

const HERE = __dirname;

function findNvim() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['nvim'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  return null;
}

const nvim = findNvim();
if (!nvim) {
  console.log('nvim not on PATH -- nothing to run these Lua checks with');
  process.exit(3);
}

const r = spawnSync(nvim, ['--clean', '--headless', '-c', 'luafile test.lua', '-c', 'qa!'], {
  cwd: HERE,
  encoding: 'utf8',
  timeout: 60_000,
  windowsHide: true,
});

// Headless nvim writes print() to stderr.
const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
if (out) console.log(out);

if (r.error) {
  console.log(`could not run nvim: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status === 0 ? 0 : 1);
