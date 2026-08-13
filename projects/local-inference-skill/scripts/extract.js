#!/usr/bin/env node
'use strict';

// extract.js -- pull one specific, literal value out of a block of text.
// Not a paraphrase or a judgment call -- the model is instructed to report
// only what's explicitly present, and say so plainly when it isn't. See
// SKILL.md for scope.
//
// Input: one JSON object, via `--in <file.json>` (preferred) or on stdin:
//   { "text": "...", "field": "the invoice total", "instructions": "..." }
// "field" (required) is a short description of what to pull out, e.g.
// "the customer's email address" or "the version number in the heading".
// "instructions" (optional) is extra guidance (format, units, etc).
//
// Output (stdout): the extracted value as plain text, or the literal
// "(not found)" if the field genuinely isn't present in the text -- both
// are legitimate results and exit 0. Only delegation failure exits 1.
//
// Exit codes: 0 = usable result on stdout (value, or "(not found)"). 1 =
// delegation failed entirely (bad input, server unavailable, unusable model
// response) -- message on stderr, do the extraction yourself instead of
// retrying this script.

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
