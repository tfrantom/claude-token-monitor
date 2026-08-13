# token-monitor-core

The watcher daemon and everything it directly needs: transcript parsing,
pricing, session naming, the semantic classification layer, and the terminal
statusline. Part of the [claude-token-monitor suite](../../README.md) — see
that root README for how this fits with the other packages.

## Pieces

- `lib/pricing.js` — per-model $/MTok table + cost math (cache write 1.25x/2x, read 0.1x)
- `lib/transcript.js` — parses a session's `.jsonl`, dedupes the repeated `usage`
  object per API turn (Claude Code logs one JSONL line per content block), and
  prorates each turn's single `output_tokens` figure across its blocks using
  **inter-block timestamp deltas** (not character length — thinking blocks are
  usually logged with empty text under Claude Code's default `display: "omitted"`,
  so length-based proration always reads thinking as zero; timing doesn't have
  that blind spot). Also collects every user turn's text (`userTexts`), not
  just the first, to support renaming.
- `lib/llm-client.js` — thin hand-rolled client (no SDK) hitting
  [`llama-local-server`](../llama-local-server/)'s OpenAI-compatible endpoint.
  `nameSession` names a block of text cold — it is the **only** naming call
  the watcher makes, for both the first name and every rename.
  `checkNameChange` is kept but **superseded and unused**; see "Naming never
  asks the model whether to rename" below for why.
- `lib/semantic-classifier.js` — same llama-local-server endpoint, JSON-schema
  structured output, batched one request per turn — tags each turn's
  tool_use blocks with a purpose (explore/mutate/verify/redundant/other).
  Also asks for a thinking-block productive/looping verdict per
  `lesson-sessions/token-classifier-demo/PLAN.md`, but that half is
  currently a no-op: thinking blocks are logged with empty text under
  Claude Code's default `display: "omitted"`, so there's no content to
  classify. Left wired in rather than ripped out, in case that ever changes.
  Results are cached forever in `state/semantic-cache.json`, keyed by turn
  (message) id — finalized turns never change, so each one is classified
  exactly once, backfilled `SEMANTIC_TIME_BUDGET_MS` worth per tick so a
  burst of new turns can't stall the poll loop. Gated by
  `SEMANTIC_CLASSIFICATION_ENABLED` in `config.js` (default `true`) — flip
  to `false` to fall back to the pre-semantic-layer behavior exactly: no LLM
  calls, no cache reads/writes, and `status.json` sessions carry no
  `semantic` key at all (not a zeroed-out one), which `statusline.js` and
  the nvim plugin already render identically to before that key existed.
- `watcher.js` — the daemon: polls `~/.claude/projects/**/*.jsonl` every 5s for
  files modified in the last 30 min, classifies each (plus each one's subagent
  sidechains — see below), writes `state/status.json`. Refuses to start if
  another watcher already holds `state/watcher.lock` (see "Only one watcher at
  a time"). Also renames sessions as they drift: no trigger word, no mode to get stuck
  in — every tick diffs `userTexts` against `named_at_turn_count` (how many
  user turns existed at the last check) for free, no model call. Only when
  that diff is non-empty *and* `RENAME_MIN_INTERVAL_MS` (15s) has passed
  since the last attempt does it ask the model — via `nameSession`, to *name*
  the recent text, never to judge whether it changed (see "Naming never asks
  the model whether to rename"); a diff under `RENAME_MIN_NEW_CHARS`
  (config.js) is skipped without even resetting the "seen" counter, so a
  short reply just accumulates into the next check instead of being
  discarded. The 15s interval is a pure rate-limit backstop (local inference
  on an idle GPU is cheap; it exists so a burst of rapid-fire short messages
  can't fire a model call on every single poll tick), not a "wait this long
  to notice" delay. The same-task-vs-real-switch call is made by `sameTopic`
  in `watcher.js`, in code, from the name the model returned.
- `statusline.js` — what Claude Code actually invokes on every render. Fast —
  only reads `state/status.json`, does no parsing or LLM calls itself. Filters
  out `ended` sessions (see below) so a closed session leaves the bar
  immediately. Renders running subagents too: the session the bar belongs to
  gets a per-agent `tokens-cost` list, every *other* session collapses to a
  `3A` count badge — otherwise N terminal tabs each render N agent lists and
  the line is unreadable. The nvim plugin's `format.lua` mirrors this exactly.

## Naming never asks the model whether to rename

The model is asked to do exactly one thing — **name this text** — and the
decision "is that a different topic than the current name?" is made in code
(`sameTopic` in `watcher.js`, shared-significant-word overlap after splitting
camelCase and dropping generic words like *session*/*work*/*task*).

This is not stylistic. Measured on this machine with llama3.2 at temp 0.1,
given a blatant topic switch (one project → an unrelated one):

| prompt shape | correct renames |
|---|---|
| shown its current name, asked "repeat it if unchanged, else rename" | **0 / 8** |
| given the same text with no current name in the prompt | **8 / 8** |

Echoing back the name it was just handed is the lowest-effort token path and a
3B model takes it every time. Same lesson as the semantic classifier's
`changed:boolean` dead end: **get an artifact out of a small model, derive the
decision from it in code** — never ask it to self-report a judgment.

Three related traps, all of which had to be fixed together for renaming to
work at all:

- **Not every `type: "user"` entry is the user.** Background-task
  completions, `[Request interrupted…]` markers, skill preambles and injected
  reminders all log as user turns, and they are routinely *longer* than real
  messages — one observed `<task-notification>` was 5111 chars against a
  184-char actual message. `lib/transcript.js` filters these out of
  `userTexts`; without it a finishing subagent can rename the session.
- **Truncate per message, from the front — never tail-slice the joined
  string.** One long message could otherwise push every other message,
  including the newest, entirely out of the prompt.
- **Recency is the signal.** Naming off the newest message alone beat naming
  off the last three: with several messages in the window, a topic change puts
  multiple subjects in the prompt and the model names the session after the
  *oldest* one. Older messages are only pulled in to pad a very short newest
  message (`MIN_CONTEXT_CHARS`).

### Changing what counts as a turn strands the cache

`named_at_turn_count` is an index into `userTexts`. Any change to what
qualifies as a user turn changes the basis of that count — filtering
injected notifications dropped one live session from 18 to 14 — leaving the
stored counter permanently *above* the real length, so `slice()` returns
nothing and that session can never be renamed again. `getOrUpdateName`
detects `stored > current`, clamps, and forces one re-sync check. Keep that
guard if you ever change the filter again.

## Subagent (Task) transcripts are counted

Subagent turns live in their own sidechain transcripts at
`~/.claude/projects/<project>/<session-id>/subagents/agent-*.jsonl`, each with
a sibling `agent-*.meta.json` carrying `toolUseId`, `description`, and
`agentType`. They hold **real API turns with their own `usage`**, and they are
**not** duplicated in the parent — the parent transcript only records the
`Task`/`Agent` tool_result.

Before this, `findActiveSessionFiles()` globbed only top-level
`<project>/<session>.jsonl`, so every subagent's spend was invisible to
`status.json`, both status bars, and the `token-usage` skill alike. Measured on
this machine at the time of the fix: **401 subagent turns vs 335 parent turns**
in one session with **zero overlapping message ids**, and **~18% of total spend
unaccounted for** ($25 of $139 across the whole transcript set). Much worse on
a Task-heavy session. Found by
[`projects/per-project-cost-attribution`](../../projects/per-project-cost-attribution/),
whose independent parser reconciles against `classifySession()` key-by-key.

How the fold-in works (`mergeSubagent` in `watcher.js`):

- **Totals are summed** into the parent session's entry. Turn ids are globally
  unique (verified: zero overlap), so the semantic classifier just sees extra
  turns and its per-turn cache keys can't collide.
- **`userTexts` is deliberately *not* merged.** A subagent transcript's "user"
  entries are the prompt *this session sent to the agent*, not anything the
  human typed. Merging them would feed the renamer text the user never wrote
  and let a subagent's task hijack the session name.
- **`sessions[id].agents`** lists *currently running* agents only, in the order
  their `Agent` tool_use blocks appear in the parent (which is UI order). An
  agent is running until a `tool_result` closes its `tool_use`. Finished agents
  are excluded on purpose — their spend is already in the session total, and
  keeping them listed would grow the line monotonically. The key is always
  present (empty array, never absent) so consumers can render unconditionally.
  A just-spawned agent with no transcript on disk yet reports zeros rather than
  being dropped.

Consumers wanting *finished*-agent history should read the transcripts
directly; `projects/per-project-cost-attribution` already does, with `agent` /
`agent_type` as rollup dimensions.

## Only one watcher at a time

`watcher.js` acquires a PID-file lock at `state/watcher.lock` on startup. A
live PID in that file means it prints an error and exits 1; a dead PID means
the previous watcher crashed and this one takes over. The lock is released on
`SIGINT`/`SIGTERM`/`exit`, and only if the file still holds *this* process's
PID.

This exists because the watcher is a singleton over shared state: every
instance writes the same `status.json` on the same cadence, so N instances
don't divide the work, they race — last writer wins. **Three watchers were
found running at once** (started by three different Claude Code sessions on
this machine), and the two stale ones were overwriting the subagent-cost fix
and the `agents` key with old-format data, which read as the *new* code being
broken. A stale writer is worse than no writer, because its output still looks
plausible.

If you need to restart it: kill the running one first, or delete
`state/watcher.lock` only after confirming that PID is actually gone.

## Ended-session detection

Claude Code maintains its own process registry at `~/.claude/sessions/<pid>.json`
(one per live interactive session, carrying `sessionId`, `pid`, `status`, …),
removed on clean exit. Each tick the watcher reads that directory and
cross-checks every PID against the OS with `process.kill(pid, 0)` — the file's
presence alone isn't proof of life, since a hard kill (task manager, terminal
window closed) can leave a stale one behind. A session with no live PID gets
`ended: true` in `status.json`.

This matters because a transcript's mtime can't distinguish "ended" from
"idle" — it freezes at the last message either way, so before this an ended
session lingered on the bar, indistinguishable from a live one, for the full
30-minute window.

**Where the split lives:** the watcher does *not* drop ended sessions early.
They stay in `status.json`, flagged, until they age out of
`ACTIVE_SESSION_WINDOW_MS` like anything else — because other consumers want
that transition (`projects/usage-history-rollups` in particular wants exactly
this "session just ended" checkpoint, and previously would have had to diff
consecutive ticks to synthesize it). The **status bars** filter `ended`
sessions out themselves, immediately. So: data layer retains the signal,
presentation layer hides it. Anything new reading `status.json` should expect
`ended` entries and decide for itself whether to show them.

## Running

```sh
node watcher.js
```

Run this in its own terminal window (or let it run detached). Exactly one
instance may run at a time — a second one exits immediately on the
`state/watcher.lock` guard rather than racing the first (see above). It's
idempotent about its dependency, though: if an `llama-server` is already up on
port 8090 it reuses it instead of spawning a second one (see
[`llama-local-server`](../llama-local-server/)).

`statusLine` is wired up in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node <suite-root>/packages/token-monitor-core/statusline.js", "refreshInterval": 2 }
```

## Known limitations

- Token buckets (thinking/writing/tool_calls) are **estimates** — the API only
  reports one `output_tokens` total per turn, never a per-block split.
  Context/cache-read/cache-write/cost are exact, straight from `usage`.
- The semantic layer's thinking-block verdict never fires (see
  `lib/semantic-classifier.js` above) — thinking text isn't persisted to the
  transcript at all, only an encrypted signature. Tool-call purpose tagging
  (`sessions[id].semantic.tool_*` in `state/status.json`) works and runs live.
- "Active sessions" = any transcript touched in the last 30 minutes
  (`config.js` → `ACTIVE_SESSION_WINDOW_MS`), not just the current window.
  Ended sessions still count toward that window in `status.json` (flagged
  `ended`) even though no status bar renders them — see above.
- Ended-session detection only covers `kind: "interactive"` sessions, since
  those are what Claude Code registers in `~/.claude/sessions/`. If the
  registry directory is missing entirely, every session reads as ended
  (fail-toward-hiding rather than showing stale entries forever).
- Session names update as a conversation evolves (see `watcher.js` above),
  typically within `RENAME_MIN_INTERVAL_MS` (15s) of a real topic change —
  not instant, but no longer minutes-scale lag either. Each check is one
  small local-model call whose only job is to *name* the recent text, so
  quality is bounded by what a 3B can do with a short prompt: the generated
  name can occasionally come out oddly formatted (e.g. missing spaces) on
  dense input. Whether that name counts as a topic change is `sameTopic`'s
  call, in code — a word-overlap heuristic, so two genuinely different
  topics that share one significant word will not trigger a rename.
- `packages/llama-local-server/server.js` spawns `llama-server.exe` with no
  `-np`/`--parallel` flag, so **each instance** serves one request at a time.
  Naming calls, semantic-classifier backfill, and the `token-usage` skill's
  lookups all share the single queue on 8090 — fine at current usage, but if
  renaming ever feels sluggish with several active sessions at once, that
  shared queue (not the 15s interval) is the thing to look at first; bumping
  `-np` is the lever, not lowering `RENAME_MIN_INTERVAL_MS` further. Any
  dedicated instance on its own port has its own queue and does not contend
  with this one.
