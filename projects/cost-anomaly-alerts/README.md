# cost-anomaly-alerts

Notifies you via `bug-me-claude` when a Claude Code session's cumulative cost
crosses a spending tier, instead of you finding out by checking the status bar
or running the `token-usage` skill.

## Running it

```sh
node projects/cost-anomaly-alerts/monitor.js
```

Prints its config on startup, then polls forever. Ctrl+C to stop. It needs
`token-monitor-core`'s watcher running to have anything to read, but does not
start or manage it — if `status.json` is absent the daemon idles until it
appears.

```sh
node projects/cost-anomaly-alerts/test.js   # offline; fires no notifications
```

## What it is

A standalone daemon. It:

1. Polls `packages/token-monitor-core/state/status.json` every 5s (**read-only**).
2. For each session, finds the highest configured tier its `totals.cost_usd`
   has reached.
3. If that tier is higher than the last one it notified for that session,
   shells out to `notify-done.ps1` and records the new tier.

| File | What |
|---|---|
| `monitor.js` | The daemon. Also exports its pure functions for `test.js`. |
| `config.js` | Paths, poll interval, and the tier list. |
| `test.js` | Offline checks — tier math, the dedup gate, message safety, malformed-input handling. |
| `state/notified.json` | Per-session "highest tier already notified". Created on first run. |

Nothing under `packages/` is written or `require()`d. `status.json` is read as
an opaque JSON blob at a path, the same arms-length relationship the nvim
plugin and the `token-usage` skill have with it.

## The dedup / re-notify gate

Cost is monotonic — once a session passes $10 it is above $10 forever — so a
naive `cost > threshold` check re-fires every 5s. What is persisted per session
is the **highest tier already notified**, not a boolean and not a timestamp:

```js
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}
```

Storing the tier makes the interesting cases fall out for free:

- **Sits above $10 forever** — `10 > 10` is false. One alert, then silence.
- **Later climbs past $25** — `25 > 10` is true. Exactly one more alert.
- **Jumps $8 → $60 between two ticks** — `crossedTier` returns the *highest*
  tier reached, so this is a single "$50" alert, not three stacked popups.
- **A tier is added below one already fired** — still silent, because the
  comparison is against the tier number, not the list position.

Two deliberate choices worth not "fixing" later:

- **Entries are never pruned.** A session drops off `status.json` after 30
  minutes idle but can come back. Evicting its record on disappearance would
  re-fire every alert it already sent the moment the user resumes it.
- **State lives here, not in `packages/token-monitor-core/state/`.** Writing
  there would cross the package boundary.

Deleting `state/notified.json` resets everything and re-fires alerts for every
session currently above a tier.

## Notification delivery

`fireNotification` spawns `notify-done.ps1` and never awaits it — `notify-done`
blocks *its own* process until the popup is dismissed, so awaiting it would
stall the poll loop on one unread alert. It is deliberately **not**
`detached: true`, and the message never quotes the session name; see
[`../CLAUDE.md`](../CLAUDE.md) for both traps.

## Configuration

`config.js`:

- `COST_THRESHOLDS_USD` — default `[10, 25, 50, 100]`. Must stay ascending.
  Add/remove/reorder freely; no other code changes.
- `POLL_INTERVAL_MS` — default 5000, matched to the watcher's own tick. Polling
  faster gains nothing, since `status.json` only changes that often.

## Resilience

`status.json` is written by another process that may be restarting or
mid-write. Every read goes through a `loadJson` that treats missing files,
truncated JSON, empty files, and permission errors identically: skip the tick,
try again in 5s. A malformed `sessions` object, a session with no `totals`, or
a non-numeric `cost_usd` are each skipped individually rather than killing the
loop, and any unexpected throw in `tick()` is caught and logged.

## Possible extensions

- **Rate-of-spend alerts** — "$5 in the last 10 minutes" catches a runaway loop
  early, where absolute tiers only fire once it's already expensive. Needs cost
  history, which `status.json` doesn't carry; pairs with
  `usage-history-rollups`.
- **A daily/global tier** across all sessions, not just per-session.
- **Escalating urgency** — `ask-question.ps1` instead of `notify-done.ps1` at
  the highest tier, so it actually blocks.
