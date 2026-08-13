#!/usr/bin/env node
'use strict';

// classify.js -- pick one label from a fixed, closed list, for one text or
// for each of several short items in one batched request. See SKILL.md for
// when this is an appropriate thing to delegate.
//
// Input: one JSON object, via `--in <file.json>` (preferred) or on stdin:
//   { "text": "...", "labels": ["a", "b", "c"] }
//   { "items": ["...", "..."], "labels": ["a", "b", "c"] }
// Optional "context": one line on what the labels mean.
//
// Output: the chosen label, or one label per line in input order. "unclear"
// is always a valid choice even when not in the caller's list, and is a
// legitimate exit-0 result.
//
// Exit 1 means delegation failed (bad input, server unavailable, unusable
// response) -- do the classification yourself rather than retrying.

const { ensureRunning, chatJSON, truncate, readInputJSON, failAndExit } = require('./lib/local-client');

const MAX_TEXT_CHARS = 4000;
const MAX_ITEM_CHARS = 500;
const MAX_ITEMS = 20;
const UNCLEAR = 'unclear';

function buildSchema(labels, batch) {
  const enumValues = [...labels, UNCLEAR];
  if (!batch) {
    return { type: 'object', properties: { label: { type: 'string', enum: enumValues } }, required: ['label'] };
  }
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, label: { type: 'string', enum: enumValues } },
          required: ['index', 'label'],
        },
      },
    },
    required: ['results'],
  };
}

function systemPrompt(labels, context, batch) {
  const labelList = labels.map((l) => `"${l}"`).join(', ');
  const contextLine = context ? ` Context: ${context}` : '';
  const scope = batch
    ? 'You will be given several numbered items. Classify each one independently.'
    : 'You will be given one piece of text to classify.';
  return (
    `You are a strict text classifier. ${scope} Choose exactly one label from this fixed list for ` +
    `each item: ${labelList}. Reply with the label exactly as given, no punctuation, no explanation. ` +
    `If none of the given labels genuinely fit an item, reply "${UNCLEAR}" for that item instead of guessing.` +
    contextLine
  );
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be a JSON object');
  if (!Array.isArray(input.labels) || input.labels.length === 0 || !input.labels.every((l) => typeof l === 'string' && l.trim())) {
    throw new Error('"labels" must be a non-empty array of non-empty strings');
  }
  const hasText = typeof input.text === 'string' && input.text.trim();
  const hasItems = Array.isArray(input.items) && input.items.length > 0;
  if (!hasText && !hasItems) throw new Error('provide either "text" (string) or "items" (non-empty array of strings)');
  if (hasText && hasItems) throw new Error('provide only one of "text" or "items", not both');
  if (hasItems && !input.items.every((i) => typeof i === 'string')) throw new Error('"items" must all be strings');
  return { labels: input.labels, text: hasText ? input.text : null, items: hasItems ? input.items : null, context: typeof input.context === 'string' ? input.context : null };
}

async function main() {
  let parsed;
  try {
    parsed = validateInput(readInputJSON(process.argv.slice(2)));
  } catch (err) {
    failAndExit(err.message);
    return;
  }

  try {
    await ensureRunning();
  } catch (err) {
    failAndExit(`local model unavailable (${err.message}) -- do this classification yourself`);
    return;
  }

  if (parsed.text) {
    const userContent = truncate(parsed.text, MAX_TEXT_CHARS);
    const result = await chatJSON(systemPrompt(parsed.labels, parsed.context, false), userContent, buildSchema(parsed.labels, false), 'classify_single');
    if (!result || typeof result.label !== 'string') {
      failAndExit('model gave no usable response -- do this classification yourself');
      return;
    }
    console.log(result.label);
    return;
  }

  const items = parsed.items.slice(0, MAX_ITEMS);
  const userContent = items.map((it, i) => `[${i}] ${truncate(it, MAX_ITEM_CHARS)}`).join('\n');
  const result = await chatJSON(systemPrompt(parsed.labels, parsed.context, true), userContent, buildSchema(parsed.labels, true), 'classify_batch');
  if (!result || !Array.isArray(result.results) || result.results.length === 0) {
    failAndExit('model gave no usable response -- do this classification yourself');
    return;
  }

  const byIndex = new Map();
  for (const r of result.results) {
    if (typeof r.index === 'number' && typeof r.label === 'string') byIndex.set(r.index, r.label);
  }
  for (let i = 0; i < items.length; i++) {
    console.log(byIndex.has(i) ? byIndex.get(i) : UNCLEAR);
  }
}

main();
