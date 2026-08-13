# Extension projects

Extensions to the [claude-token-monitor suite](../README.md). Each folder
started as a primer — a self-contained brief for whoever (human, background
agent, or fresh session) picks it up. **All five are now built**, and every
folder's `README.md` has been rewritten by its implementer to describe what
actually exists rather than what was planned. There are no unstarted primers left here.

| Project | One-line pitch | Status (2026-08-06) |
|---|---|---|
| [`local-inference-skill`](local-inference-skill/) | Let Claude Code offload trivial subtasks to the local model instead of spending Claude API tokens on them | **built + installed** as the `local-inference` skill; selftest 13/13 |
| [`cost-anomaly-alerts`](cost-anomaly-alerts/) | Push notification via bug-me-claude when a session's cost crosses a threshold | **built + verified**; 21 offline checks, real notifications fired end-to-end |
| [`ask-question-prefilter`](ask-question-prefilter/) | Local-model pass before bug-me-claude's `ask-question.ps1` fires an interrupt | **built + verified** (10-case smoke test); **inert** until `bug-me-claude`'s `SKILL.md` points at it — see its `proposed/` |
| [`usage-history-rollups`](usage-history-rollups/) | Persist cost/usage history — `status.json` only ever shows "right now" | **built + verified**; 41 assertions plus live-data runs. `poller.js` is a daemon you have to actually start |
| [`per-project-cost-attribution`](per-project-cost-attribution/) | Attribute cost by actual repo/directory, not just Claude Code's coarse per-terminal grouping | **built + verified**; 25 checks reconciling against `token-monitor-core`'s own parser |

> **Note on layout:** these are finished packages still living under
> `projects/`. Promoting them to `packages/` (and updating the suite README's
> package table) is a **pending decision, not an oversight** — each
> implementer correctly declined to move itself, since that's an edit outside
> its own folder. Describe things where they are now.

Two of these have already fed changes back into `packages/`:
`per-project-cost-attribution` found that the watcher was missing subagent
transcripts (~18% of spend), and `local-inference-skill` (with two projects
that have since moved to their own repositories) forced the
`llama-local-server` multi-instance API and the spawn-error fix. Both are
landed upstream now.

## Picking one up

Read the project's `README.md` in full before touching its code — each one
documents decisions that were *measured*, including several that failed, and
re-deriving them is the expensive mistake. Update the README itself as you
learn things: correct it in place rather than leaving it stale, the same
convention the rest of the suite uses.

Each folder still carries its own open items ("Left to do", "Possible next
steps", "Escalations") — that's where the remaining work is, not in the
status column above.

## Shared infrastructure notes

- **`llama-local-server` supports multiple instances.**
  `ensureRunning({port, modelPath, extraArgs, contextSize, detached, ...})` —
  every option defaults to the shared chat instance on 8090, so
  `ensureRunning()` with no args is unchanged. Use it rather than copying the
  spawn logic. It also fails fast (~0.5s, clean message) on a bad exe path now
  instead of hard-crashing on an unhandled `'error'` event.
- **Ports** are claimed declaratively in
  [`packages/llama-local-server/ports.js`](../packages/llama-local-server/ports.js).
  Add a claim there and read it back with `portFor(name)`; do not hardcode a
  number in your own config. Two claims on one port throw on require, which
  beats the previous arrangement — three projects each picked a port by
  eyeballing `netstat` and hoping, and one nearly took a port already in use.

  | Port | Owner | Model / mode |
  |---|---|---|
  | 8090 | `packages/llama-local-server` (shared) | `llama3.2` 3B, chat |
  | 8099 | **reserved** — a process outside this suite was found squatting here | — |

  A dedicated instance is spawned `detached: true` and stays resident until an
  explicit kill, so expect more than one `llama-server.exe` on a busy machine.
  Kill by PID/port, never by image name.
- **`status.json` sessions carry `ended: true`** once the owning Claude Code
  process is gone (verified against the PID registry, not guessed from
  mtime). Ended sessions linger for the rest of the active window on purpose
  so pollers can catch the live→ended transition. Require it across **two**
  consecutive polls: if `~/.claude/sessions/` is briefly unreadable, every
  session reads as ended at once.
- **`status.json` session totals now include subagent (Task) spend**, folded
  in from `<project>/<session-id>/subagents/agent-*.jsonl`. Anything that
  cached or compared totals from before 2026-08-06 will see a step change of
  roughly +18%. Each session also carries an `agents` array — *running* agents
  only, in UI order, always present even when empty.
- **Only one `watcher.js` may run at a time.** It takes a PID-file lock at
  `packages/token-monitor-core/state/watcher.lock`. If you restart the watcher
  while testing, kill the old one rather than starting a second — three were
  once found racing, and the stale ones were writing old-format data that read
  as the new code being broken.
