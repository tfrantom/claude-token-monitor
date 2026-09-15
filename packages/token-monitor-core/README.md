# token-monitor-core

The watcher daemon and everything it directly needs: transcript parsing,
pricing, session naming, the semantic classification layer, and the terminal
status line. The watcher polls Claude Code's session transcripts, classifies and
prices every API turn, and writes `state/status.json`; everything else in the
[claude-token-monitor suite](../../README.md) — the status line, the nvim
plugin, the `token-usage` skill — is a reader of that one file.

## Requirements

- Windows (PowerShell 5.1 installer)
- Node 18+
- [`llama-local-server`](../llama-local-server/), the only cross-package
  dependency

No `npm install`; there are no dependencies and no build step.

## Install

```powershell
.\install.ps1
```

Wires the status line into `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node <suite-root>/packages/token-monitor-core/statusline.js", "refreshInterval": 2 }
```

Idempotent, and it starts nothing. Re-run it after moving the suite.

## Running

Nothing needs to be started by hand. Opening a Claude Code session renders the
status line, which starts the watcher, which starts the shared `llama-server`;
the chain tears itself down again once no session is live.

```sh
node watcher.js                      # run it in the foreground, to see its logs
node test.js                         # 38 offline checks; no network, no watcher, no state/
node test-lifecycle.js --take-over   # end-to-end start/stop chain; takes over port 8090
```

## Configuration

All of it is in `config.js`.

| Setting | Default | Meaning |
|---|---|---|
| `ACTIVE_SESSION_WINDOW_MS` | 30 min | How recently a transcript must have been written to count as active. |
| `POLL_INTERVAL_MS` | 5000 | Watcher tick. |
| `STATUS_MAX_AGE_MS` | 60 s | How old `status.json` may be before consumers report the watcher state instead of its sessions. |
| `IDLE_SHUTDOWN_MS` | 2 min | Time with no live session before the watcher exits and stops the servers it manages. `0` disables idle shutdown. |
| `AGENT_ACTIVE_WINDOW_MS` | 90 s | How long a subagent transcript may go unwritten before that agent counts as finished. |
| `SEMANTIC_CLASSIFICATION_ENABLED` | `true` | `false` makes no LLM calls, reads/writes no cache, and omits the `semantic` key from `status.json` entirely. |
| `SEMANTIC_TIME_BUDGET_MS` | 8000 | Per-tick ceiling on classification backfill. |
| `SEMANTIC_RETRY_MS` | 60 s | How long a failed classification stays "don't retry yet". |
| `RENAME_MIN_INTERVAL_MS` | 15 s | Rate-limit floor between naming calls for one session. |
| `RENAME_MIN_NEW_CHARS` | 20 | Minimum new user text before a rename round trip is worth making. |
| `RENAME_RECENT_MESSAGES` | 3 | Size of the rolling window sent to the namer. |
| `STATUSLINE_TRACE` | `false` | Log render cadence and `status.json` staleness to `state/statusline-trace.jsonl`. |

Environment overrides, all read at require time:

| Variable | Effect |
|---|---|
| `TOKEN_MONITOR_STATE_DIR` | Relocates `state/`. Required by any test that touches lock, cache or status files. |
| `CLAUDE_PROJECTS_DIR` | Where transcripts are read from. |
| `CLAUDE_SESSIONS_DIR` | Claude Code's live-session registry. |
| `TOKEN_MONITOR_IDLE_SHUTDOWN_MS` | Overrides `IDLE_SHUTDOWN_MS`. |
| `TOKEN_MONITOR_NO_AUTOSTART=1` | The status line will not start a watcher. |

`state/autostart.disabled` is an out-of-process pause button with the same
effect as `TOKEN_MONITOR_NO_AUTOSTART`, for when there is nowhere to set an env
var (Claude Code spawns the status line itself).

## Contributing

[`CLAUDE.md`](CLAUDE.md) has the `status.json` output contract, the invariants,
the known limitations, and the traps — read it before changing anything.
