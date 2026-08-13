# usage-history-rollups — working notes for Claude

See [`README.md`](README.md) for what it is and how to run it, and the
[projects CLAUDE.md](../CLAUDE.md) for the `status.json` rules every consumer
here has to follow.

## Arms-length from `token-monitor-core`

`status.json` is read **by path**, never `require()`d across the package
boundary — the same relationship `statusline.js`, the nvim plugin and the
`token-usage` skill have with it. `config.STATUS_FILE` is env-overridable
purely so the test harness can point at a scratch fixture.

## When it snapshots

The watcher publishes `ended: true` per session, derived from cross-checking
Claude Code's own `~/.claude/sessions/<pid>.json` registry against live PIDs,
and keeps ended sessions in `status.json` for the rest of the 30-minute window.
The signal is a **level, not an edge**, so a poller on its own cadence does not
need to have observed the immediately preceding tick. That is also why
`POLL_INTERVAL_MS` can be 60s against the watcher's 5s: there is no hurry.

| `reason` | Fires when | Role |
|---|---|---|
| `ended` | Session reads `ended: true` on `ENDED_CONFIRM_POLLS` (2) consecutive polls | **Primary.** The real end-of-session checkpoint. Written once per session lifetime. |
| `vanished` | Session left `status.json` without ever being finalized | **Fallback.** Covers the gaps `ended` cannot: poller down across the whole 30-minute window, or the session aged out while the registry was unreadable. Uses last-known totals. |
| `periodic` | A still-live session, every `PERIODIC_SNAPSHOT_MS` (1h) | **Sampling.** Not just a safety net — consecutive snapshots are what let `report.js` compute per-period deltas instead of dumping a multi-hour session's whole cost onto whichever day it ended. |

A session finalized by `ended` is never resampled — its totals cannot change —
and is never re-written while it lingers in the window.

**Why the confirmation threshold.** If `~/.claude/sessions/` is missing or
unreadable, `loadLiveSessionIds()` returns an empty set and **every** session
reads as ended at once. Requiring the signal to persist across two polls costs
one extra poll of latency against a 30-minute window and turns that hiccup into
a no-op. A single-poll blip must also reset `ended_polls`, or flickers
accumulate toward the threshold.

## Unreadable is not "no sessions"

`readStatus()` returns `null` for a missing file, malformed JSON, or a payload
with no `sessions` key, and the caller **skips the whole poll**. Treating any of
those as an empty session set would roll up every live session as `vanished`.
This matters in practice: other work in this suite restarts the watcher, so the
file can be briefly absent.

Two more recovery paths:

- **Poller restarts** are covered by `last-seen.json`. If that is lost too,
  `seedFinalizedFromHistory()` re-derives the finalized set from
  `history.jsonl`, so a still-lingering ended session does not get a duplicate
  final. A session seen live again clears the flag, so this cannot suppress a
  resumed session's second end.
- **Resumed sessions** — `claude --resume` reuses the session id under a new
  PID — clear `finalized` when seen live again, so the extra cost earns a second
  final snapshot.

A torn final line in `history.jsonl` (killed mid-append) is skipped rather than
failing the whole read.

## Schema

One JSON object per line in `state/history.jsonl`:

```jsonc
{
  "v": 1,                                  // SCHEMA_VERSION, bumped only on a breaking change
  "ts": "2026-08-06T04:34:25.241Z",        // when this snapshot was taken
  "reason": "ended",                       // ended | vanished | periodic
  "session_id": "7973860d-…",
  "project": "C--projects",                // Claude Code's coarse per-terminal grouping
  "name": "Bug Me Claude",
  "models": ["claude-opus-5"],
  "first_seen_at": "2026-08-06T04:34:19Z", // first poll that saw it, NOT session start
  "last_activity": "2026-08-06T04:09:22Z", // last transcript timestamp, from the watcher
  "totals":   { "context": 14, "cache_write": 44779, "cache_read": 234024,
                "thinking": 368.3, "writing": 1276.5, "tool_calls": 707.2,
                "cost_usd": 0.623672, "unpriced_output_tokens": 0 },
  "semantic": { "thinking_productive": 0, "tool_explore": 707.2, … },
  "by_project": null                       // reserved — see below
}
```

`totals` and `semantic` are passed through verbatim from `status.json`, so
anything that renders a session's totals renders a history entry's too.

**Discontinuity to know about:** as of 2026-08-06 the watcher folds **subagent
(Task) transcripts** into each session's totals — previously missing entirely,
worth roughly **+18%**. Lines written before that date are on the old
main-transcript-only basis, so `report.js` can show one artificially large delta
at the changeover. No `v` bump: the schema did not change, only the upstream
numbers.

### Entries are cumulative, not deltas

`totals` is the session's **lifetime** total as of `ts`. A session with three
snapshots at $2 / $5 / $9 cost **$9**, not $16. Summing lines is the obvious
wrong answer. Take the latest entry per session, or difference consecutive
entries of the same session. `report.js`'s `toDeltas()` is the reference
implementation — use it rather than re-deriving this.

Two details inside it: the *first* snapshot of a session contributes its full
cumulative total, because everything before it was never observed; and deltas
are clamped at zero so a transcript re-parse or a resume cannot produce negative
cost. `report.js` also differences over the **full** history and filters
afterwards — the other order makes the first in-window snapshot of an older
session dump its entire pre-window lifetime into the report.

### Fitting `per-project-cost-attribution`

`by_project` is the join point with that project's finer repo/cwd dimension, and
is `null` until `status.json` carries such a breakdown. The two dimensions
compose rather than collide: **time** is one line per snapshot, **project** is a
nested object inside the line. A breakdown appearing on the session object flows
into history with no change to `poller.js` and no `v` bump, since `null` is a
valid value for the field rather than a schema break.

## Retention

**Policy: for any UTC day older than `--keep-days` (7), keep only the last
snapshot per session per day.** Recent days keep full detail.

Last-per-session-per-day is the specific choice that makes this lossless at
daily resolution: because entries are cumulative and `report.js` differences
consecutive ones, keeping each session's value at each day boundary leaves all
daily and coarser totals bit-for-bit correct. Only sub-day resolution on
week-old data is lost. Keeping the *first* entry of each day instead would
corrupt the differencing.

`compact.js` is the only operation in the project that deletes data: it writes a
temp file and renames, so an interrupted run cannot leave a truncated history,
and it keeps a one-generation `.bak`. Growth without compaction is roughly one
line per session end plus one per live session-hour — tens of KB a week, so
compaction is housekeeping, not a pressing need.

## Verification

`node test-poller.js` — 41 assertions driving `poll()` against a scratch fixture
(`ROLLUP_STATUS_FILE` / `ROLLUP_STATE_DIR` are redirected at a `mkdtemp` dir
*before* `config` is required, so the real history is never touched). Covers the
confirm threshold, dedup, the vanished fallback, all three unreadable-file
cases, resume/re-finalize, periodic sampling, delta differencing, and
compaction-preserves-totals. It is wholly offline.

## Limits

- Ended detection only covers `kind: "interactive"` sessions, since those are
  what Claude Code registers in `~/.claude/sessions/`. Non-interactive sessions
  fall through to the `vanished` fallback.
- `first_seen_at` is when *this poller* first saw the session, not when the
  session started.
- A session that starts *and* ends entirely while the poller is down is lost.
  Only the watcher's 30-minute window is recoverable, and only for sessions
  still inside it.
