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

// Usage is per message.id, never per JSONL line, and `speed`/`at_ms` are
// load-bearing -- see CLAUDE.md "Transcript parsing" and "Pricing".
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

// Wall-clock deltas, never character length -- see CLAUDE.md "Transcript
// parsing, and the two things that look like bugs".
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

// Injected blocks are also appended to otherwise-real messages, so this must
// run before the prefix check.
function stripInjectedBlocks(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim();
}

function pushUserText(userTexts, raw) {
  const text = stripInjectedBlocks(raw);
  if (!text) return;
  if (NON_USER_PREFIXES.some((p) => text.startsWith(p))) return;
  userTexts.push(text);
}

function classifySession(transcriptPath) {
  const totals = emptyTotals();
  const turns = [];
  const userTexts = [];
  const agentUses = [];
  let lastTimestamp = null;
  const modelsSeen = new Set();

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let openTurn = null;
  const closeOpenTurn = () => {
    if (openTurn) finalizeTurn(openTurn, totals, turns);
    openTurn = null;
  };

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
      const msgId = entry.message.id;
      if (!openTurn || openTurn.id !== msgId) {
        closeOpenTurn();
        openTurn = { id: msgId, model: entry.message.model, usage: entry.message.usage, startTs: prevTimestamp, blocks: [] };
        if (entry.message.model) modelsSeen.add(entry.message.model);
      }
      for (const block of entry.message.content || []) {
        openTurn.blocks.push({ block, ts: entry.timestamp });
        if (block.type === 'tool_use' && block.name === 'Agent') {
          agentUses.push({ toolUseId: block.id, description: block.input?.description || null });
        }
      }
      continue;
    }

    closeOpenTurn();

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
  closeOpenTurn();

  return {
    totals,
    turns,
    userTexts,
    lastTimestamp,
    models: [...modelsSeen],
    agentUses,
  };
}

module.exports = { classifySession };
