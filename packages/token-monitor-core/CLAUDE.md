# token-monitor-core — working notes for Claude

The watcher daemon, the transcript parser, the rate card, and the status-line
renderer. Everything else in the suite reads this package's output. See
[`README.md`](README.md) for what it is and how to run it, and the [suite
CLAUDE.md](../../CLAUDE.md) for rules that apply everywhere.

```sh
node test.js           # 38 offline checks, no watcher, no network
node test-lifecycle.js --take-over   # end-to-end; takes over port 8090
```

## What is where

| File | Role |
|---|---|
| `watcher.js` | The daemon. Polls `~/.claude/projects/**/*.jsonl` every 5s for recently-modified transcripts, classifies each one plus its subagent sidechains, names sessions, writes `state/status.json`. Holds a PID lock; exactly one may run. |
| `statusline.js` | What Claude Code invokes on every render. Reads `state/status.json` and formats it; starts the watcher if none is running. Does no parsing and makes no LLM calls. |
| `lib/transcript.js` | Parses one session `.jsonl` into per-turn totals, per-block classifiable text, user turns, and `Agent` spawns. |
| `lib/pricing.js` | Per-model $/MTok rate card and the cost math, including fast-mode premiums and dated intro windows. |
| `lib/llm-client.js` | Hand-rolled client (no SDK) for `llama-local-server`'s OpenAI-compatible endpoint. `nameSession` names a block of text. |
| `lib/semantic-classifier.js` | Tags each turn's `tool_use` blocks with a purpose and each thinking block with a quality verdict, via JSON-schema structured output, one batched request per turn. |
| `lib/supervisor.js` | `ensureWatcher()` — the on-demand start called by the status line. |
| `config.js` | Every tunable. The `CLAUDE_*` and `TOKEN_MONITOR_*` env overrides exist so the lifecycle logic can be pointed at a fixture: "no live sessions" is otherwise untestable from inside a live session. |

`llama-local-server` is the only cross-package dependency.

## The singleton rule

`watcher.js` refuses to start if a live PID holds `state/watcher.lock`. Do not
work around this. Kill the running one first. Two watchers do not divide the
work — they race on `status.json`, and the loser's stale data looks perfectly
plausible. This happened for real: three at once, from three Claude Code
sessions, with the two stale ones writing old-format data that read as the new
code being broken.

`watcher.js` is `require()`-able precisely so you can exercise its naming
helpers (`sameTopic`, `topicWords`, `joinRecent`) without starting a daemon.

## The status line starts the watcher, and that budget is tiny

`statusline.js` calls `lib/supervisor.js`'s `ensureWatcher()` on every render.
Claude Code invokes the status line ~10x/second *per open session* (measured:
~102ms median), so the already-running path is one `readFileSync` of the lock
file and one signal-0 probe — no network, no spawn, no `llama.cpp`. Everything
expensive sits behind "no live watcher", which is rare by construction.

Three guards keep a broken install from turning into a spawn storm: a
machine-wide cooldown stamp (`state/watcher-spawn.json`), a consecutive-failure
ceiling after which the line says so instead of retrying, and the watcher's own
PID lock as the final arbiter. `ensureWatcher()` never throws — a status line
that throws prints a stack trace ten times a second. Nothing in `statusline.js`
may turn a render into a stack trace either: `status.json` is written by a
separate process that upgrades independently, so a renamed key must degrade to
one dim line.

The supervisor never starts `llama-server` itself. A process that lives 100ms
has no business owning a model server; the watcher does that.

`config.js`'s `STATUSLINE_TRACE` writes one JSON line per invocation with the
render cadence and `status.json`'s age. Flip it on if the bar ever looks stale;
the writer is wrapped because diagnostics must never break a render.

`refreshInterval: 2` in the installed `statusLine` setting is required, not
cosmetic. Claude Code re-renders on events (new message, `/compact`, mode
change) and those go quiet while a session is idle, so without a timer the bar
freezes after a turn ends and reads as "the name lags one prompt behind".
Rebuilding the settings object wholesale dropped it once already.

## The watcher re-ensures the shared server every tick

Not just at startup. Ensure-once made the watcher poll a dead backend forever
after the server was killed, with naming and classification failing silently
because both tolerate a null from the model — nothing looked wrong. See the
suite CLAUDE.md "Only one watcher, and only one shared server".

## Idle shutdown, and the reading that must not be guessed

The watcher exits after `IDLE_SHUTDOWN_MS` with no live Claude Code session,
stopping the shared `llama-server` it owns. The grace period matters: zero
sessions is a normal reading *between* two sessions, and tearing down on the
first such tick costs a cold model load for a few seconds of gap.

`loadLiveSessions()` returns `{ live, known }`, and the distinction is
load-bearing. "The registry says nobody is running" and "there is no readable
registry" used to collapse into the same empty set, which was harmless when the
only consumer was an `ended` flag. It is not harmless now: on a Claude Code
build with no `~/.claude/sessions`, unknowable would read as zero, the watcher
would exit, the status line would restart it, and the two would spin forever —
reloading a 2.5 GB model every cycle. Only an authoritative zero counts.

Liveness of a session is the registry PID cross-checked against the OS, not the
file's presence: a hard kill leaves a stale `<pid>.json` behind, and a
transcript's mtime freezes at the last message whether the session ended or
merely went idle.

## Ended sessions stay in the data and are hidden by the presentation

The watcher does *not* drop `ended` sessions early — they stay in
`status.json`, flagged, until they age out of `ACTIVE_SESSION_WINDOW_MS`,
because `projects/usage-history-rollups` wants exactly that "session just
ended" checkpoint rather than having to diff consecutive ticks. The status bars
filter them out themselves. Anything new reading `status.json` should expect
`ended` entries and decide for itself.

An ended session is also never re-named: its name is final, so the watcher
reuses the cached one rather than spending a model call.

## Output contract: `state/status.json`

Rewritten atomically every tick. Consumers should tolerate unknown keys.

```jsonc
{
  "updated_at": "2026-08-12T09:31:04.512Z",
  "sessions": {
    "<session-id>": {
      "session_id": "<session-id>",
      "project":    "C--projects-claude-token-monitor",  // Claude Code's project dir name
      "name":       "Token Monitor Cleanup",             // or "(unnamed session)"
      "ended":      false,                               // no live PID in Claude Code's registry
      "last_activity": "2026-08-12T09:30:58.220Z",       // last transcript timestamp
      "mtime_ms":   1786... ,                            // transcript mtime, used for ordering
      "models":     ["claude-opus-5"],

      "totals": {
        "context":     123456,   // exact, from usage.input_tokens
        "cache_write": 45678,    // exact, 5m + 1h creation
        "cache_read":  901234,   // exact
        "thinking":    12345.6,  // estimated: prorated share of output_tokens
        "writing":     2345.1,   // estimated
        "tool_calls":  3456.3,   // estimated
        "cost_usd":    12.3456,  // exact
        "unpriced_output_tokens": 0,       // model id matched no rate-card row
        "fast_unpriced_output_tokens": 0   // fast mode, no published premium rate
      },

      // Currently-running subagents only, in UI order. Always present.
      "agents": [
        { "description": "Audit comments", "agent_type": "general-purpose",
          "tokens": 84210, "cost_usd": 1.87 }
      ],

      // Omitted entirely when SEMANTIC_CLASSIFICATION_ENABLED is false.
      // Sub-splits the prorated thinking/tool_calls figures; never a competing total.
      "semantic": {
        "thinking_productive": 0, "thinking_wasted": 0, "thinking_unclassified": 12345.6,
        "tool_explore": 0, "tool_mutate": 0, "tool_verify": 0,
        "tool_redundant": 0, "tool_other": 0, "tool_unclassified": 0
      }
    }
  }
}
```

The three estimated buckets sum to the turn's `output_tokens`; the semantic
buckets sum to their parent bucket, and a block with no usable verdict lands in
`*_unclassified` so its tokens are still accounted for somewhere. Ended sessions
remain present, flagged, until they age out of `ACTIVE_SESSION_WINDOW_MS`.

Two shapes are deliberate and consumers rely on them: `agents` is an empty array
rather than absent, so nothing needs a presence check; and `semantic` is absent
rather than zeroed when classification is off, which is exactly the
pre-semantic-layer shape both status bars already render.

`unpriced_output_tokens` and `fast_unpriced_output_tokens` are surfaced rather
than swallowed — they are the only warning that a turn's cost is $0 or a floor.

Other files under `state/` are caches, not contract: `names-cache.json`,
`semantic-cache.json` (keyed by turn id, never invalidated — finalized turns do
not change), `watcher.lock`, `watcher-spawn.json`.

## The semantic layer

One batched round trip per turn, because a turn's blocks share context: a third
tool call is only visibly redundant next to the first. Every block in the
response schema carries every field, with `"na"`/`0` filler where a field does
not apply to its type — one flat shape is easier for grammar-constrained
decoding to get right than a discriminated union.

Backfill is time-boxed (`SEMANTIC_TIME_BUDGET_MS`), not count-boxed, so no
number of new turns can stall the poll loop, and a failed turn gets a cooldown
sentinel (`SEMANTIC_RETRY_MS`) rather than an immediate retry — otherwise a down
`llama-server` makes every tick a wall of doomed requests.

## What the status line renders

Only the active session gets the per-agent breakdown; otherwise N terminal tabs
each render N agent lists and the line is unusable. Other sessions collapse to a
count badge (`3A` == three running agents). Every `ensureWatcher()` state must
render as a distinguishable message — a user has to be able to tell "coming up
in a second" from "broken, go look" — and `test.js` asserts that none of them
collapse into each other.

## Do not touch the live `status.json` in a test

The watcher rewrites it every 5 seconds. `renderLine(input, statusOverride)`
takes an optional second argument for tests; production callers pass one
argument and let it read the file. Transcript fixtures go in a `mkdtemp` dir,
and `TOKEN_MONITOR_STATE_DIR` must be redirected *before* anything requires
`config.js`.

`test.js` covers only the supervisor branches that decide **not** to spawn. The
spawning one belongs to `test-lifecycle.js`: a unit test that launches a daemon
leaves one behind when it fails.

### The lifecycle test

`test-lifecycle.js` proves the whole chain:

```
status line render  ->  watcher  ->  shared llama-server
last session exits  ->  watcher exits  ->  llama-server stopped
```

It is registered `unsafe` in `run-checks.js` because it loads a model onto the
GPU and asserts on the state of the shared port 8090, so it needs that port to
itself and refuses to run when another watcher holds it. On any machine using
this suite a watcher already holds it, started moments ago by the status line of
the session running the test — `--take-over` pauses autostart, stops that
watcher, and restores autostart on the way out.

Everything else is isolated into a temp dir, including a fake
`~/.claude/sessions` registry whose "live session" is a sleeping node process
the test owns. That fake registry is the only reason the idle path is testable:
the real one always contains the session running the test.

## Pricing

`costForTurn()` takes `{ model, speed, at_ms, input_tokens,
cache_read_input_tokens, cache_creation_5m, cache_creation_1h, output_tokens }`.

`lib/pricing.js` is the suite's rate card and `costForTurn()` has **two**
callers — `finalizeTurn()` here and `totalsForTurn()` in
`projects/per-project-cost-attribution/lib/attribute.js`. Both must pass the
same inputs; `speed` and `at_ms` are load-bearing, not optional (omitting
`speed` under-reports a fast-mode turn by exactly half, omitting `at_ms` skips
dated windows entirely). Add an input to one call site and you must add it to
the other. Verify rates against the `claude-api` skill, never from memory.

`rateFor()` resolves fast-mode premium first, then dated windows, then the
standard rate. Dated windows are keyed on the **turn's** timestamp, not wall
clock, so re-parsing an old transcript bills it at the rate that was in force
when it ran. A window that has closed needs no code change.

Cache write/read are multipliers on the input rate (1.25x for a 5m TTL write,
2x for 1h, 0.1x for a read), not separate sticker prices.

Two things the table deliberately does **not** model — do not "fix" them:

- **No long-context premium.** A 1M window is standard-priced, so
  `claude-opus-5[1m]` costs the same as `claude-opus-5`; the bare `/opus-5/`
  match already handles it.
- **No batch discount.** Claude Code never uses the Batch API.

Two failure signals are surfaced rather than swallowed, and both belong in
`status.json` so downstream consumers can see them:

- `unpriced_output_tokens` — model id matched nothing; the turn contributed $0.
  This is the only warning that a newly-shipped model is being counted as free.
- `fast_unpriced_output_tokens` — fast mode on a model with no published
  premium rate (Opus 4.8 today). Billed at standard, so the number is a floor,
  not a lie. A guessed multiplier would be worse.

Rate-card row order matters: a looser `/opus-4/` rule placed before `/opus-5/`
would silently price Opus 5 off the 4.x row.

## Transcript parsing, and the two things that look like bugs

**Usage is per `message.id`, not per line.** One API turn is several JSONL
lines (one per content block) and every one of them repeats the turn's full
`usage`. Counting per line trebles everything. `finalizeTurn` closes a turn
when the message id changes.

**Output tokens are prorated by inter-block wall-clock delta, not character
length.** This looks wrong until you know that Claude Code's default
`display: "omitted"` leaves thinking blocks' text empty — a length-based weight
therefore assigns thinking a 0 share even when thousands of thinking tokens
were spent. Timestamps are the only signal that survives.

Two known limits of that approach, worth stating before someone rediscovers
them as bugs:

- The first block of a turn is weighted from the *previous entry's* timestamp,
  so it absorbs the model's time-to-first-token. It over-weights whatever came
  first, usually thinking.
- Blocks with no classifiable text never reach the semantic layer, so the
  `(N%p)` figure on the bar is computed over the subset of thinking blocks that
  had visible text — a different denominator from the total it annotates. When
  nothing is classified the renderer falls back to the plain number rather than
  showing a misleading 0%.

Only thinking and `tool_use` blocks carry classifiable text and reach `turns`. A
`text` block is already the answer the user sees, so there is nothing for the
semantic layer to judge about it.

The whole file is re-parsed every tick on purpose. Measured at 8ms per tick
against the active set on a 5-second loop; incremental byte-offset tailing
across turn boundaries that span multiple lines is not worth that.

## Subagent transcripts are counted, and they are not in the parent

Subagent (Task) turns live in sidechain transcripts at
`<project>/<session-id>/subagents/agent-*.jsonl`, each with a sibling
`agent-*.meta.json` carrying `toolUseId`, `description` and `agentType`. They
hold real API turns with their own `usage` and are **NOT** duplicated in the
parent — the parent records only the `Agent` tool_result. Missing them
under-reported spend by ~18% ($25 of $139 across one machine's transcripts;
401 subagent turns vs 335 parent turns in a single session, zero overlapping
message ids). Much worse on Task-heavy sessions. Turn ids being globally unique
is what lets the semantic cache key on them after the merge.

### Running vs finished subagents

Decided by **subagent transcript mtime**, not by whether the `Agent` tool_use
has a `tool_result`. A background agent's Task call resolves immediately at
launch (the "launched successfully" ack), so resolution marks every background
agent finished the instant it starts. `buildAgentList` uses write activity
because it is the one signal that works for both background and synchronous
agents. An agent with no transcript on disk yet has just spawned and reports
zeros rather than being dropped.

Only *running* agents are listed. Finished ones are already folded into the
session total by `mergeSubagent`; listing them too would double-read as growth
and the line grows without bound. Consumers wanting finished-agent history
should read the transcripts — `projects/per-project-cost-attribution` does.

## Naming

The model is asked to **name** text, never to judge whether the name should
change — that comparison happens in code (`sameTopic`). Measured: shown its
current name and asked "same or different?", llama3.2 answered "no change" 8/8
on a blatant topic switch, because repeating the name it was just handed is the
lowest-effort token path. Asked to name the same text cold, it was 8/8 correct. Do not re-add a
"has the topic changed?" call to `lib/llm-client.js`. Same lesson as the
semantic classifier: get an artifact out of a small model and derive the
decision from it in code.

**The excerpt is framed as data to label, and delimited.** The text being named
is itself addressed to an assistant, so without that framing the model answers
the user's message instead of naming it — measured 8/8 refusals on a real turn
("can you also include architecture diagrams?"), one of which reached the
status bar as "I Apologize For The Limitation". Same turn with the framing:
8/8 usable names. `cleanName`'s refusal regex is the net under that, not the
fix.

The prompt budget: `MAX_DIFF_CHARS` (7000) is sized to fill llama3.2's
4096-token window without overrunning it, and `joinRecent` owns that budget —
`lib/llm-client.js`'s `MAX_PROMPT_CHARS` is only a backstop, and it slices from
the *tail* because a head slice silently discards the newest message that
`joinRecent` just went to trouble to preserve. `cleanName` also rejects anything
over 60 chars or 8 words: the model occasionally starts explaining despite the
system prompt, and `max_tokens` then truncates it mid-thought.

Naming reads real user turns only. `mergeSubagent` deliberately does not merge
`userTexts`: a subagent transcript's "user" entries are the prompt *this session
sent to the agent*, and merging them lets a background task rename the session.

### Three traps that had to be fixed together

- **Not every `type: "user"` entry is the user.** Background-task completions,
  `[Request interrupted…]` markers, skill preambles and injected reminders all
  log as user turns, and they are routinely *longer* than real messages — one
  observed `<task-notification>` ran 5111 chars against a 184-char actual
  message. `lib/transcript.js` filters them out of `userTexts` by prefix, and
  strips injected blocks appended to otherwise-real messages.
- **Truncate per message, from the front — never tail-slice the joined
  string.** One long message could otherwise push every other message,
  including the newest, entirely out of the prompt.
- **Recency is the signal.** Naming off the newest message alone beat naming
  off the last three: with several messages in the window a topic change puts
  multiple subjects in the prompt and the model names the session after the
  *oldest*. Older messages are pulled in only to pad a short newest message up
  to `MIN_CONTEXT_CHARS` (600 — at 180 one ordinary "can you also add X?"
  cleared the floor on its own and got named after that sentence).

The model is nonetheless sent a rolling window of the last few messages, not
just the unseen ones: every check advances `named_at_turn_count`, so an
unseen-only diff is consumed by the attempt and a bad answer would be
permanent. Re-sending makes it self-correcting on the next tick.

### Changing what counts as a turn strands the cache

`named_at_turn_count` is an index into `userTexts`. Any change to what
qualifies as a user turn changes the basis of that count — filtering injected
notifications dropped one live session from 18 to 14 — leaving the stored
counter permanently *above* the real length, so `slice()` returns nothing and
that session can never be renamed again. `getOrUpdateName` detects
`stored > current`, clamps, and forces one re-sync check. Keep that guard if
you change the filter again.

## Known limitations

- The thinking/writing/tool_calls split is an **estimate**. The API reports one
  `output_tokens` total per turn and never a per-block breakdown, so the split
  is prorated from inter-block timestamps. Context, cache read/write and cost
  are exact.
- The semantic layer's thinking-block verdict effectively never fires: under
  Claude Code's default `display: "omitted"` thinking text is not persisted to
  the transcript, only an encrypted signature, so there is nothing to classify.
  Tool-call purpose tagging works and runs live. The thinking half is left
  wired in for if that ever changes.
- **The terminal status line does not render the semantic annotation at all.**
  `statusline.js` had a `renderThinking()` producing `thk 12k (72%p)` that was
  never called or exported; it was deleted as dead code. `token-monitor.nvim`'s
  `fmt_thinking` still renders it. Wiring it back into the terminal bar means
  writing it fresh — and is only worth doing if the point above changes, since
  the figure would read 0% classified today.
- Ended-session detection covers `kind: "interactive"` sessions only, since
  those are what Claude Code registers in `~/.claude/sessions/`.
- Session names come from a 3B local model given a short prompt, so a name can
  occasionally be oddly formatted on dense input. Whether a new name counts as
  a topic change is decided in code by `sameTopic`, a word-overlap heuristic:
  two genuinely different topics sharing one significant word will not trigger
  a rename.
- `llama-server` is spawned with no `-np`/`--parallel`, so the shared instance
  serves one request at a time. Naming, semantic backfill and the
  `token-usage` skill's lookups share that queue. If renaming feels sluggish
  with several sessions open, raising `-np` is the lever — not lowering
  `RENAME_MIN_INTERVAL_MS`.
