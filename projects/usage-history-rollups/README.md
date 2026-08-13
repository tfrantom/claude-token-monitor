# usage-history-rollups

Persists token/cost history beyond the live snapshot. `status.json` is
overwritten every watcher tick with only currently-active sessions, so once a
session ages out of the 30-minute window its data is gone; this appends
per-session snapshots to `state/history.jsonl` so "how much this week" is
answerable, not just "right now". One project in the
[claude-token-monitor suite](../../README.md).

## Requirements

- Node 18+
- The suite's watcher running and writing `state/status.json`

## Running

```sh
node poller.js                       # the daemon: snapshots status.json into history.jsonl
node report.js                       # read it back: last 7 days, daily buckets
node report.js --days 30
node report.js --by session          # per-session totals instead of per-day
node report.js --json
node compact.js                      # retention: show what would be dropped
node compact.js --keep-days 30 --apply
node test-poller.js                  # 41 offline assertions
```

`poller.js` is a standalone long-running process, separate from the watcher and
not started by any installer. Starting it late, restarting it, or running it
while the watcher is down are all fine — it just records less.

## Configuration

`config.js`; every value is env-overridable.

| Setting | Env var | Default |
|---|---|---|
| `STATUS_FILE` | `ROLLUP_STATUS_FILE` | `../../packages/token-monitor-core/state/status.json` |
| `STATE_DIR` | `ROLLUP_STATE_DIR` | `./state` |
| `POLL_INTERVAL_MS` | `ROLLUP_POLL_INTERVAL_MS` | `60000` |
| `ENDED_CONFIRM_POLLS` | `ROLLUP_ENDED_CONFIRM_POLLS` | `2` |
| `PERIODIC_SNAPSHOT_MS` | `ROLLUP_PERIODIC_SNAPSHOT_MS` | `3600000` |
| `SCHEMA_VERSION` | — | `1` |

`HISTORY_FILE` and `LAST_SEEN_FILE` derive from `STATE_DIR`.

## Contributing

[`CLAUDE.md`](CLAUDE.md) — the snapshot triggers, the history schema, and the
fact that **entries are cumulative, not deltas**. Read that before consuming
`history.jsonl`.
