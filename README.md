# claude-token-monitor (suite)

Tracks what every Claude Code session on this machine is spending — tokens,
cost, and a reading/writing/thinking/tool-call breakdown — and renders it in
the terminal status line, in Neovim, and via a skill any session can query.
Runs entirely locally, using a llama.cpp server for session naming and
classification.

## Packages

| Package | What it is |
|---|---|
| [`llama-local-server`](packages/llama-local-server/) | Starts, reuses and stops local `llama-server` (llama.cpp) instances. Depends on nothing else here; everything else is a client of it. |
| [`token-monitor-core`](packages/token-monitor-core/) | The watcher daemon: parses session transcripts and subagent sidechains, prices them, names sessions, writes `state/status.json`. |
| [`token-monitor.nvim`](packages/token-monitor.nvim/) | Neovim statusline/winbar segment. |
| [`token-usage-skill`](packages/token-usage-skill/) | A Claude Code skill for querying your own usage. |

## `projects/`

| Project | What it does |
|---|---|
| [`local-inference-skill`](projects/local-inference-skill/) | Offloads trivial subtasks to the local model instead of the Claude API |
| [`cost-anomaly-alerts`](projects/cost-anomaly-alerts/) | Notifies when a session's cost crosses a tier |
| [`ask-question-prefilter`](projects/ask-question-prefilter/) | Local-model gate in front of `bug-me-claude`'s `ask-question.ps1` |
| [`usage-history-rollups`](projects/usage-history-rollups/) | Persists per-session history, which `status.json` alone cannot answer |
| [`per-project-cost-attribution`](projects/per-project-cost-attribution/) | Attributes cost by real repo/cwd |
| [`comment-auditor`](projects/comment-auditor/) | Reports comments the repo's conventions say should not exist |

## Requirements

- Windows (PowerShell 5.1 installers, `llama-server.exe`)
- Node 18+
- A `llama.cpp` build, and `ollama pull llama3.2`

No `npm install` — there are no dependencies, no `package.json`, and no build
step anywhere in the suite.

## Install

```powershell
.\install.ps1
```

Idempotent, re-runnable, and it starts nothing. Re-run it after moving the
suite.

## Running

Nothing to start by hand. Opening a Claude Code session starts the watcher,
which starts the shared `llama-server`; closing the last session stops both.

```sh
node packages/token-monitor-core/watcher.js       # run it yourself, to see its logs
node packages/llama-local-server/managed.js       # what is running, and who owns it
node run-checks.js                                # 8 passed, 2 skipped
```

| Escape hatch | Effect |
|---|---|
| `packages/token-monitor-core/state/autostart.disabled` | Status line stops starting a watcher. Delete to resume. |
| `TOKEN_MONITOR_NO_AUTOSTART=1` | Same, via environment. |
| `TOKEN_MONITOR_IDLE_SHUTDOWN_MS=0` | Watcher never idles out. |

## Configuration

Resolved in order: environment variable → `config.local.js` (gitignored) →
discovery. On a normal setup there is nothing to set.

| Variable | Default |
|---|---|
| `LLAMA_SERVER_EXE` | Discovered from the usual `llama.cpp` build layouts, then `PATH` |
| `LLAMA_MODEL` | `llama3.2:latest` (an Ollama reference, not a path) |
| `LLAMA_MODEL_PATH` | Discovered from Ollama's manifest for `LLAMA_MODEL` |
| `LLAMA_CPP_DIR` | — |
| `LLAMA_HOST` / `LLAMA_PORT` | `127.0.0.1` / `8090` |
| `LLAMA_RUNTIME_DIR` | `~/.claude/llama-local-server` |

Per-package settings live in each package's `config.js`; see its README.

## Contributing

[`CLAUDE.md`](CLAUDE.md) holds the design, the invariants, and the traps —
read it before changing anything. Each package and `projects/` has its own.

## License

[MIT](LICENSE).
