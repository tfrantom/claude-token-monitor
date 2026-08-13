'use strict';

// node verify.js [--since 7d] -- see CLAUDE.md "Verification"

const path = require('path');
const { parseTranscript, attributeSession, TOTALS_KEYS } = require('./lib/attribute');
const { findTranscripts, loadStatus, sessionMeta } = require('./lib/sources');
const { resolveProject } = require('./lib/project-map');
const { toSliceRows, sumTotals } = require('./lib/report');

const { classifySession } = require('../../packages/token-monitor-core/lib/transcript');

const EPS = 1e-9;

function parseSince(s) {
  const m = /^(\d+)([hdwm])$/.exec(String(s).trim());
  if (!m) throw new Error(`--since expects e.g. 24h, 7d, 2w (got ${s})`);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2]];
  return Date.now() - Number(m[1]) * ms;
}

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks += 1;
  if (ok) return true;
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  return false;
}

function closeEnough(a, b) {
  return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

function main() {
  const argv = process.argv.slice(2);
  let since = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--since') since = parseSince(argv[++i]);
  }

  const status = loadStatus();
  const files = findTranscripts({ since });
  if (files.length === 0) {
    // Exit 3 is SKIP -- see ../CLAUDE.md "Adding a check"
    console.log('no transcripts found -- nothing to verify');
    process.exit(3);
  }

  console.log(`verifying ${files.length} session(s) from ${path.dirname(path.dirname(files[0].path))}\n`);

  const stability = {
    files: 0,
    turns: 0,
    turnsWithConflict: 0,
    multiCwdSessions: 0,
    transitions: 0,
    entriesWithoutCwd: 0,
  };
  const resolvers = new Map();
  let subagentCost = 0;
  let mainCost = 0;

  for (const f of files) {
    const label = `${f.claudeProject}/${f.sessionId.slice(0, 8)}`;
    const mainParse = parseTranscript(f.path);
    if (!mainParse) {
      check(false, label, 'unreadable transcript');
      continue;
    }

    const ref = classifySession(f.path);
    if (ref) {
      const bad = TOTALS_KEYS.filter((k) => !closeEnough(mainParse.totals[k], ref.totals[k]));
      check(
        bad.length === 0,
        `${label} reconciles with classifySession()`,
        bad.map((k) => `${k}: ours=${mainParse.totals[k]} theirs=${ref.totals[k]}`).join(', ')
      );
    }

    const parses = [mainParse];
    for (const a of f.agents) {
      const p = parseTranscript(a.path, { agent: a.agent, agent_type: a.agent_type, agent_description: a.agent_description });
      if (p) parses.push(p);
    }

    const session = attributeSession(parses, { claude_project: f.claudeProject, ...sessionMeta(status, f.sessionId) });

    const rows = toSliceRows(session);
    const summed = sumTotals(rows);
    const bad = TOTALS_KEYS.filter((k) => !closeEnough(summed[k], session.totals[k]));
    check(
      bad.length === 0,
      `${label} slices sum to session total`,
      bad.map((k) => `${k}: slices=${summed[k]} session=${session.totals[k]}`).join(', ')
    );
    const turnSum = rows.reduce((n, r) => n + r.turns, 0);
    check(turnSum === session.turns, `${label} turn counts partition`, `slices=${turnSum} session=${session.turns}`);

    for (const p of parses) {
      stability.files += 1;
      stability.turns += p.turns;
      stability.turnsWithConflict += p.cwd_stability.turns_with_cwd_conflict;
      stability.transitions += p.cwd_stability.transitions;
    }
    if (session.cwd_stability.distinct_cwds > 1) stability.multiCwdSessions += 1;
    if (session.unattributed) stability.entriesWithoutCwd += session.unattributed.turns;

    for (const p of session.attribution) {
      resolvers.set(p.resolver, (resolvers.get(p.resolver) || 0) + 1);
    }
    mainCost += session.main_totals.cost_usd;
    subagentCost += session.totals.cost_usd - session.main_totals.cost_usd;
  }

  const suite = 'C:\\projects\\claude-token-monitor';
  const cases = [
    [`${suite}\\packages\\token-monitor-core`, 'claude-token-monitor', 'suite package rolls up to the suite'],
    [suite, 'claude-token-monitor', 'suite root is the suite'],
    ['C:\\projects\\bug-me-claude\\bin', 'bug-me-claude', 'git repo subdir rolls up to the repo'],
    ['C:\\projects', 'projects (root)', 'workspace root is labelled, not treated as a project'],
  ];
  console.log('\nresolver spot-checks');
  for (const [cwd, expect, why] of cases) {
    const r = resolveProject(cwd);
    check(r.project === expect, `${why}`, `${cwd} -> ${r.project} (${r.resolver}), expected ${expect}`);
    console.log(`  ${r.project === expect ? 'ok  ' : '    '} ${cwd}  ->  ${r.project}  [${r.resolver}]  subpath=${r.subpath}`);
  }

  console.log('\ncwd stability');
  console.log(`  transcript files parsed        ${stability.files}`);
  console.log(`  API turns                      ${stability.turns}`);
  console.log(`  turns whose lines disagreed    ${stability.turnsWithConflict}   <- 0 means cwd is turn-stable`);
  console.log(`  cwd transitions between turns  ${stability.transitions}`);
  console.log(`  sessions spanning >1 cwd       ${stability.multiCwdSessions}`);
  console.log(`  turns with no cwd at all       ${stability.entriesWithoutCwd}`);

  console.log('\nresolver usage across real sessions');
  for (const [r, n] of [...resolvers.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(16)} ${n}`);

  console.log('\nsubagent contribution');
  console.log(`  main transcripts   $${mainCost.toFixed(2)}`);
  console.log(`  subagents          $${subagentCost.toFixed(2)}`);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
