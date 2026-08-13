'use strict';

const { BASE_URL } = require('../../llama-local-server/server');

// Closed label vocabulary per lesson-sessions/token-classifier-demo/PLAN.md
// §1: thinking blocks get a quality verdict + productive fraction; tool_use
// blocks get a purpose tag. Every block gets every field (with "na"/0 filler
// on the fields that don't apply to its type) so the response schema stays
// flat — a discriminated union is harder for grammar-constrained decoding to
// get right than one uniform object shape.
const SYSTEM_PROMPT = `You classify blocks from an AI coding assistant's turn. For each block, judge it against the kind it actually is — thinking or tool_use — and fill in every field of the response:

- thinking blocks: set "verdict" to one of productive (tight, on-task reasoning), restating (re-summarizing already-known context with no new reasoning), backtracking (reconsidering one earlier decision for a good reason), or looping (repeating the same unresolved point without making progress). Set "productive_fraction" to how much of the block (0 to 1) was productive reasoning vs. waste. Leave "purpose" as "na".
- tool_use blocks: set "purpose" to one of explore (read-only lookup, e.g. list/grep/read a file), mutate (writes, edits, or runs a change), verify (runs tests or checks), redundant (repeats an earlier call in this same turn with no new information), or other. Leave "verdict" as "na" and "productive_fraction" as 0.

Give a one-sentence "reason" for each block. Reply with only the JSON object, one entry per block index given.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['productive', 'restating', 'backtracking', 'looping', 'na'] },
          productive_fraction: { type: 'number' },
          purpose: { type: 'string', enum: ['explore', 'mutate', 'verify', 'redundant', 'other', 'na'] },
          reason: { type: 'string' },
        },
        required: ['index', 'verdict', 'productive_fraction', 'purpose', 'reason'],
      },
    },
  },
  required: ['blocks'],
};

const MAX_BLOCK_CHARS = 1500;
const MAX_BLOCKS_PER_REQUEST = 12;

function truncate(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n...[truncated]...\n${text.slice(-tail)}`;
}

function buildUserMessage(blocks) {
  return blocks.map((b) => `[${b.index}:${b.type}] ${truncate(b.text, MAX_BLOCK_CHARS)}`).join('\n\n');
}

// One batched round trip per turn — a turn's blocks share context (e.g. a
// third tool call is only visibly redundant next to the first one), and
// batching keeps wall-clock cost sane for multi-block turns. Returns a map
// keyed by block index, or null on any failure (caller just leaves those
// blocks unclassified and retries them next tick).
async function classifyTurn(turn) {
  const blocks = turn.blocks.slice(0, MAX_BLOCKS_PER_REQUEST);
  if (blocks.length === 0) return null;

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(blocks) },
        ],
        temperature: 0.1,
        max_tokens: Math.min(1024, 150 * blocks.length),
        response_format: { type: 'json_schema', json_schema: { name: 'block_verdicts', schema: RESPONSE_SCHEMA, strict: true } },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed.blocks)) return null;

    const byIndex = new Map();
    for (const b of parsed.blocks) {
      if (typeof b.index !== 'number') continue;
      const fraction = Math.max(0, Math.min(1, Number(b.productive_fraction) || 0));
      byIndex.set(b.index, {
        verdict: b.verdict || 'na',
        productive_fraction: fraction,
        purpose: b.purpose || 'na',
        reason: typeof b.reason === 'string' ? b.reason.slice(0, 300) : '',
      });
    }
    return byIndex.size > 0 ? byIndex : null;
  } catch {
    return null;
  }
}

module.exports = { classifyTurn };
