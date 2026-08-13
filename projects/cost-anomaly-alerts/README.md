# cost-anomaly-alerts

Notifies you via `bug-me-claude` when a Claude Code session's cumulative cost
crosses a spending tier, instead of you finding out by checking the status bar
or running the `token-usage` skill.

**Status: built and working.** This was a primer; it's now an implementation.

## Running it

```sh
node projects/cost-anomaly-alerts/monitor.js
```

Prints its config on startup, then polls forever. Ctrl+C to stop. It needs
`token-monitor-core`'s watcher running to have anything to read, but it does
not start, manage, or depend on it in code — if `status.json` is absent the
daemon simply idles until it appears.

```sh
node projects/cost-anomaly-alerts/test.js   # offline; fires no notifications
```

## What it is

A standalone daemon — the separate-process option the original primer leaned
toward, and nothing turned up to argue against it. It:

1. Polls `packages/token-monitor-core/state/status.json` every 5s (**read-only**).
2. For each session, finds the highest configured tier its `totals.cost_usd`
   has reached.
3. If that tier is higher than the last one it notified for that session,
   shells out to `notify-done.ps1` and records the new tier.

Files:

| File | What |
|---|---|
| `monitor.js` | The daemon. Also exports its pure functions for `test.js`. |
| `config.js` | Paths, poll interval, and the tier list. |
| `test.js` | Offline checks — tier math, the dedup gate, message safety, malformed-input handling. |
| `state/notified.json` | Per-session "highest tier already notified". Created on first run. |

### Boundaries it respects

Nothing under `packages/` is written or `require()`d. `status.json` is read as
an opaque JSON blob at a path, the same arms-length relationship the nvim
plugin and the `token-usage` skill already have with it. So `watcher.js`
needed no hook point added, and none was added — no change to
`token-monitor-core` was required to build this.

## The dedup / re-notify gate

The thing that separates a useful alert from a spam generator. Cost is
monotonic — once a session passes $10 it is above $10 forever — so a naive
`cost > threshold` check re-fires every 5s, which is ~720 popups an hour.

The gate is modelled on `watcher.js`'s `shouldCheckForRename`: **a persisted
record checked every tick, not a mode.** Nothing to get stuck in and nothing
to reset; a tick that doesn't qualify just does nothing.

What's persisted per session is the **highest tier already notified**, not a
boolean and not a timestamp:

```js
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}
```

Storing the tier is what makes the interesting cases fall out for free:

- **Sits above $10 forever** — `10 > 10` is false. One alert, then silence.
- **Later climbs past $25** — `25 > 10` is true. Exactly one more alert.
- **Jumps $8 → $60 between two ticks** — `crossedTier` returns the *highest*
  tier reached, so this is a single "$50" alert, not three stacked popups for
  $10/$25/$50.
- **A tier is added below one already fired** — still silent, because the
  comparison is against the tier number, not the list position.

Two deliberate choices worth not "fixing" later:

- **Entries are never pruned.** A session drops off `status.json` after 30
  minutes idle but can come back. Evicting its record on disappearance would
  re-fire every alert it already sent the moment the user resumes it. Entries
  are a few dozen bytes; unbounded-but-tiny beats correct-until-someone-idles.
- **State lives here, not in `packages/token-monitor-core/state/`.** It's this
  project's concern, and writing there would cross the package boundary.

Deleting `state/notified.json` resets everything and re-fires alerts for every
session currently above a tier.

## Notification delivery

`fireNotification` spawns `notify-done.ps1` and never awaits it. `notify-done`
blocks *its own* process until the popup is dismissed, so awaiting it would
stall the poll loop indefinitely on one unread alert.

Two non-obvious things learned the hard way here, both load-bearing:

- **Not `detached: true`.** The first implementation used
  `{ detached: true, stdio: 'ignore' }` and the child silently failed to launch
  under some parent contexts — no popup, no error, and no entry in
  `wt-focus`'s own debug log. `unref()` alone already provides the only
  property that matters (the daemon isn't held open by a pending popup).
- **No double quotes in the message.** `powershell.exe -File` re-parses its
  arguments, and an embedded `"` silently truncates one. A session named
  `Project Setup` wrapped in quotes arrived as `Cost alert: session Project`,
  losing the cost figure entirely. `safeName()` strips `"` and backticks and
  the message never quotes the name. `test.js` covers this as a regression.

### Known environmental issue (not this project's code)

On this machine right now the `notify-done` **WinForms dialog does not
render** — the process runs, TTS speaks the message aloud, and tab focus is
restored, but no window appears and the call returns in ~5s instead of
blocking for dismissal. This reproduces with a direct invocation of
`notify-done.ps1`, independent of this daemon, so it is a `bug-me-claude` /
`wt-focus.exe` condition, not something introduced here. The audible alert
still works, which is the part that actually interrupts you. Left alone
deliberately — `bug-me-claude` is outside this project's scope.

## Configuration

`config.js`:

- `COST_THRESHOLDS_USD` — default `[10, 25, 50, 100]`. Must stay ascending.
  Add/remove/reorder freely; no other code changes.
- `POLL_INTERVAL_MS` — default 5000, matched to the watcher's own tick. Polling
  faster gains nothing, since `status.json` only changes that often.

## Resilience

`status.json` is written by another process that may be restarting or
mid-write. Every read goes through a `loadJson` that treats missing files,
truncated JSON (caught between `writeJsonAtomic`'s temp-write and rename),
empty files, and permission errors identically: skip the tick, try again in
5s. A malformed `sessions` object, a session with no `totals`, or a
non-numeric `cost_usd` are each skipped individually rather than killing the
loop, and any unexpected throw in `tick()` is caught and logged.

## How it was verified

- `test.js` — 21 offline checks, all passing.
- **Real notifications fired end-to-end**, confirmed in `wt-focus`'s own debug
  log with correct content, e.g.
  `message=[Cost alert: session Project Setup crossed $50, now at $72.77]`,
  plus the message spoken aloud.
- **Dedup verified against live data**: with `notified.json` already populated,
  the daemon ran 4+ ticks over sessions sitting well above $50 and $10 and
  fired **zero** notifications.

## Possible extensions

- **Rate-of-spend alerts** — "$5 in the last 10 minutes" catches a runaway loop
  early, where absolute tiers only fire once it's already expensive. Needs
  cost history, which `status.json` doesn't carry; pairs naturally with
  `usage-history-rollups`.
- **A daily/global tier** across all sessions, not just per-session.
- **Escalating urgency** — `ask-question.ps1` instead of `notify-done.ps1` at
  the highest tier, so it actually blocks.
