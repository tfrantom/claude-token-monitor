'use strict';

// $ per 1M tokens, first-party Anthropic API rates. Read CLAUDE.md "Pricing"
// before changing anything here.

const SONNET_5_INTRO_UNTIL = Date.parse('2026-09-01T00:00:00Z');

const MODELS = [
  {
    match: /sonnet-5/,
    name: 'Claude Sonnet 5',
    input: 3.0,
    output: 15.0,
    dated: [{ until: SONNET_5_INTRO_UNTIL, input: 2.0, output: 10.0 }],
  },
  {
    match: /opus-5/,
    name: 'Claude Opus 5',
    input: 5.0,
    output: 25.0,
    fast: { input: 10.0, output: 50.0 },
  },
  { match: /haiku-4-5/, name: 'Claude Haiku 4.5', input: 1.0, output: 5.0 },
  { match: /fable-5|mythos-5/, name: 'Claude Fable/Mythos 5', input: 10.0, output: 50.0 },
  {
    match: /opus-4-8/,
    name: 'Claude Opus 4.8',
    input: 5.0,
    output: 25.0,
    // Fast mode with no published premium rate: left unset on purpose, so
    // costForTurn flags it rather than guessing.
  },
  { match: /opus-4-7|opus-4-6|opus-4-5|opus-4-1|opus-4-0/, name: 'Claude Opus 4.x', input: 5.0, output: 25.0 },
  { match: /sonnet-4/, name: 'Claude Sonnet 4.x', input: 3.0, output: 15.0 },
];

// First match wins: MODELS must stay ordered most-specific first.
function priceFor(modelId) {
  if (!modelId) return null;
  return MODELS.find((m) => m.match.test(modelId)) || null;
}

// Keyed on the turn's timestamp, never wall clock.
function rateFor(model, { speed, atMs } = {}) {
  if (speed === 'fast' && model.fast) {
    return { input: model.fast.input, output: model.fast.output, fastUnpriced: false };
  }
  const fastUnpriced = speed === 'fast' && !model.fast;

  if (model.dated && Number.isFinite(atMs)) {
    for (const window of model.dated) {
      if (atMs < window.until) {
        return { input: window.input, output: window.output, fastUnpriced };
      }
    }
  }
  return { input: model.input, output: model.output, fastUnpriced };
}

function costForTurn(turn) {
  const model = priceFor(turn.model);
  if (!model) return { cost: 0, priced: false, fastUnpriced: false };

  const rate = rateFor(model, { speed: turn.speed, atMs: turn.at_ms });
  const perTok = rate.input / 1e6;
  const cost =
    turn.input_tokens * perTok +
    turn.cache_creation_5m * perTok * 1.25 +
    turn.cache_creation_1h * perTok * 2 +
    turn.cache_read_input_tokens * perTok * 0.1 +
    turn.output_tokens * (rate.output / 1e6);

  return { cost, priced: true, fastUnpriced: rate.fastUnpriced };
}

module.exports = { priceFor, costForTurn, rateFor, MODELS };
