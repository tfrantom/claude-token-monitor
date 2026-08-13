# Extension projects

Extensions to the [claude-token-monitor suite](../README.md), one folder per
idea. Each has its own `README.md` covering how to run and configure it.

| Project | What it does |
|---|---|
| [`local-inference-skill`](local-inference-skill/) | A Claude Code skill that offloads trivial subtasks to the local model instead of spending Claude API tokens on them |
| [`cost-anomaly-alerts`](cost-anomaly-alerts/) | Notifies via `bug-me-claude` when a session's cost crosses a spending tier |
| [`ask-question-prefilter`](ask-question-prefilter/) | A local-model gate in front of `bug-me-claude`'s `ask-question.ps1` |
| [`usage-history-rollups`](usage-history-rollups/) | Persists cost/usage history, which `status.json` alone cannot answer |
| [`per-project-cost-attribution`](per-project-cost-attribution/) | Attributes cost by real repo/directory rather than Claude Code's coarse per-terminal grouping |

`local-inference-skill` and `ask-question-prefilter` are installed or wired by
`install.ps1`; `cost-anomaly-alerts` and `usage-history-rollups` are daemons
you start yourself. See each project's README.

## Shared infrastructure

- **`llama-local-server` supports multiple instances.**
  `ensureRunning({port, modelPath, extraArgs, contextSize, detached, ...})` —
  every option defaults to the shared chat instance on 8090, so
  `ensureRunning()` with no args is unchanged. Use it rather than copying the
  spawn logic.
- **Ports** are claimed declaratively in
  [`packages/llama-local-server/ports.js`](../packages/llama-local-server/ports.js).
  Add a claim there and read it back with `portFor(name)`; do not hardcode a
  number in your own config. Two claims on one port throw on require.

  | Port | Owner | Model / mode |
  |---|---|---|
  | 8090 | `packages/llama-local-server` (shared) | `llama3.2` 3B, chat |
  | 8099 | **reserved** — a process outside this suite was found squatting here | — |

  A dedicated instance is spawned `detached: true` and stays resident until an
  explicit kill, so expect more than one `llama-server.exe` on a busy machine.
  Kill by PID/port, never by image name.

- **Consuming `status.json`** — read it by path, never write it, and see
  [`CLAUDE.md`](CLAUDE.md) for the rules that matter (the two-poll `ended`
  confirmation, subagent spend in session totals, the `agents` array, and the
  one-watcher-at-a-time invariant).
