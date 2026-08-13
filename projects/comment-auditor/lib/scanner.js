'use strict';

// A regex over `//` deletes the tail of any string containing one -- see
// CLAUDE.md "The scanner is a state machine, not a regex".

const path = require('path');

const C_LIKE = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.go', '.rs',
  '.swift', '.kt', '.kts', '.scala', '.php', '.dart', '.zig',
]);
const LUA = new Set(['.lua']);
const HASH = new Set([
  '.py', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.psd1',
  '.rb', '.pl', '.yml', '.yaml', '.toml', '.tf', '.nix',
]);

// JS is the only c-like dialect here with regex literals; treating `/` as
// division everywhere else costs nothing and cannot swallow a comment.
const REGEX_LITERAL = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

function dialectFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (C_LIKE.has(ext)) return { family: 'c-like', regexLiterals: REGEX_LITERAL.has(ext) };
  if (LUA.has(ext)) return { family: 'lua', regexLiterals: false };
  if (HASH.has(ext)) return { family: 'hash', regexLiterals: false, powershell: ext.startsWith('.ps') };
  return null;
}

// A `/` starts a regex literal only where a value cannot already have ended.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function regexCanFollow(prevToken) {
  if (!prevToken) return true;
  if (/[A-Za-z_$]/.test(prevToken[0])) return REGEX_PRECEDING_KEYWORDS.has(prevToken);
  return !/[)\]}]/.test(prevToken) && !/[0-9]/.test(prevToken);
}

function lineOf(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function buildLineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function scanCLike(source, dialect, emit) {
  let i = 0;
  let prevToken = '';
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      emit('line', start, i, source.slice(start + 2, i));
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      const bodyEnd = Math.min(i, n);
      i = Math.min(i + 2, n);
      emit('block', start, i, source.slice(start + 2, bodyEnd));
      prevToken = '';
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(source, i, c);
      prevToken = 'x';
      continue;
    }
    if (c === '`') {
      i = skipTemplate(source, i, dialect, emit);
      prevToken = 'x';
      continue;
    }
    if (c === '/' && dialect.regexLiterals && regexCanFollow(prevToken)) {
      const after = skipRegex(source, i);
      if (after !== -1) {
        i = after;
        prevToken = 'x';
        continue;
      }
    }
    if (!/\s/.test(c)) prevToken = /[A-Za-z_$0-9]/.test(c) ? readWord(source, i) : c;
    i += 1;
  }
}

function readWord(source, i) {
  if (!/[A-Za-z_$]/.test(source[i])) return source[i];
  let j = i;
  while (j > 0 && /[A-Za-z_$0-9]/.test(source[j - 1])) j -= 1;
  let k = i;
  while (k < source.length && /[A-Za-z_$0-9]/.test(source[k])) k += 1;
  return source.slice(j, k);
}

function skipQuoted(source, i, quote) {
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === quote) return j + 1;
    if (source[j] === '\n' && quote !== '`') return j;
    j += 1;
  }
  return source.length;
}

// Comments are live inside `${...}`, so the interpolation is scanned, not skipped.
function skipTemplate(source, i, dialect, emit) {
  let j = i + 1;
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === '`') return j + 1;
    if (source[j] === '$' && source[j + 1] === '{') {
      const end = matchBrace(source, j + 1);
      scanCLike(source.slice(j + 2, end), dialect, (kind, s, e, text) => emit(kind, s + j + 2, e + j + 2, text));
      j = end + 1;
      continue;
    }
    j += 1;
  }
  return source.length;
}

function matchBrace(source, openIndex) {
  let depth = 0;
  let j = openIndex;
  while (j < source.length) {
    const c = source[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(source, j, c);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
    j += 1;
  }
  return source.length;
}

// -1 when this `/` was division after all, so the caller can fall through.
function skipRegex(source, i) {
  let j = i + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      while (j < source.length && /[a-z]/.test(source[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

function scanLua(source, emit) {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '-' && source[i + 1] === '-') {
      const start = i;
      const long = matchLuaLongBracket(source, i + 2);
      if (long) {
        emit('block', start, long.end, source.slice(long.bodyStart, long.bodyEnd));
        i = long.end;
        continue;
      }
      while (i < n && source[i] !== '\n') i += 1;
      emit('line', start, i, source.slice(start + 2, i));
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(source, i, c);
      continue;
    }
    if (c === '[') {
      const long = matchLuaLongBracket(source, i);
      if (long) {
        i = long.end;
        continue;
      }
    }
    i += 1;
  }
}

function matchLuaLongBracket(source, i) {
  if (source[i] !== '[') return null;
  let level = 0;
  let j = i + 1;
  while (source[j] === '=') {
    level += 1;
    j += 1;
  }
  if (source[j] !== '[') return null;
  const bodyStart = j + 1;
  const close = `]${'='.repeat(level)}]`;
  const end = source.indexOf(close, bodyStart);
  if (end === -1) return { bodyStart, bodyEnd: source.length, end: source.length };
  return { bodyStart, bodyEnd: end, end: end + close.length };
}

function scanHash(source, dialect, emit) {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '<' && source[i + 1] === '#' && dialect.powershell) {
      const start = i;
      const end = source.indexOf('#>', i + 2);
      const stop = end === -1 ? n : end + 2;
      emit('block', start, stop, source.slice(start + 2, end === -1 ? n : end));
      i = stop;
      continue;
    }
    if (c === '#') {
      const start = i;
      while (i < n && source[i] !== '\n') i += 1;
      emit('line', start, i, source.slice(start + 1, i));
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = source.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const end = source.indexOf(triple, i + 3);
        i = end === -1 ? n : end + 3;
        continue;
      }
      i = skipQuoted(source, i, c);
      continue;
    }
    i += 1;
  }
}

// Consecutive line comments broken only by whitespace are one unit: the model
// judges an argument, and deleting half of one leaves nonsense behind.
function groupRuns(raw, source, lineStarts) {
  const groups = [];
  for (const c of raw) {
    const prev = groups[groups.length - 1];
    const mergeable =
      prev &&
      prev.style === 'line' &&
      c.style === 'line' &&
      c.line === prev.endLine + 1 &&
      onlyWhitespaceBefore(source, c.start, lineStarts[c.line - 1]) &&
      onlyWhitespaceBefore(source, prev.start, lineStarts[prev.line - 1]);
    if (mergeable) {
      prev.end = c.end;
      prev.endLine = c.endLine;
      prev.text = `${prev.text}\n${c.text.trim()}`;
      prev.lineCount += 1;
    } else {
      groups.push(c);
    }
  }
  return groups;
}

function onlyWhitespaceBefore(source, offset, lineStart) {
  return /^[ \t]*$/.test(source.slice(lineStart, offset));
}

// Trailing comments annotate the line they sit on; leading ones annotate what
// follows. The distinction decides which code the model is shown.
function attachCode(group, source, lineStarts, contextLines) {
  const lineStart = lineStarts[group.line - 1];
  const before = source.slice(lineStart, group.start);
  group.trailing = !/^[ \t]*$/.test(before);
  group.indent = group.trailing ? '' : before;

  if (group.trailing) {
    group.code = source.slice(lineStart, group.start).trimEnd();
    return;
  }
  const out = [];
  for (let ln = group.endLine + 1; ln <= lineStarts.length && out.length < contextLines; ln += 1) {
    const s = lineStarts[ln - 1];
    const e = ln < lineStarts.length ? lineStarts[ln] - 1 : source.length;
    const text = source.slice(s, e);
    if (!text.trim() && out.length === 0) continue;
    out.push(text);
  }
  group.code = out.join('\n').trimEnd();
}

function scanComments(source, filePath, { contextLines = 6 } = {}) {
  const dialect = dialectFor(filePath);
  if (!dialect) return null;

  const lineStarts = buildLineStarts(source);
  const raw = [];
  const emit = (style, start, end, text) => {
    raw.push({
      style,
      start,
      end,
      text,
      line: lineOf(lineStarts, start),
      endLine: lineOf(lineStarts, Math.max(start, end - 1)),
      lineCount: 1,
    });
  };

  if (dialect.family === 'c-like') scanCLike(source, dialect, emit);
  else if (dialect.family === 'lua') scanLua(source, emit);
  else scanHash(source, dialect, emit);

  raw.sort((a, b) => a.start - b.start);
  const groups = groupRuns(raw, source, lineStarts);
  for (const g of groups) attachCode(g, source, lineStarts, contextLines);
  return groups.map((g, index) => ({ index, ...g }));
}

module.exports = { scanComments, dialectFor };
