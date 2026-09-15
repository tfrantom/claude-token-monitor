'use strict';

const fs = require('fs');
const { costForTurn } = require('./pricing');

function charLength(block) {
  switch (block.type) {
    case 'thinking':
      return (block.thinking || '').length;
    case 'text':
      return (block.text || '').length;
    case 'tool_use':
      return (block.name || '').length + JSON.stringify(block.input || {}).length;
    default:
      return JSON.stringify(block).length;
  }
}

function bucketFor(blockType) {
  if (blockType === 'thinking') return 'thinking';
  if (blockType === 'text') return 'writing';
  return 'tool_calls';
}

/**
 * Token totals for a session. The four token fields are exact API figures; the
 * three output buckets are a **prorated estimate** of one combined
 * `output_tokens`, which the API never splits per block.
 *
 * @typedef {object} Totals
 * @property {number} context Uncached `input_tokens`. Near zero on a caching
 *   session — throughput, not context occupancy.
 * @property {number} cache_write
 * @property {number} cache_read
 * @property {number} thinking Estimated.
 * @property {number} writing Estimated.
 * @property {number} tool_calls Estimated.
 * @property {number} cost_usd
 * @property {number} unpriced_output_tokens Output on turns whose model matched
 *   no rate: unknown cost, not zero cost.
 * @property {number} fast_unpriced_output_tokens Fast-mode output on a model
 *   with no published premium — priced at standard, so an under-report.
 */

/** @returns {Totals} */
function emptyTotals() {
  return {
    context: 0,
    cache_write: 0,
    cache_read: 0,
    thinking: 0,
    writing: 0,
    tool_calls: 0,
    cost_usd: 0,
    unpriced_output_tokens: 0,
    fast_unpriced_output_tokens: 0,
  };
}

function classifiableText(block) {
  if (block.type === 'thinking') return block.thinking || '';
  if (block.type === 'tool_use') return `${block.name || ''}(${JSON.stringify(block.input || {})})`;
  return null;
}

/**
 * One API turn, accumulated across every JSONL line that shares its
 * `message.id`.
 *
 * @typedef {object} Turn
 * @property {string} id `message.id`, or a synthesised `anon-N` for an entry
 *   that carries none — those must not merge into one turn.
 * @property {string} [model]
 * @property {object} [usage] The turn's whole usage object, repeated on every
 *   one of its lines; recorded once.
 * @property {string|null} startTs Timestamp of the entry *before* the turn
 *   opened, which is what makes the first block's time delta measurable.
 * @property {Array<{block: object, ts: string}>} blocks
 */

/**
 * Adds one turn to the running totals, and records its classifiable blocks.
 *
 * Usage is per `message.id`, never per JSONL line, and `speed`/`at_ms` are
 * load-bearing -- see CLAUDE.md "Transcript parsing" and "Pricing".
 *
 * @param {Turn} turn
 * @param {Totals} totals Mutated in place.
 * @param {Array<{id: string, model: string|undefined, blocks: Array<{index: number, type: string, text: string, tokens: number}>}>} turns
 *   Appended to, for the semantic classifier. Only turns with classifiable
 *   text are added, so this is shorter than the turn count.
 */
function finalizeTurn(turn, totals, turns) {
  const u = turn.usage;
  if (!u) return;
  const cacheCreation = u.cache_creation || {};
  const priced = costForTurn({
    model: turn.model,
    speed: u.speed,
    at_ms: turn.startTs ? Date.parse(turn.startTs) : Date.now(),
    input_tokens: u.input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_5m: cacheCreation.ephemeral_5m_input_tokens || 0,
    cache_creation_1h: cacheCreation.ephemeral_1h_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
  });

  totals.context += u.input_tokens || 0;
  totals.cache_write += (cacheCreation.ephemeral_5m_input_tokens || 0) + (cacheCreation.ephemeral_1h_input_tokens || 0);
  totals.cache_read += u.cache_read_input_tokens || 0;
  totals.cost_usd += priced.cost;
  if (!priced.priced) totals.unpriced_output_tokens += u.output_tokens || 0;
  if (priced.fastUnpriced) totals.fast_unpriced_output_tokens += u.output_tokens || 0;

  const outputTokens = u.output_tokens || 0;
  if (outputTokens === 0 || turn.blocks.length === 0) return;

  let weights = timeDeltaWeights(turn);
  if (!weights) weights = turn.blocks.map((b) => charLength(b.block));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    totals.writing += outputTokens;
    return;
  }
  const classifiable = [];
  turn.blocks.forEach(({ block }, i) => {
    const share = (weights[i] / total) * outputTokens;
    totals[bucketFor(block.type)] += share;
    const text = classifiableText(block);
    if (text) classifiable.push({ index: i, type: block.type, text, tokens: share });
  });
  if (classifiable.length > 0) turns.push({ id: turn.id, model: turn.model, blocks: classifiable });
}

/**
 * Wall-clock deltas, never character length -- see CLAUDE.md "Transcript
 * parsing, and the two things that look like bugs".
 *
 * @param {Turn} turn
 * @returns {number[]|null} One weight per block, or null when any timestamp is
 *   missing — the caller then falls back to character length, which measures
 *   thinking blocks as zero because their text is not in the transcript.
 */
function timeDeltaWeights(turn) {
  const times = turn.blocks.map((b) => (b.ts ? Date.parse(b.ts) : NaN));
  if (times.some((t) => Number.isNaN(t))) return null;
  const start = turn.startTs ? Date.parse(turn.startTs) : NaN;
  const weights = times.map((t, i) => {
    const prev = i === 0 ? start : times[i - 1];
    if (Number.isNaN(prev)) return NaN;
    return Math.max(t - prev, 1);
  });
  if (weights.some((w) => Number.isNaN(w))) return null;
  return weights;
}

// Not everything Claude Code logs as `type: "user"` is the human -- see
// CLAUDE.md "Three traps that had to be fixed together".
const NON_USER_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '[Request interrupted',
  'Base directory for this skill:',
  'Caveat: The messages below were generated',
  '<command-name>',
  '<local-command-stdout>',
];

const INJECTED_BLOCK_TAGS = [
  'system-reminder',
  'task-notification',
  'local-command-caveat',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
];

const INJECTED_BLOCK_RE = new RegExp('<(' + INJECTED_BLOCK_TAGS.join('|') + ')>[\\s\\S]*?</\\1>', 'g');

/**
 * Injected blocks are also appended to otherwise-real messages, so this must
 * run before the prefix check. An unclosed or untagged variant matches nothing
 * here and is caught by NON_USER_PREFIXES instead.
 *
 * @param {string} text
 * @returns {string}
 */
function stripInjectedBlocks(text) {
  return text.replace(INJECTED_BLOCK_RE, '').trim();
}

function pushUserText(userTexts, raw) {
  const text = stripInjectedBlocks(raw);
  if (!text) return;
  if (NON_USER_PREFIXES.some((p) => text.startsWith(p))) return;
  userTexts.push(text);
}

// Consumed by projects/comment-auditor to tell whether a file is being edited
// right now; the path is whatever the tool was handed, resolved by the reader.
const FILE_MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Everything one transcript yields in a single pass.
 *
 * @typedef {object} ParsedSession
 * @property {Totals} totals
 * @property {Array<object>} turns Turns carrying classifiable blocks, for the
 *   semantic classifier.
 * @property {string[]} userTexts Real human messages only — hook payloads,
 *   system reminders and command output are filtered out.
 * @property {string|null} lastTimestamp Newest timestamp seen, of any entry.
 * @property {string[]} models Every model id seen in the file.
 * @property {Array<{toolUseId: string, description: string|null}>} agentUses
 *   Subagent spawns, matched later against the `subagents/` sidechain files.
 * @property {Array<{path: string, at: string|null}>} fileWrites Every write,
 *   unfiltered and unordered; callers narrow it themselves.
 */

/**
 * @param {string} transcriptPath
 * @returns {ParsedSession|null} null when the file cannot be read. An empty or
 *   all-unparseable file returns zeroed totals rather than null — "read it, it
 *   said nothing" is distinct from "could not read it".
 */
function classifySession(transcriptPath) {
  const totals = emptyTotals();
  const turns = [];
  const userTexts = [];
  const agentUses = [];
  const fileWrites = [];
  let lastTimestamp = null;
  const modelsSeen = new Set();

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const turnsById = new Map();
  const turnOrder = [];
  let anonymousTurns = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const prevTimestamp = lastTimestamp;
    if (entry.timestamp) lastTimestamp = entry.timestamp;

    if (entry.type === 'assistant' && entry.message) {
      // Accumulated by message.id, never by adjacency: on parallel tool calls
      // the first tool_result is written BETWEEN two tool_use lines sharing one
      // id, and closing the turn there counts `usage` twice.
      const msgId = entry.message.id || `anon-${anonymousTurns++}`;
      let turn = turnsById.get(msgId);
      if (!turn) {
        turn = { id: msgId, model: entry.message.model, usage: entry.message.usage, startTs: prevTimestamp, blocks: [] };
        turnsById.set(msgId, turn);
        turnOrder.push(turn);
        if (entry.message.model) modelsSeen.add(entry.message.model);
      } else if (entry.message.usage) {
        turn.usage = entry.message.usage;
      }
      for (const block of entry.message.content || []) {
        turn.blocks.push({ block, ts: entry.timestamp });
        if (block.type === 'tool_use' && block.name === 'Agent') {
          agentUses.push({ toolUseId: block.id, description: block.input?.description || null });
        }
        if (block.type === 'tool_use' && FILE_MUTATING_TOOLS.has(block.name) && block.input?.file_path) {
          fileWrites.push({ path: block.input.file_path, at: entry.timestamp || null });
        }
      }
      continue;
    }

    if (entry.type === 'user' && entry.message) {
      const content = entry.message.content;
      if (typeof content === 'string' && content.trim()) {
        pushUserText(userTexts, content);
      } else if (Array.isArray(content)) {
        const textBlock = content.find((b) => b.type === 'text' && b.text && b.text.trim());
        if (textBlock) pushUserText(userTexts, textBlock.text);
      }
    }
  }
  for (const turn of turnOrder) finalizeTurn(turn, totals, turns);

  return {
    totals,
    turns,
    userTexts,
    lastTimestamp,
    models: [...modelsSeen],
    agentUses,
    fileWrites,
  };
}

module.exports = { classifySession };
