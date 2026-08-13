# cost-anomaly-alerts

A standalone daemon that notifies you via `bug-me-claude` when a Claude Code
session's cumulative cost crosses a spending tier, instead of you finding out by
checking the status bar. One project in the
[claude-token-monitor suite](../../README.md).

## Requirements

- Node 18+
- The suite's watcher running and writing `state/status.json`
- `bug-me-claude`'s `notify-done.ps1` at `~/.claude/bin/`

## Running

```sh
node monitor.js     # prints its config, then polls forever; Ctrl+C to stop
node test.js        # 21 offline assertions; fires no notifications
```

Not started by any installer. If `status.json` is absent the daemon idles until
it appears; it never starts or manages the watcher.

## Configuration

`config.js`:

| Setting | Default | |
|---|---|---|
| `COST_THRESHOLDS_USD` | `[10, 25, 50, 100]` | Must stay **ascending**. Add, remove or reorder freely; no other code changes. |
| `POLL_INTERVAL_MS` | `5000` | Matched to the watcher's tick; polling faster gains nothing |
| `STATUS_FILE` | `../../packages/token-monitor-core/state/status.json` | Read only |
| `NOTIFIED_FILE` | `./state/notified.json` | Highest tier already notified, per session |
| `NOTIFY_SCRIPT` | `~/.claude/bin/notify-done.ps1` | |

Deleting `state/notified.json` re-fires alerts for every session currently above
a tier.

## Contributing

[`CLAUDE.md`](CLAUDE.md).
