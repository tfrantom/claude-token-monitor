#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { auditSource, applyFindings, parseRanges } = require('./lib/audit');
const { isQuiescent } = require('./lib/quiescence');
const cfg = require('./config');

const HELP = `audit.js -- report comments that a repo's own conventions say should not exist

  node audit.js <file>...            report findings (never writes)
  node audit.js --json <file>...     same, as one JSON object on stdout
  node audit.js --rules-only <file>  deterministic pass only, no model call
  node audit.js --apply <file>...    delete 'remove' findings, if the file is quiescent
  node audit.js --apply --force ...  apply without the quiescence check

  --lines 12,40-58          audit only comments touching these lines (see CLAUDE.md:
                            whole-file model findings are mostly noise on curated code)
  --min-confidence <0..1>   below this a removal is downgraded to review (default ${cfg.MIN_CONFIDENCE})
  --no-cache                re-ask the model instead of reusing a stored verdict
  --fail-on-findings        exit 1 when anything is reported (for CI)

Exit codes: 0 ran, 1 error (or findings with --fail-on-findings), 3 nothing auditable.`;

function parseArgs(argv) {
  const opts = { files: [], json: false, rulesOnly: false, apply: false, force: false, failOnFindings: false, minConfidence: cfg.MIN_CONFIDENCE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--rules-only') opts.rulesOnly = true;
    else if (a === '--apply') opts.apply = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--fail-on-findings') opts.failOnFindings = true;
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--lines') opts.lines = parseRanges(argv[++i]);
    else if (a === '--min-confidence') opts.minConfidence = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown argument: ${a}  (try --help)`);
    else opts.files.push(a);
  }
  return opts;
}

const MARK = { remove: '-', relocate: '~', review: '?' };

function printReport(file, result, applied) {
  const rel = path.relative(process.cwd(), file) || file;
  if (result.findings.length === 0) {
    console.log(`${rel}: clean (${result.scanned} comment${result.scanned === 1 ? '' : 's'})`);
    return;
  }
  console.log(`\n${rel}`);
  for (const f of result.findings) {
    const where = f.lines > 1 ? `L${f.line}-${f.endLine}` : `L${f.line}`;
    const src = f.by === 'rule' ? f.rule : `${Math.round(f.confidence * 100)}%`;
    console.log(`  ${MARK[f.verdict] || ' '} ${where.padEnd(9)} ${f.label.padEnd(18)} ${src}`);
    console.log(`      ${f.text.split('\n')[0].slice(0, 68)}`);
    console.log(`      ${f.advice}`);
  }
  const counts = result.findings.reduce((acc, f) => ({ ...acc, [f.verdict]: (acc[f.verdict] || 0) + 1 }), {});
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`  ${result.scanned} scanned, ${summary}${result.degraded ? ' (model incomplete — rules only for the rest)' : ''}`);
  if (applied) console.log(`  applied: ${applied} removed`);
}

async function auditFile(file, opts) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { file, error: `could not read: ${err.message}` };
  }
  const result = await auditSource(source, file, {
    rulesOnly: opts.rulesOnly,
    minConfidence: opts.minConfidence,
    cache: opts.cache,
    lines: opts.lines,
  });
  if (result.unsupported) return { file, error: 'no scanner for this file type', unsupported: true };

  let applied = 0;
  if (opts.apply) {
    const removals = result.findings.filter((f) => f.verdict === 'remove');
    if (removals.length > 0) {
      const gate = opts.force ? { ok: true, reason: 'forced' } : isQuiescent(file);
      if (!gate.ok) {
        result.blocked = gate.reason;
      } else {
        fs.writeFileSync(file, applyFindings(source, result.findings), 'utf8');
        applied = removals.length;
      }
    }
  }
  return { file, ...result, applied };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.files.length === 0) {
    console.error('no files given (try --help)');
    return 1;
  }

  const results = [];
  for (const file of opts.files) results.push(await auditFile(file, opts));

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) console.log(`${path.relative(process.cwd(), r.file) || r.file}: ${r.error}`);
      else printReport(r.file, r, r.applied);
      if (r.blocked) console.log(`  not applied: ${r.blocked}`);
    }
  }

  const auditable = results.filter((r) => !r.unsupported);
  if (auditable.length === 0) {
    console.error('nothing auditable — no supported file types given');
    return 3;
  }
  if (results.some((r) => r.error && !r.unsupported)) return 1;
  const total = auditable.reduce((n, r) => n + (r.findings ? r.findings.length : 0), 0);
  return opts.failOnFindings && total > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`comment-auditor: ${err.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { auditFile, parseArgs };
