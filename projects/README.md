# Extension projects

Extensions to the [claude-token-monitor suite](../README.md), one folder per
idea. Each has its own `README.md` for how to run and configure it, and its own
`CLAUDE.md` for how it works.

| Project | What it does |
|---|---|
| [`local-inference-skill`](local-inference-skill/) | A Claude Code skill that offloads trivial subtasks to the local model instead of spending Claude API tokens on them |
| [`cost-anomaly-alerts`](cost-anomaly-alerts/) | Notifies via `bug-me-claude` when a session's cost crosses a spending tier |
| [`ask-question-prefilter`](ask-question-prefilter/) | A local-model gate in front of `bug-me-claude`'s `ask-question.ps1` |
| [`usage-history-rollups`](usage-history-rollups/) | Persists cost/usage history, which `status.json` alone cannot answer |
| [`per-project-cost-attribution`](per-project-cost-attribution/) | Attributes cost by real repo/directory rather than Claude Code's coarse per-terminal grouping |
| [`comment-auditor`](comment-auditor/) | Reports code comments that the repo's conventions say should not exist, using rules plus the local model |

`local-inference-skill` and `ask-question-prefilter` are installed or wired by
`install.ps1`; `cost-anomaly-alerts` and `usage-history-rollups` are daemons you
start yourself.

## Shared infrastructure

- **`status.json`** — read it by path, never write it. The rules that matter are
  in [`CLAUDE.md`](CLAUDE.md).
- **`llama-local-server`** — use
  `ensureRunning({ port, modelPath, extraArgs, contextSize, detached, ... })`
  rather than copying the spawn logic. Every option defaults to the shared chat
  instance on 8090.
- **Ports** are claimed declaratively in
  [`packages/llama-local-server/ports.js`](../packages/llama-local-server/ports.js).
  Add a claim there and read it back with `portFor(name)`; do not hardcode a
  number in your own config.

  | Port | Owner | Model / mode |
  |---|---|---|
  | 8090 | `packages/llama-local-server` (shared) | `llama3.2` 3B, chat |
  | 8099 | **reserved** — a process outside this suite was found squatting here | — |

  Kill `llama-server.exe` by PID or port, never by image name.
