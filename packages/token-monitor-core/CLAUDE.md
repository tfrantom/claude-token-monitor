# token-monitor-core — working notes for Claude

The watcher daemon, the transcript parser, the rate card, and the status-line
renderer. Everything else in the suite reads this package's output. See
[`README.md`](README.md) for the design, and the [suite
CLAUDE.md](../../CLAUDE.md) for rules that apply everywhere.

```sh
node test.js           # 38 offline checks, no watcher, no network
node test-lifecycle.js --take-over   # end-to-end; takes over port 8090
```

## The singleton rule

`watcher.js` refuses to start if a live PID holds `state/watcher.lock`. Do not
work around this. Kill the running one first. Two watchers do not divide the
work — they race on `status.json`, and the loser's stale data looks perfectly
plausible.

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
that throws prints a stack trace ten times a second.

The supervisor never starts `llama-server` itself. A process that lives 100ms
has no business owning a model server; the watcher does that.

## Idle shutdown, and the reading that must not be guessed

The watcher exits after `IDLE_SHUTDOWN_MS` with no live Claude Code session,
stopping the shared `llama-server` it owns.

`loadLiveSessions()` returns `{ live, known }`, and the distinction is
load-bearing. "The registry says nobody is running" and "there is no readable
registry" used to collapse into the same empty set, which was harmless when the
only consumer was an `ended` flag. It is not harmless now: on a Claude Code
build with no `~/.claude/sessions`, unknowable would read as zero, the watcher
would exit, the status line would restart it, and the two would spin forever —
reloading a 2.5 GB model every cycle. Only an authoritative zero counts.

## Do not touch the live `status.json` in a test

The watcher rewrites it every 5 seconds. `renderLine(input, statusOverride)`
takes an optional second argument for tests; production callers pass one
argument and let it read the file. Transcript fixtures go in a `mkdtemp` dir.

## Pricing

`lib/pricing.js` is the suite's rate card and it has a second caller outside
this package — see the suite CLAUDE.md before changing its input shape. Verify
rates against the `claude-api` skill, never from memory.

`rateFor()` resolves fast-mode premium first, then dated windows, then the
standard rate. Dated windows are keyed on the **turn's** timestamp, not wall
clock, so re-parsing an old transcript bills it at the rate that was in force
when it ran. A window that has closed needs no code change.

Two failure signals are surfaced rather than swallowed, and both belong in
`status.json` so downstream consumers can see them:

- `unpriced_output_tokens` — model id matched nothing; the turn contributed $0.
  This is the only warning that a newly-shipped model is being counted as free.
- `fast_unpriced_output_tokens` — fast mode on a model with no published
  premium rate. Billed at standard, so the number is a floor, not a lie.

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

## Running vs finished subagents

Decided by **subagent transcript mtime**, not by whether the `Agent` tool_use
has a `tool_result`. A background agent's Task call resolves immediately at
launch (the "launched successfully" ack), so resolution marks every background
agent finished the instant it starts. `buildAgentList` uses write activity
because it is the one signal that works for both background and synchronous
agents.

Only *running* agents are listed. Finished ones are already folded into the
session total by `mergeSubagent`; listing them too would double-read as growth
and the line grows without bound.

## Naming

The model is asked to **name** text, never to judge whether the name should
change — that comparison happens in code (`sameTopic`). Measured: shown its
current name and asked "same or different?", llama3.2 answered "no change" 8/8
on a blatant topic switch, because repeating the name it was just handed is the
lowest-effort token path. Asked to name the same text cold, it was 8/8 correct.
`checkNameChange()` in `lib/llm-client.js` is kept as a documented dead end.

Naming reads real user turns only. `mergeSubagent` deliberately does not merge
`userTexts`: a subagent transcript's "user" entries are the prompt *this session
sent to the agent*, and merging them lets a background task rename the session.
