#!/usr/bin/env node
'use strict';

// node extract.js --in <file.json>   -- see SKILL.md for scope, CLAUDE.md for the contract
//   { "text": "...", "field": "the invoice total", "instructions": "..." }

const { ensureRunning, chatJSON, truncate, readInputJSON, failAndExit } = require('./lib/local-client');

const MAX_TEXT_CHARS = 6000;
const NOT_FOUND = '(not found)';

const SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    value: { type: 'string' },
  },
  required: ['found', 'value'],
};

function systemPrompt(field, instructions) {
  const extra = instructions ? ` Extra guidance: ${instructions}` : '';
  return (
    `You extract exactly one specific value from a block of text: ${field}. ` +
    `Report only what is explicitly present in the text -- never guess, infer beyond what is stated, or invent a plausible-looking ` +
    `value. If the text does not contain this value, set "found" to false and "value" to an empty string. If it does, set "found" ` +
    `to true and "value" to the value itself, copied as it appears (no surrounding commentary, no restating the field name).${extra}`
  );
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be a JSON object');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('"text" must be a non-empty string');
  if (typeof input.field !== 'string' || !input.field.trim()) throw new Error('"field" must be a non-empty string describing what to extract');
  if (input.instructions != null && typeof input.instructions !== 'string') throw new Error('"instructions" must be a string if given');
  return { text: input.text, field: input.field, instructions: input.instructions || null };
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
    failAndExit(`local model unavailable (${err.message}) -- do this extraction yourself`);
    return;
  }

  const userContent = truncate(parsed.text, MAX_TEXT_CHARS);
  const result = await chatJSON(systemPrompt(parsed.field, parsed.instructions), userContent, SCHEMA, 'extract_value', { maxTokens: 200 });
  if (!result || typeof result.found !== 'boolean' || typeof result.value !== 'string') {
    failAndExit('model gave no usable response -- do this extraction yourself');
    return;
  }

  console.log(result.found && result.value.trim() ? result.value.trim() : NOT_FOUND);
}

main();
