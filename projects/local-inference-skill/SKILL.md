---
name: local-inference
description: Offload a small, mechanical subtask -- classify text against a fixed label list, extract one literal value from text, or summarize a block of text -- to a local llama.cpp model instead of spending Claude API tokens on it. Use only for cheap, low-stakes, easily-verifiable work; never for judgment, correctness-critical code, or user-facing prose.
user-invocable: true
allowed-tools:
  - Bash(node *)
  - Write
---

# local-inference

Three narrow scripts that send a subtask to a local `llama3.2:3b` on
`http://127.0.0.1:8090` (llama.cpp's OpenAI-compatible server, from the
claude-token-monitor suite — `config.json` next to this file says where that
suite lives). A call costs zero API tokens and typically returns in under a
second.

The model is **3 billion parameters** and much weaker than you. Everything
below about scope exists because a bad delegation costs more than it saves: you
pay for the round trip *and* for reading a wrong answer *and* for redoing the
work.

## The one rule

**Delegate only work whose answer you could verify at a glance if you had to.**

If checking the local model's output would take about as much thought as just
doing the task, do the task. If you would not be comfortable using the result
without reading it, do the task.

### Good candidates

- Bucketing items into a **fixed, closed label list** you already decided on
  (file types, sentiment, ticket category, language) — `classify.js`
- Pulling a **literal, explicitly-present value** out of a chunk of text (an
  email address, a version string, a total) — `extract.js`
- A **throwaway one-line gist** of a file or log excerpt, for your own
  orientation — `summarize.js`
- The same tiny operation repeated over **many** items, where the batch is the
  whole reason it's expensive

### Never delegate

- Anything **correctness-critical**: writing, reviewing, or reasoning about
  code; security analysis; anything the user will run
- Anything **user-facing**: prose, explanations, commit messages, docs,
  answers you're going to relay. A 3B model's writing is visibly worse and
  the user did not ask for it
- Anything needing **real judgment** or multi-step reasoning: architecture
  calls, tradeoffs, "is this a bug", "should we do X", ambiguous
  classification where the labels overlap
- Anything where you **can't check the answer** because you don't have the
  source text yourself
- **Long input.** These scripts truncate (4–6k chars). If the answer might
  live in the truncated middle, the result is worse than useless
- Summarizing something you're **about to act on in detail** — read it
  properly instead

When in doubt: don't. Doing it yourself is the safe default, and the savings
here are small by construction.

## Invocation

Write the payload as a JSON file, then pass it with `--in`:

```
node "%USERPROFILE%\.claude\skills\local-inference\scripts\classify.js" --in payload.json
```

**Use `--in`, not a stdin pipe.** Windows PowerShell re-encodes anything piped
to a native executable through the console codepage, silently corrupting every
non-ASCII character on the way in (`Résumé` arrives as `RÃ©sumÃ©`). Stdin does
work from a POSIX shell (`node classify.js < payload.json`) if you prefer it
there.

Build the JSON file with the Write tool — never by interpolating text into a
shell command line, which will eventually break on a quote or a newline in the
input.

### `classify.js` — one label from a closed list

```json
{ "text": "Cannot log in, password reset loops",
  "labels": ["bug", "question", "feature-request"],
  "context": "these are support ticket subjects" }
```

or batched (up to 20 items, one request):

```json
{ "items": ["...", "...", "..."], "labels": ["bug", "question"] }
```

Output: the chosen label on stdout (one line per item, in input order, for the
batched form). `labels` is enforced by grammar-constrained decoding, so the
output is *always* one of your labels — or the literal `unclear`, which is
always available as an escape hatch and means none of them fit. `context` is
optional but helps a lot. Text is truncated at 4000 chars (500 per item when
batching).

### `extract.js` — one literal value from text

```json
{ "text": "<the source text>",
  "field": "the customer's email address",
  "instructions": "optional formatting guidance" }
```

Output: the extracted value on stdout, or the literal `(not found)` if it
isn't present. The model is instructed not to guess, and `(not found)` is a
normal successful result — treat a bare `(not found)` as "look yourself"
rather than "it isn't there", since a 3B model does miss things. Text is
truncated at 6000 chars.

### `summarize.js` — short gist

```json
{ "text": "<the source text>", "max_words": 40 }
```

Output: plain prose, no markdown. `max_words` defaults to 40 (range 5–200).
Text truncated at 6000 chars. For your own orientation only — do not pass this
through to the user as if you wrote it.

## Exit codes and fallback

- **exit 0** — usable result on stdout. `unclear` / `(not found)` are exit-0
  results too; they're answers, not errors.
- **exit 1** — delegation failed: bad input, the local server was unreachable
  and couldn't be started, or the model returned nothing usable. The reason is
  on stderr.

**On exit 1, do the subtask yourself and move on.** Do not retry the script,
do not try to start the server by hand, and do not report the failure to the
user as though something is broken — the local model is an optimization, and
a missing optimization is not a problem worth their attention. The scripts
already call `ensureRunning()`, which reuses a live server or spawns one and
waits up to 30s, so an exit 1 means that genuinely didn't work.

A transient failure right after a success (or vice versa) is expected on this
machine: other tools in the suite share the same server and one may be
restarting it. Same response — fall back silently, once.
