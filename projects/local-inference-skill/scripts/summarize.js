#!/usr/bin/env node
'use strict';

// summarize.js -- a short, plain-text summary of a block of text. Not for
// anything where nuance, correctness, or completeness matters; see SKILL.md.
//
// Input: one JSON object, via `--in <file.json>` (preferred) or on stdin:
//   { "text": "...", "max_words": 40 }   // max_words optional, default 40
//
// Output: the summary, plain text, no markdown, no preamble.
//
// Exit 1 means delegation failed (bad input, server unavailable, unusable
// response) -- write the summary yourself rather than retrying.

const { ensureRunning, chatText, truncate, readInputJSON, failAndExit } = require('./lib/local-client');

const MAX_TEXT_CHARS = 6000;
const DEFAULT_MAX_WORDS = 40;

function systemPrompt(maxWords) {
  return (
    `Summarize the given text in plain prose, at most ${maxWords} words. No markdown, no bullet points, no preamble ` +
    `like "This text is about" -- reply with only the summary itself, as one or two sentences.`
  );
}

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('input must be a JSON object');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('"text" must be a non-empty string');
  let maxWords = DEFAULT_MAX_WORDS;
  if (input.max_words != null) {
    maxWords = Number(input.max_words);
    if (!Number.isFinite(maxWords) || maxWords < 5 || maxWords > 200) throw new Error('"max_words" must be a number between 5 and 200');
  }
  return { text: input.text, maxWords };
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
    failAndExit(`local model unavailable (${err.message}) -- write this summary yourself`);
    return;
  }

  const userContent = truncate(parsed.text, MAX_TEXT_CHARS);
  // Generous headroom for the model's own wordiness.
  const maxTokens = Math.min(400, Math.ceil(parsed.maxWords * 2.2));
  const summary = await chatText(systemPrompt(parsed.maxWords), userContent, { maxTokens, temperature: 0.3 });
  if (!summary) {
    failAndExit('model gave no usable response -- write this summary yourself');
    return;
  }

  console.log(summary);
}

main();
