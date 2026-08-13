'use strict';

// per-project-cost-attribution CLI.
//
//   node attribute.js                        rollup by project, all history
//   node attribute.js --since 7d             ...last 7 days of transcripts
//   node attribute.js --by path              break down by cwd, not project
//   node attribute.js --by session,project   any combination of dimensions
//   node attribute.js --session <id>         one session, per-project detail
//   node attribute.js --ended-only           only sessions whose cost is final
//   node attribute.js --json                 full nested report
//   node attribute.js --jsonl                flat slice rows (history-ready)
//   node attribute.js --no-subagents         main transcripts only
//
// Reads transcripts and token-monitor-core's status.json. Writes nothing.

const { parseTranscript, attributeSession } = require('./lib/attribute');
const { findTranscripts, loadStatus, sessionMeta } = require('./lib/sources');
const { toSliceRows, rollup, sumTotals } = require('./lib/report');

const DIMENSION_ALIASES = {
  project: 'project',
  path: 'cwd',
  cwd: 'cwd',
  session: 'session_id',
  claude_project: 'claude_project',
  root: 'project_root',
  subpath: 'subpath',
  agent: 'agent',
  agent_type: 'agent_type',
  resolver: 'resolver',
};

function parseArgs(argv) {
  const args = { by: ['project'], json: false, jsonl: false, endedOnly: false, since: null, session: null, claudeProject: null, limit: 0, subagents: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--json': args.json = true; break;
      case '--jsonl': args.jsonl = true; break;
      case '--ended-only': args.endedOnly = true; break;
      case '--no-subagents': args.subagents = false; break;
      case '--by': args.by = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--since': args.since = parseSince(next()); break;
      case '--session': args.session = next(); break;
      case '--claude-project': args.claudeProject = next(); break;
      case '--limit': args.limit = parseInt(next(), 10) || 0; break;
      case '-h': case '--help': args.help = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function parseSince(s) {
  const m = /^(\d+)([hdwm])$/.exec(String(s).trim());
  if (!m) throw new Error(`--since expects e.g. 24h, 7d, 2w (got ${s})`);
  const n = Number(m[1]);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2]];
  return Date.now() - n * ms;
}

function usd(n) {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function tok(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((c, i) => (columns[i].right ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ');
  const out = [line(columns.map((c) => c.header)), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join('\n');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    const header = [];
    for (const line of require('fs').readFileSync(__filename, 'utf8').split('\n').slice(2)) {
      if (!line.startsWith('//')) break;
      header.push(line.replace(/^\/\/ ?/, ''));
    }
    console.log(header.join('\n'));
    return;
  }

  const status = loadStatus();
  let files = findTranscripts({ since: args.since, project: args.claudeProject });
  if (args.session) files = files.filter((f) => f.sessionId === args.session || f.sessionId.startsWith(args.session));
  if (files.length === 0) {
    console.error('no transcripts matched');
    process.exit(1);
  }

  const generatedAt = new Date().toISOString();
  const sessions = [];
  for (const f of files) {
    const meta = sessionMeta(status, f.sessionId);
    if (args.endedOnly && meta.ended !== true) continue;
    const parses = [parseTranscript(f.path)].filter(Boolean);
    if (parses.length === 0) continue;
    if (args.subagents) {
      for (const a of f.agents) {
        const p = parseTranscript(a.path, { agent: a.agent, agent_type: a.agent_type, agent_description: a.agent_description });
        if (p) parses.push(p);
      }
    }
    sessions.push(attributeSession(parses, { claude_project: f.claudeProject, ...meta }));
  }
  if (sessions.length === 0) {
    console.error('no sessions left after filtering');
    process.exit(1);
  }

  const rows = sessions.flatMap((s) => toSliceRows(s, { generatedAt }));

  if (args.jsonl) {
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }
  if (args.json) {
    console.log(JSON.stringify({
      schema: 'tm.attribution.report/1',
      generated_at: generatedAt,
      filters: { since: args.since, session: args.session, claude_project: args.claudeProject, ended_only: args.endedOnly },
      sessions,
    }, null, 2));
    return;
  }

  const dims = args.by.map((d) => {
    const mapped = DIMENSION_ALIASES[d];
    if (!mapped) throw new Error(`unknown dimension: ${d} (known: ${Object.keys(DIMENSION_ALIASES).join(', ')})`);
    return mapped;
  });

  let grouped = rollup(rows, dims);
  if (args.limit) grouped = grouped.slice(0, args.limit);
  const grand = sumTotals(rows);

  const columns = [
    ...dims.map((d) => ({ header: d, get: (r) => (r[d] === null ? '-' : shortenPath(String(r[d]))) })),
    { header: 'cost', right: true, get: (r) => usd(r.totals.cost_usd) },
    { header: '%', right: true, get: (r) => `${((r.totals.cost_usd / (grand.cost_usd || 1)) * 100).toFixed(1)}%` },
    { header: 'turns', right: true, get: (r) => r.turns },
    { header: 'sess', right: true, get: (r) => r.sessions },
    { header: 'out(think/write/tool)', right: true, get: (r) => `${tok(r.totals.thinking)}/${tok(r.totals.writing)}/${tok(r.totals.tool_calls)}` },
    { header: 'cache r/w', right: true, get: (r) => `${tok(r.totals.cache_read)}/${tok(r.totals.cache_write)}` },
    { header: 'last', get: (r) => (r.last_activity || '').slice(0, 16).replace('T', ' ') },
  ];

  const scope = [
    `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
    args.since ? `since ${new Date(args.since).toISOString().slice(0, 16).replace('T', ' ')}` : 'all history',
    args.endedOnly ? 'ended only' : null,
  ].filter(Boolean).join(', ');
  console.log(`per-project cost attribution -- ${scope}\n`);
  console.log(table(grouped, columns));
  console.log(`\ntotal ${usd(grand.cost_usd)} across ${rows.length} slices`);

  const conflicts = sessions.reduce((n, s) => n + s.cwd_stability.turns_with_cwd_conflict, 0);
  if (conflicts > 0) {
    console.log(`note: ${conflicts} turn(s) had lines disagreeing on cwd; each was attributed whole to its first line's cwd`);
  }
  const unattributed = sessions.filter((s) => s.unattributed).length;
  if (unattributed > 0) console.log(`note: ${unattributed} session(s) had turns with no cwd at all (see the (unattributed) row)`);
}

// Home/workspace prefixes are the same on every row and just push the
// interesting tail off the terminal.
function shortenPath(s) {
  return s.replace(/^C:\\projects\\/i, '~p\\').replace(/^C:\\projects$/i, '~p').replace(new RegExp(`^${process.env.USERPROFILE ? process.env.USERPROFILE.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&') : '\u0000'}`, 'i'), '~');
}

main();
