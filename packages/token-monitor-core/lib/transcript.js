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
  return 'tool_calls'; // tool_use and anything else unrecognized
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

// One JSONL line == one content block, but every block belonging to the same
// API turn repeats that turn's full `usage` — so usage must be counted once
// per message.id, while content blocks accumulate across lines that share it.
//
// Proration weight: inter-block wall-clock deltas, not character length.
// Claude Code's default `display: "omitted"` leaves thinking blocks' text
// empty, so a char-length weight always assigns thinking a 0 share even when
// real thinking tokens were spent. Each block's JSONL line is timestamped as
// it streams in, so the gap since the previous block (or turn start) is a
// working proxy for how many tokens that block cost, and it degrades to
// roughly the same signal as length for text/tool_use blocks anyway.
// Text sent to the semantic classifier for a block worth judging — only
// thinking and tool_use carry a quality/purpose signal worth a model's
// attention (see token-classifier-demo/PLAN.md §1); writing blocks are
// already the answer the user sees, so they're left out of `turns` entirely.
function classifiableText(block) {
  if (block.type === 'thinking') return block.thinking || '';
  if (block.type === 'tool_use') return `${block.name || ''}(${JSON.stringify(block.input || {})})`;
  return null;
}

function finalizeTurn(turn, totals, turns) {
  const u = turn.usage;
  if (!u) return;
  const cacheCreation = u.cache_creation || {};
  const priced = costForTurn({
    model: turn.model,
    // `usage.speed` is 'standard' | 'fast'. Fast mode is the same model at
    // premium pricing, so dropping it under-reports a /fast session by half.
    speed: u.speed,
    // Dated rates (e.g. Sonnet 5's introductory pricing) are resolved against
    // the turn's own timestamp, so re-parsing an old transcript bills it at
    // the rate that was actually in force when it ran.
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
  // Two distinct ways a number here can be wrong, tracked separately so the
  // reason survives to whoever reads status.json:
  //   unpriced_output_tokens -- model id matched nothing in the table, so this
  //     turn contributed $0. A new model ships and the bar quietly stops
  //     counting it; this is the only signal that happened.
  //   fast_unpriced_output_tokens -- fast mode, on a model with no published
  //     premium rate. Billed at standard, so the number is a floor, not a lie.
  if (!priced.priced) totals.unpriced_output_tokens += u.output_tokens || 0;
  if (priced.fastUnpriced) totals.fast_unpriced_output_tokens += u.output_tokens || 0;

  const outputTokens = u.output_tokens || 0;
  if (outputTokens === 0 || turn.blocks.length === 0) return;

  let weights = timeDeltaWeights(turn);
  if (!weights) weights = turn.blocks.map((b) => charLength(b.block));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    totals.writing += outputTokens; // fallback: nothing to prorate against
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

// Not everything Claude Code logs as `type: "user"` is something the human
// typed. Background-task completions, interrupt markers, skill preambles and
// injected reminders all arrive as user turns, and they are frequently far
// LONGER than real messages -- one observed `<task-notification>` ran 5111
// chars against a 184-char actual message. Naming reads userTexts as "what
// the user is talking about," so letting these through both drowns out real
// messages and lets a background agent's report rename the session.
const NON_USER_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '[Request interrupted',
  'Base directory for this skill:',
  'Caveat: The messages below were generated',
  '<command-name>',
  '<local-command-stdout>',
];

// Injected blocks can also be appended to otherwise-real messages, so strip
// them before deciding whether what's left is genuine user text.
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

// Parses a Claude Code session transcript JSONL file into classified token
// totals. Re-parses the whole file each call — session transcripts are small
// enough (single-digit MB) that this is simpler and safer than incremental
// byte-offset tailing across turn boundaries that span multiple lines.
function classifySession(transcriptPath) {
  const totals = emptyTotals();
  const turns = []; // per-turn thinking/tool_use blocks, for the semantic classifier
  const userTexts = []; // every user turn's text, in order -- naming uses this to react to topic drift, not just the opening message
  const agentUses = []; // Agent (Task) spawns in UI order
  let lastTimestamp = null;
  const modelsSeen = new Set();

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let openTurn = null; // { id, model, usage, startTs, blocks: [{block, ts}] }
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
        // Agent (Task) spawns, captured in the order they appear -- which is
        // the order the UI shows them in. Running-vs-finished is decided by
        // the watcher from subagent transcript mtime, NOT from whether the
        // tool_use has a tool_result: a background agent's Task call resolves
        // immediately at launch, so resolution marks every background agent
        // finished the instant it starts. See buildAgentList in watcher.js.
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
