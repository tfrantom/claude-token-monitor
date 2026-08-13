'use strict';

const { scanComments } = require('./scanner');
const { triage, verdictFor, ADVICE } = require('./policy');
const { classifyComments } = require('./classify');
const { cached } = require('./cache');
const cfg = require('../config');

// A leading comment owns its whole lines; a trailing one owns only itself and
// the whitespace holding it off the code.
function cutFor(source, comment) {
  if (comment.trailing) {
    let start = comment.start;
    while (start > 0 && /[ \t]/.test(source[start - 1])) start -= 1;
    return { start, end: comment.end };
  }
  let start = comment.start;
  while (start > 0 && /[ \t]/.test(source[start - 1])) start -= 1;
  let end = comment.end;
  if (source[end] === '\r') end += 1;
  if (source[end] === '\n') end += 1;
  return { start, end };
}

// `ranges` is [[from, to], ...], 1-based and inclusive.
function overlaps(comment, ranges) {
  return ranges.some(([from, to]) => comment.endLine >= from && comment.line <= to);
}

function parseRanges(spec) {
  const ranges = [];
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad line range: "${part.trim()}" (want 12 or 12-40, comma separated)`);
    const from = Number(m[1]);
    ranges.push([from, m[2] ? Number(m[2]) : from]);
  }
  return ranges;
}

function windowAround(source, comment, lines) {
  const all = source.split('\n');
  const from = Math.max(0, comment.line - 1 - lines);
  const to = Math.min(all.length, comment.endLine + lines);
  return all.slice(from, to).join('\n');
}

// -> { findings, scanned, asked, degraded }  — never throws; a dead model
// yields rule-only findings rather than nothing.
async function auditSource(source, filePath, opts = {}) {
  const minConfidence = opts.minConfidence ?? cfg.MIN_CONFIDENCE;
  const classify = opts.classify || cached(classifyComments, { enabled: opts.cache !== false });
  const deadline = opts.deadline ?? Date.now() + cfg.TOTAL_BUDGET_MS;

  const all = scanComments(source, filePath, { contextLines: cfg.CONTEXT_LINES });
  if (!all) return { findings: [], scanned: 0, asked: 0, degraded: false, unsupported: true };

  // Scoping to just-written lines is what makes the model worth asking -- see
  // CLAUDE.md "Precision is a base-rate problem, so scope the audit".
  const comments = opts.lines ? all.filter((c) => overlaps(c, opts.lines)) : all;

  const settled = new Map();
  const needModel = [];
  for (const c of comments) {
    const ruled = triage(c);
    if (ruled) settled.set(c.index, ruled);
    else needModel.push(c);
  }

  const wholeFile = source.length <= cfg.MAX_FILE_CHARS;
  const items = needModel.map((c) => ({
    index: c.index,
    text: c.text,
    trailing: c.trailing,
    code: wholeFile ? c.code : windowAround(source, c, cfg.CONTEXT_LINES),
  }));

  let answers = new Map();
  if (items.length > 0 && !opts.rulesOnly) {
    answers = (await classify(items, { deadline })) || new Map();
  }
  const degraded = items.length > 0 && !opts.rulesOnly && answers.size < items.length;

  const findings = [];
  for (const c of comments) {
    const verdictSource = settled.get(c.index) || answers.get(c.index);
    if (!verdictSource) continue;
    const { label, confidence, reason, by, rule } = verdictSource;
    const verdict = verdictFor(label, confidence, minConfidence, by);
    if (verdict === 'keep') continue;
    findings.push({
      index: c.index,
      line: c.line,
      endLine: c.endLine,
      lines: c.lineCount,
      style: c.style,
      trailing: c.trailing,
      label,
      verdict,
      confidence,
      by,
      rule: rule || null,
      reason: reason || '',
      advice: ADVICE[label] || '',
      text: c.text.trim(),
      cut: cutFor(source, c),
    });
  }

  return {
    findings,
    scanned: comments.length,
    inFile: all.length,
    asked: items.length,
    degraded,
    unsupported: false,
  };
}

// Applied back-to-front so earlier offsets stay valid.
function applyFindings(source, findings, { verdicts = ['remove'] } = {}) {
  const cuts = findings
    .filter((f) => verdicts.includes(f.verdict))
    .map((f) => f.cut)
    .sort((a, b) => b.start - a.start);
  let out = source;
  for (const cut of cuts) out = out.slice(0, cut.start) + out.slice(cut.end);
  return out;
}

module.exports = { auditSource, applyFindings, cutFor, parseRanges };
