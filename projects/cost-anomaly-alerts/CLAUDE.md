# cost-anomaly-alerts — working notes for Claude

See [`README.md`](README.md) for what it is and how to run it, and the
[projects CLAUDE.md](../CLAUDE.md) for the `status.json` and PowerShell rules
this project depends on.

## What it does, per tick

1. Reads `packages/token-monitor-core/state/status.json` by path, **read-only**.
2. For each session, finds the highest configured tier its `totals.cost_usd`
   has reached.
3. If that tier is higher than the last one notified for that session, spawns
   `notify-done.ps1` and records the new tier.

Nothing under `packages/` is written or `require()`d — `status.json` is an
opaque JSON blob at a path, the same arms-length relationship the nvim plugin
and the `token-usage` skill have with it.

## The dedup / re-notify gate

Cost is monotonic: once a session passes $10 it is above $10 forever, so a naive
`cost > threshold` check re-fires every tick. What is persisted per session is
the **highest tier already notified** — not a boolean, not a timestamp:

```js
function shouldNotify(tier, notifiedEntry) {
  const prevTier = notifiedEntry ? notifiedEntry.tier : 0;
  return tier > prevTier;
}
```

Storing the tier makes the interesting cases fall out for free:

- **Sits above $10 forever** — `10 > 10` is false. One alert, then silence.
- **Later climbs past $25** — `25 > 10` is true. Exactly one more alert.
- **Jumps $8 → $60 between two ticks** — `crossedTier()` returns the *highest*
  tier reached, so this is a single "$50" alert, not three stacked popups.
- **A tier is added below one already fired** — still silent, because the
  comparison is against the tier number, not the list position.

`crossedTier()` relies on `COST_THRESHOLDS_USD` being **ascending**; it breaks
out of the loop at the first threshold not yet reached.

Two deliberate choices worth not "fixing" later:

- **Entries are never pruned.** A session drops off `status.json` after 30
  minutes idle but can come back. Evicting its record on disappearance would
  re-fire every alert it already sent the moment the user resumes it.
- **State lives here, not in `packages/token-monitor-core/state/`.** Writing
  there would cross the package boundary.

Deleting `state/notified.json` resets everything and re-fires alerts for every
session currently above a tier.

## Notification delivery

`fireNotification()` spawns `notify-done.ps1` and never awaits it —
`notify-done` blocks *its own* process until the popup is dismissed, so awaiting
it would stall the poll loop on one unread alert. `unref()` alone gives the only
property that matters.

Two traps, both already worked around, both covered in
[`../CLAUDE.md`](../CLAUDE.md):

- It must **not** be `detached: true`. That was the first implementation and the
  child silently failed to launch under some parent contexts — no popup, no
  error, nothing in `wt-focus`'s own debug log.
- The message must never quote the session name. Names are LLM-generated and
  land in a `powershell.exe -File ... -Message <text>` argument, where an
  embedded `"` truncates the rest of the value with no error. `safeName()`
  strips `"` and backticks rather than escaping them, and the message text never
  wraps the name in quotes either. `test.js` covers it as a regression.

Neither guard can protect this project's own *caller* — that damage happens
before the script starts.

## Resilience

`status.json` is written by another process that may be restarting or
mid-write. Every read goes through `loadJson()`, which treats a missing file,
truncated JSON, an empty file, and a permission error identically: skip the
tick, try again next poll. A malformed `sessions` object, a session with no
`totals`, or a non-numeric `cost_usd` are each skipped individually rather than
killing the loop, and any unexpected throw in `tick()` is caught and logged.

## Testing

`node test.js` — 21 offline assertions. It `require()`s `monitor.js` as a
module, which does not start the poll loop and never calls
`fireNotification()`, so nothing in the test can reach `notify-done.ps1`. Its
only side effect outside a temp dir is `mkdir`ing this project's own `state/`.

## Possible extensions

- **Rate-of-spend alerts** — "$5 in the last 10 minutes" catches a runaway loop
  early, where absolute tiers only fire once it is already expensive. Needs cost
  history, which `status.json` does not carry; pairs with
  `usage-history-rollups`.
- **A daily/global tier** across all sessions, not just per-session.
- **Escalating urgency** — `ask-question.ps1` instead of `notify-done.ps1` at
  the highest tier, so it actually blocks.
