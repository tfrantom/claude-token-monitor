'use strict';

// $ per 1M tokens, first-party Anthropic API rates.
//
// Cache write/read are multipliers on the INPUT rate, not separate sticker
// prices: 1.25x (5m TTL) / 2x (1h TTL) write, 0.1x read. Verified against the
// current rate card; these have not changed.
//
// Two things this table deliberately does NOT do, both of which look like
// omissions and are not:
//
//   * No long-context premium. Opus/Sonnet 5 ship a 1M context window at
//     standard pricing -- there is no >200k tier. A model id like
//     `claude-opus-5[1m]` is priced exactly as `claude-opus-5`, which the
//     bare /opus-5/ match already handles. Do not add a multiplier here.
//   * No batch discount. The Batch API is 50% off, but Claude Code never
//     uses it, so every turn in a transcript is interactive.

// Dated rate changes. `until` is inclusive of the whole day in UTC; a turn
// timestamped after it prices at the standard rate automatically, so this
// needs no edit when the window closes.
const SONNET_5_INTRO_UNTIL = Date.parse('2026-09-01T00:00:00Z');

const MODELS = [
  {
    match: /sonnet-5/,
    name: 'Claude Sonnet 5',
    input: 3.0,
    output: 15.0,
    // Introductory pricing, in effect through 2026-08-31. Applied per-turn by
    // the turn's own timestamp, not by wall-clock now: re-pricing an August
    // transcript in September must still bill it at the August rate.
    dated: [{ until: SONNET_5_INTRO_UNTIL, input: 2.0, output: 10.0 }],
  },
  {
    match: /opus-5/,
    name: 'Claude Opus 5',
    input: 5.0,
    output: 25.0,
    // Fast mode is the same model at higher throughput and premium pricing,
    // reported by the API as usage.speed === 'fast'. Without this a session
    // run with /fast on is under-reported by exactly half.
    fast: { input: 10.0, output: 50.0 },
  },
  { match: /haiku-4-5/, name: 'Claude Haiku 4.5', input: 1.0, output: 5.0 },
  { match: /fable-5|mythos-5/, name: 'Claude Fable/Mythos 5', input: 10.0, output: 50.0 },
  {
    match: /opus-4-8/,
    name: 'Claude Opus 4.8',
    input: 5.0,
    output: 25.0,
    // Opus 4.8 also supports fast mode, but its premium rate is not published
    // in the rate card this table was built from. Left unset on purpose: a
    // guessed multiplier is worse than a known-standard number, and
    // costForTurn flags the turn via `fastUnpriced` so it can be surfaced
    // rather than silently absorbed.
  },
  { match: /opus-4-7|opus-4-6|opus-4-5|opus-4-1|opus-4-0/, name: 'Claude Opus 4.x', input: 5.0, output: 25.0 },
  { match: /sonnet-4/, name: 'Claude Sonnet 4.x', input: 3.0, output: 15.0 },
];

function priceFor(modelId) {
  if (!modelId) return null;
  return MODELS.find((m) => m.match.test(modelId)) || null;
}

// Resolves the rate actually in force for one turn: fast-mode premium first
// (it supersedes any dated rate), then any dated window the turn falls inside,
// then the standard rate.
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

// turn: { model, speed, at_ms, input_tokens, cache_read_input_tokens,
//         cache_creation_1h, cache_creation_5m, output_tokens }
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
