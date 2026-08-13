# usage-history-rollups

Persists token/cost history beyond the live snapshot. `status.json` is fully
overwritten every watcher tick with only currently-active sessions
(`ACTIVE_SESSION_WINDOW_MS` = 30 min) — once a session ages out, its data is
gone. This appends per-session snapshots to `state/history.jsonl` so "how
much this week" is answerable, not just "right now."

**Status: built and working.** Everything below describes what exists, not a
plan.

## Running it

```sh
node projects/usage-history-rollups/poller.js     # the daemon
node projects/usage-history-rollups/report.js     # read it back
```

`poller.js` is a standalone long-running process, separate from the watcher.
Start it alongside `packages/token-monitor-core/watcher.js`; it does nothing
but read that watcher's output file, so starting it late, restarting it, or
running it while the watcher is down are all fine (it just records less).

| File | What it is |
|---|---|
| `poller.js` | The daemon. Reads `status.json`, decides when to snapshot, appends to `history.jsonl`. |
| `report.js` | Reads `history.jsonl` back as daily or per-session totals. |
| `compact.js` | Retention — rolls up detail older than a week. Dry run unless `--apply`. |
| `config.js` | Paths and intervals, all env-overridable. |
| `test-poller.js` | 41 assertions over every transition and failure mode. `node test-poller.js`. |
| `state/history.jsonl` | The append-only log. |
| `state/last-seen.json` | Per-session bookkeeping carried across polls, so a poller restart doesn't lose in-flight state or duplicate finals. |

### It does not touch `packages/`

This project reads `packages/token-monitor-core/state/status.json` **by path**
— the same arms-length way `statusline.js` and the nvim plugin consume it. No
`require()` crosses the package boundary and nothing under `packages/` was
modified. `watcher.js` needed no hook; see below.

## Resolved: when to snapshot

The original brief proposed diffing consecutive ticks' session sets to
synthesize a "session ended" signal, and flagged that as needing a hook inside
`watcher.js`'s tick loop. **Neither turned out to be necessary.**

The watcher now publishes `ended: true` per session, derived from
cross-checking Claude Code's own `~/.claude/sessions/<pid>.json` registry
against live PIDs, and deliberately keeps ended sessions in `status.json` for
the rest of the 30-minute window so consumers can see the transition. That is
strictly better than tick-diffing: it's a true "the user closed this session"
edge rather than "the transcript went quiet," and because the ended state
*persists* for 30 minutes, catching it doesn't require having observed the
immediately preceding tick. An external poller on its own cadence is
therefore sufficient — the signal is a level, not an edge.

Three snapshot triggers, in order of importance:

| `reason` | Fires when | Role |
|---|---|---|
| `ended` | Session reads `ended: true` on `ENDED_CONFIRM_POLLS` (2) consecutive polls | **Primary.** The real end-of-session checkpoint. Written once per session lifetime. |
| `vanished` | Session left `status.json` without ever being finalized | **Fallback.** Covers the gaps `ended` can't: poller down across the whole 30-min window, or the session aged out while the registry was unreadable. Uses last-known totals. |
| `periodic` | A still-live session, every `PERIODIC_SNAPSHOT_MS` (1h) | **Sampling.** Gives long sessions a real time-series instead of one lump attributed to whichever day they ended. |

A session finalized by `ended` is never resampled (its totals can't change)
and never re-written while it lingers in the window.

### Why the confirmation threshold

`token-monitor-core`'s own README documents one mass-false-positive mode: if
`~/.claude/sessions/` is missing or unreadable, `loadLiveSessionIds()` returns
an empty set and **every** session reads as ended at once. Requiring the
signal to persist across two polls costs one extra poll of latency against a
30-minute window — free — and turns a transient filesystem hiccup from "bogus
final snapshots for every live session" into a no-op.

### Robustness

- **Unreadable `status.json` is never read as "no sessions."** Missing,
  malformed, or missing-its-`sessions`-key all skip the poll entirely.
  Treating any of them as an empty session set would roll up every live
  session as vanished. Matters in practice: other sessions in this suite
  restart the watcher, so the file can be briefly absent.
- **Poller restarts** are covered by `last-seen.json`; if *that* is lost too,
  the finalized set is re-derived from `history.jsonl` so a still-lingering
  ended session doesn't get a duplicate final.
- **Resumed sessions** (`claude --resume` reuses the session id under a new
  PID) clear the finalized flag when seen live again, so a resumed session's
  additional cost earns a second final snapshot when it ends again.

## Schema

One JSON object per line in `state/history.jsonl`:

```jsonc
{
  "v": 1,                                  // schema version
  "ts": "2026-08-06T04:34:25.241Z",        // when this snapshot was taken
  "reason": "ended",                       // ended | vanished | periodic
  "session_id": "7973860d-…",
  "project": "C--projects",                // Claude Code's coarse per-terminal grouping
  "name": "Bug Me Claude",
  "models": ["claude-opus-5"],
  "first_seen_at": "2026-08-06T04:34:19Z", // first poll that saw it, not session start
  "last_activity": "2026-08-06T04:09:22Z", // last transcript timestamp, from the watcher
  "totals":   { "context": 14, "cache_write": 44779, "cache_read": 234024,
                "thinking": 368.3, "writing": 1276.5, "tool_calls": 707.2,
                "cost_usd": 0.623672, "unpriced_output_tokens": 0 },
  "semantic": { "thinking_productive": 0, "tool_explore": 707.2, … },
  "by_project": null                       // reserved — see below
}
```

`totals` and `semantic` are passed through verbatim from `status.json`, which
is `lib/transcript.js`'s existing shape — deliberately not re-invented, so
anything that already renders a session's totals renders a history entry's
totals too.

> **Discontinuity to know about:** as of 2026-08-06 the watcher folds
> **subagent (Task) transcripts** into each session's totals — previously
> missing entirely, worth roughly **+18%**. Lines written before that change
> are cumulative totals on the old (main-transcript-only) basis; lines after
> are on the new one. Within a single session the differencing in `report.js`
> can therefore show one artificially large delta at the changeover. There's
> no `v` bump because the schema didn't change, only the upstream numbers.
> Sessions carry an `agents` array now too; the poller doesn't record it.

### ⚠ Entries are cumulative, not deltas

`totals` is the session's **lifetime** total as of `ts`. A session with three
snapshots at $2 / $5 / $9 cost **$9**, not $16. Summing lines is the obvious
wrong answer. Consumers take the latest entry per session, or difference
consecutive entries of the same session to get a per-period figure.
`report.js` is the reference implementation of the correct differencing —
use it rather than re-deriving this.

### Fitting `per-project-cost-attribution`

The sibling project adds a finer repo/cwd dimension (from the per-entry `cwd`
already in the transcript) alongside the coarse `project` field. The join
point is `by_project`, currently always `null` because `status.json` carries
no such breakdown yet.

The two dimensions compose rather than collide: **time** is one line per
snapshot, **project** is a nested object inside the line. When that project
lands a breakdown on the session object in `status.json`, it flows into
history automatically — no change to `poller.js`, no `v` bump, and no
reprocessing of already-written lines (older lines carry `null`, which is a
valid value for the field rather than a schema break). Deliberately nested
rather than extra top-level keys, so adding a third dimension later doesn't
fight over the same namespace. A per-day-per-repo rollup is then just a
group-by over `(ts` bucket`, by_project` key`)` on differenced entries.

## Retention

**Policy: for any UTC day older than 7 days, keep only the last snapshot per
session per day.** Recent days keep full detail. `compact.js` implements it;
dry run by default, `--apply` to rewrite (with a one-generation `.bak`).

Last-per-session-per-day is the specific choice that makes this lossless at
daily resolution: because entries are cumulative and `report.js` differences
consecutive ones, keeping each session's value at each day boundary leaves all
daily and coarser totals bit-for-bit correct. Only sub-day resolution on
week-old data is lost. Keeping the *first* entry of each day instead would
corrupt the differencing.

Growth without compaction is roughly one line per session end plus one per
live session-hour — on the order of tens of KB a week, so running `compact.js`
is a housekeeping nicety, not a pressing need.

## Verification

`node test-poller.js` — 41 assertions against a scratch fixture, covering the
confirm threshold, dedup, the vanished fallback, all three unreadable-file
cases, resume/re-finalize, periodic sampling, delta differencing, and
compaction-preserves-totals.

Also verified against live data, not just fixtures:

- Run against the real `status.json`, which had 3 ended and 3 live sessions:
  wrote exactly 3 `ended` entries at their real costs ($0.62 / $6.18 / $0.38),
  skipped the 3 live ones, and after **19** further confirming polls still had
  exactly 3 lines — no duplicates.
- A real live→ended transition, replayed against a captured real
  `status.json` with one live session flipped: two live polls wrote nothing,
  the first ended sighting wrote nothing (threshold), the second wrote exactly
  one entry, two further polls wrote nothing.
- `periodic` at a shortened interval against real live sessions: sampled only
  the 3 live sessions, never the finalized ones.
- The cumulative-vs-delta trap, on real data: 5 real snapshots of this suite's
  own session at a cumulative $80.98 each reported as **$80.98** total, not
  $404.91.

## Notes / limits

- Ended detection only covers `kind: "interactive"` sessions, since those are
  what Claude Code registers in `~/.claude/sessions/`. Non-interactive
  sessions fall through to the `vanished` fallback.
- `first_seen_at` is when this poller first saw the session, not when the
  session started — a session already running when the poller starts gets a
  later `first_seen_at` than its true start.
- A session that starts *and* ends entirely while the poller is down is lost.
  Only the watcher's 30-minute window is recoverable, and only for sessions
  still inside it.
