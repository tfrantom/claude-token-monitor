'use strict';

// The model classifies; this file decides -- see CLAUDE.md "The model never
// decides, and it never sees a protected comment".

const LABELS = [
  'restates-code',
  'history',
  'measured-finding',
  'trap',
  'pointer',
  'doc',
  'unclear',
];

// Deleting one of these breaks a build, a license, or an editor -- they are
// filtered out before the model is asked anything.
const PROTECTED = [
  [/^\s*(eslint|biome|oxlint)-(disable|enable|ignore)/i, 'linter-directive'],
  [/^\s*prettier-ignore\b/i, 'formatter-directive'],
  [/^\s*@ts-(ignore|expect-error|nocheck)\b/i, 'compiler-directive'],
  [/^\s*(istanbul|c8|v8)\s+ignore\b/i, 'coverage-directive'],
  [/^\s*(global|globals|jshint|jslint|exported)\s/i, 'linter-directive'],
  [/^\s*webpack[A-Z]\w*\s*:/, 'bundler-directive'],
  [/^\s*<reference\b/i, 'compiler-directive'],
  [/^\s*@(flow|jsx|jsxImportSource|license|preserve)\b/i, 'compiler-directive'],
  [/^\s*#(region|endregion)\b/i, 'editor-directive'],
  [/^\s*(SPDX-License-Identifier|Copyright\b|\(c\)\s*\d{4})/i, 'license'],
  [/^\s*(TODO|FIXME|XXX|HACK|NOTE|WARNING|BUG|DEPRECATED)\b[:( ]/i, 'author-marker'],
  [/^\s*(type|param|returns|throws|template|typedef|property|see|example)\b/i, 'jsdoc-tag'],
  [/^!/, 'preserved-block'],
  [/\bnoqa\b|\btype:\s*ignore\b|\brubocop:(disable|enable|todo)\b/i, 'linter-directive'],
];

// The keep side, and it must be as deterministic as the remove side -- see
// CLAUDE.md "Measured: the model cannot recognise a pointer or a trap".
const KEEP_RULES = [
  [
    'pointer',
    /\bsee\s+(?:the\s+)?[\w./\\-]*(?:CLAUDE\.md|README|\.(?:md|js|jsx|ts|tsx|lua|ps1|py|go|rs|java|rb|sh))|https?:\/\/|\b(?:RFC|issue|ticket|PR)\s*#?\d+/i,
  ],
  [
    'trap',
    /\b(?:must\s+(?:match|stay|be|not|already|survive|run|come)|load-bearing|order matters|is\s+required,\s+not|deliberate|on purpose|do not (?:"?fix"?|remove|change|optimi[sz]e|simplify|reorder)|don't (?:remove|change|reorder)|never\s+(?:by|the|a|an)\b|keep (?:this|that|it)\b|otherwise\b[^.]*\bbreak|breaks?\s+(?:the|if)\b|silently)/i,
  ],
  ['doc', /^\s*(?:->|=>|→)\s/m],
];

// Cheap, certain, and zero model calls. Anything these decide is never sent.
// Order matters: a comment that is both a measurement and a history note keeps
// the measurement.
const RULES = [
  [
    'measured-finding',
    /\b\d+(?:[.,]\d+)?\s*(?:ms|µs|us|ns|sec|secs|seconds?|mins?|minutes?|hours?|%|x|×|[KMGT]B|bytes?|tokens?|fps|Hz|k\b|MTok)\b/i,
  ],
  ['measured-finding', /\bmeasured\b|\bbenchmark(?:ed)?\b|\bprofiled\b|\btimed at\b|\bobserved\b|\bre-?derive\b/i],
  ['measured-finding', /\b\d+\s*(?:of|\/)\s*\d+\b/],
  [
    'history',
    /\b(used to be|used to|previously|originally|formerly|we tried|it turned out|in the past|before this|no longer|renamed from|changed from|this was once|kept for backwards|legacy from)\b/i,
  ],
  ['commented-out-code', null],
  ['banner', /^[\s\-=*_~#+.]{6,}$/],
  ['banner', /^[\s\-=*_~#+]{2,}\s*[\w\s]{1,30}\s*[\-=*_~#+]{2,}$/],
];

const CODE_SHAPES = [
  /^\s*(const|let|var|function|class|import|export|return|if|for|while|switch|try|catch|await|async|def|elif|end|local)\b.*[;:{)\]]\s*$/,
  /^\s*[\w.$[\]'"]+\s*(=|\+=|-=|\|\|=|\?\?=)\s*.+;?\s*$/,
  /^\s*[\w$]+\([^)]*\)\s*[;{]?\s*$/,
  /^\s*[}\])];?\s*$/,
  /^\s*['"`\w$]+\s*:\s*.+,\s*$/,
];

function looksLikeCode(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const hits = lines.filter((l) => CODE_SHAPES.some((re) => re.test(l))).length;
  return hits / lines.length >= 0.6;
}

function isProtected(text) {
  const body = text.replace(/^[\s*/]+/gm, '').trim();
  for (const [re, reason] of PROTECTED) {
    if (re.test(body)) return reason;
  }
  return null;
}

/**
 * @typedef {'restates-code'|'history'|'commented-out-code'|'banner'|'measured-finding'|'trap'|'pointer'|'doc'|'unclear'|'protected'} CommentLabel
 */

/**
 * @typedef {object} Finding
 * @property {CommentLabel} label
 * @property {number} confidence 0..1; a rule is always 1.
 * @property {'rule'|'model'} by Only `rule` can ever reach a deletion.
 * @property {string} [rule] Which rule matched, for the report.
 */

/**
 * @param {{text: string}} comment
 * @returns {Finding|null} null when only the model can tell — the caller then
 *   asks it. Keep rules are checked before removal rules, because a pointer
 *   that also describes the code is still a pointer and wrongly keeping a
 *   comment is the cheap mistake.
 */
function triage(comment) {
  const body = comment.text.replace(/^[\s*]+/gm, '').trim();

  const guard = isProtected(comment.text);
  if (guard) return { label: 'protected', confidence: 1, by: 'rule', rule: guard };

  if (!body) return { label: 'protected', confidence: 1, by: 'rule', rule: 'empty' };

  // Before RULES: a pointer that also mentions what the code does is still a
  // pointer, and a wrongly-kept comment is the cheap mistake.
  for (const [label, re] of KEEP_RULES) {
    if (re.test(body)) return { label, confidence: 1, by: 'rule', rule: re.source.slice(0, 40) };
  }

  for (const [label, re] of RULES) {
    if (label === 'commented-out-code') {
      if (looksLikeCode(body)) return { label, confidence: 1, by: 'rule', rule: 'code-shaped' };
      continue;
    }
    if (re.test(body)) return { label, confidence: 1, by: 'rule', rule: re.source.slice(0, 40) };
  }
  return null;
}

const VERDICTS = {
  'restates-code': 'remove',
  history: 'remove',
  'commented-out-code': 'remove',
  banner: 'remove',
  'measured-finding': 'relocate',
  trap: 'keep',
  pointer: 'keep',
  doc: 'keep',
  unclear: 'keep',
  protected: 'keep',
};

const ADVICE = {
  'restates-code': 'Restates the code. Delete it, or fix the name it is compensating for.',
  history: 'Records history. Delete it; git has this.',
  'commented-out-code': 'Commented-out code. Delete it.',
  banner: 'Section-divider banner. Delete it.',
  'measured-finding': 'Holds a measured finding — do not delete. Move it to CLAUDE.md and leave a pointer.',
  trap: 'Stops someone breaking this. Keep.',
  pointer: 'Points at where the why lives. Keep.',
  doc: 'API documentation. Keep.',
  unclear: 'Not classifiable locally. Left alone.',
  protected: 'Load-bearing to a tool, a license, or its author. Never touched.',
};

/**
 * A model label can never become a deletion -- see CLAUDE.md "Measured: the
 * model cannot recognise a pointer or a trap". It surfaces candidates; only a
 * rule removes anything.
 *
 * @param {CommentLabel} label
 * @param {number} confidence
 * @param {number} minConfidence
 * @param {'rule'|'model'} [by]
 * @returns {'remove'|'relocate'|'keep'|'review'} `review` is where anything
 *   uncertain lands, and where every model-sourced removal candidate lands
 *   regardless of confidence.
 */
function verdictFor(label, confidence, minConfidence, by = 'rule') {
  const base = VERDICTS[label] || 'keep';
  if (base !== 'remove') return base;
  if (by !== 'rule') return 'review';
  return confidence < minConfidence ? 'review' : 'remove';
}

module.exports = { LABELS, triage, verdictFor, isProtected, looksLikeCode, ADVICE, VERDICTS, KEEP_RULES };
