# claude-token-monitor (suite)

Started as one script that watched Claude Code's token usage. Turned out the
piece that made it work — a persistent local LLM server — is more generally
useful than the thing it was built for, so this is now a small suite of
loosely-coupled packages instead of one monolith. Each package under
`packages/` is scoped tightly enough that it could be extracted into its own
repo later with minimal surgery (no shared `node_modules`, no build step, no
package.json anywhere — plain relative `require()`s within a package, never
reaching across a package boundary except through the one other package it
explicitly depends on).

## Packages

| Package | What it is | Depends on |
|---|---|---|
| [`llama-local-server`](packages/llama-local-server/) | Spawns/reuses `llama-server.exe` (llama.cpp), a thin OpenAI-compatible endpoint pointed at a GGUF already on disk. Defaults to `localhost:8090`; `ensureRunning({port, modelPath, …})` stands up additional instances for consumers needing a different model or mode. The actual reusable infra — everything else is a client of this. | nothing else in the suite |
| [`token-monitor-core`](packages/token-monitor-core/) | The watcher daemon: tails every active Claude Code session's transcript **plus its subagent sidechains**, classifies tokens, prices it, auto-renames sessions, writes `state/status.json`. Singleton — refuses to start if another watcher holds the lock. | `llama-local-server` |
| [`token-monitor.nvim`](packages/token-monitor.nvim/) | lazy.nvim plugin — reads `status.json`, renders it as a statusline/winbar segment. | reads `token-monitor-core`'s output file; no code dependency |
| [`token-usage-skill`](packages/token-usage-skill/) | A Claude Code skill (installed into `~/.claude/skills/token-usage/`) so any Claude Code session can look up its own usage. Self-contained once installed — the installed copy has no dependency on this repo staying put. | reads `token-monitor-core`'s output file at a hardcoded path; no code dependency |

Dependency direction only ever points at `llama-local-server` — nothing
depends on `token-monitor-core` except the two things that read its output
file by path (not by `require`), which is exactly what makes those two
extractable on their own.

## `projects/`

Extensions to the suite — one folder per idea. These started as primers
written for whoever (human or agent) picked them up next; **all five are now
built**, and each folder's `README.md` has been rewritten by its implementer
to describe what actually exists.

| Project | What it does |
|---|---|
| [`local-inference-skill`](projects/local-inference-skill/) | Claude Code skill (`local-inference`, installed) for offloading trivial subtasks to the local model |
| [`cost-anomaly-alerts`](projects/cost-anomaly-alerts/) | Daemon that notifies via `bug-me-claude` when a session's cost crosses a tier |
| [`ask-question-prefilter`](projects/ask-question-prefilter/) | Local-model gate in front of `bug-me-claude`'s `ask-question.ps1` — inert until that project's `SKILL.md` points at it |
| [`usage-history-rollups`](projects/usage-history-rollups/) | Persists per-session snapshots to `history.jsonl`, since `status.json` only ever shows "right now" |
| [`per-project-cost-attribution`](projects/per-project-cost-attribution/) | Attributes cost by real repo/cwd instead of Claude Code's coarse per-terminal grouping |

They are finished packages that still live under `projects/`; promoting any of
them to `packages/` is a pending decision, not an oversight. See
[`projects/README.md`](projects/README.md) for status detail and the shared
infrastructure notes (port claims, `status.json` contract).

## Getting it running on a fresh machine

Windows-only today (PowerShell 5.1 installers, `llama-server.exe`), Node 18+,
no `npm install` — there are no dependencies to install.

1. **Build or locate llama.cpp, and pull a model.**

   ```powershell
   ollama pull llama3.2
   ```

   Both the binary and the GGUF are *resolved* rather than configured. The
   binary is looked for in the usual llama.cpp build layouts (a sibling
   `llama.cpp` checkout, `~/llama.cpp`, `C:\llama.cpp`, then `PATH`), and the
   model by reading Ollama's manifest for `llama3.2:latest` — so on a normal
   setup there is nothing to configure. Override any of it without editing
   source:

   ```powershell
   $env:LLAMA_SERVER_EXE = "C:\path\to\llama-server.exe"
   $env:LLAMA_MODEL      = "mistral:latest"     # any model you have pulled
   $env:LLAMA_MODEL_PATH = "C:\path\to\model.gguf"   # or a bare GGUF
   $env:LLAMA_CPP_DIR    = "D:\src\llama.cpp"
   ```

   `packages/llama-local-server/config.local.js` (gitignored) does the same
   thing persistently. If nothing resolves, the failure names the path it
   tried and what to do about it.

2. **Wire the integrations** — idempotent, re-runnable, and it writes config
   only (it never starts a process):

   ```powershell
   .\install.ps1
   ```

3. **Open a Claude Code session.** That is the whole of step 3 — see below.

4. **Check your work**:

   ```sh
   node run-checks.js
   ```

   Green is 6 passed, 2 skipped. Both skips are deliberate — see
   `projects/ask-question-prefilter` and the lifecycle test's registry entry.

## Running it

Nothing to start by hand. Opening a Claude Code session brings the suite up,
and closing the last one takes it back down:

```
status line render  ──▶  watcher  ──▶  shared llama-server (:8090)
  (every render)          (daemon)       (~2.5 GB resident)

no live sessions for 2 min  ──▶  watcher exits  ──▶  every managed server stopped
```

Each link owns exactly the thing below it. The status line is the entry point
because Claude Code guarantees to invoke it — on every render of every session
— which makes it a free liveness signal. On the happy path that check is two
syscalls; it only spawns when the lock file names no live process.

The watcher **re-checks the server on every tick**, not just at startup, so
killing `llama-server` (task manager, a crash, an OOM) is repaired within one
poll interval. That is worth stating because the failure it replaced was
invisible: the watcher kept polling against a dead backend, `status.json` kept
updating, the status line kept rendering, and only session naming and semantic
classification quietly stopped working.

It is also the machine's **reaper**. Any tool can register a llama-server it
started — see `managed.ensureManaged()` — and instances marked `idle` are
stopped once they go unused past their TTL. The shared chat instance is marked
`supervised` instead: never idle-reaped, because it exists to be warm, and it
goes away with the watcher. Since the records live in a machine-level runtime
directory rather than in this repo, the watcher reaps instances started by
installed skill copies and by separate repositories too:

```sh
node packages/llama-local-server/managed.js            # what is running, and who owns it
node packages/llama-local-server/managed.js --reap     # stop anything idle past its TTL
node packages/llama-local-server/managed.js --stop-all # stop everything this suite started
```

- **Start it yourself** (to watch its logs) with `node packages/token-monitor-core/watcher.js`.
- **Pause autostart** by creating `packages/token-monitor-core/state/autostart.disabled`,
  or setting `TOKEN_MONITOR_NO_AUTOSTART=1`. Delete the file to resume.
- **Never idle out** by setting `TOKEN_MONITOR_IDLE_SHUTDOWN_MS=0`.

State lives in `packages/token-monitor-core/state/` — `status.json` (current
snapshot, overwritten every tick), `names-cache.json`, `semantic-cache.json`,
`watcher.lock`.

**Only one watcher may run at a time.** It's a singleton over shared state:
every instance rewrites the same `status.json` on the same cadence, so a
second one doesn't split the work, it races — and a stale instance running
older code silently clobbers a newer one's output with plausible-looking
wrong data. This happened for real (three at once, from three different Claude
Code sessions), so the watcher takes a PID-file lock and refuses to start if a
live one already holds it.

**Only one shared llama-server may run**, for the same reason plus a much
more expensive one: each is a resident copy of the model on the GPU. Two
processes racing to spawn it is a real case — two sessions opened in the same
second both see nothing on 8090 — so the spawn is serialised behind a lock and
the loser waits for the winner's server instead of failing to bind.

Because the instance outlives whichever short-lived process started it,
ownership is recorded on disk (`~/.claude/llama-local-server/chat-shared.json`)
rather than held in a variable. That record is what lets the watcher stop a
server a one-shot skill invocation started, and what lets a *new* watcher adopt
one orphaned by a hard kill. **No record means no kill** — a `llama-server` you
started by hand on 8090 is reused and left alone.

Note there may be **more than one** `llama-server.exe` running: 8090 is the
shared chat instance, and anything else built on `llama-local-server` may hold
a port of its own. Kill by PID or port, never by image name.

Several other daemons are optional companions rather than part of the watcher:
`projects/usage-history-rollups/poller.js` and
`projects/cost-anomaly-alerts/monitor.js` each run as their own process and
only read `status.json` by path.

## Live wiring

None of these are inside this repo — they're external config pointing in:

- `~/.claude/settings.json` → `statusLine.command` → `packages/token-monitor-core/statusline.js`
- `~/AppData/Local/nvim/lua/plugins/claude-token-monitor.lua` → `dir=` → `packages/token-monitor.nvim/`
- `~/.claude/skills/token-usage/` → installed copy, refreshed by `packages/token-usage-skill/install.ps1`
- `~/.claude/skills/local-inference/` → installed copy, refreshed by `projects/local-inference-skill/install.ps1`
- `~/.claude/CLAUDE.md` → marked blocks pointing future sessions at both skills

If you move or rename a package, all of these need updating too. Re-run
`install.ps1` after moving anything.

**Every integration is owned by the component it belongs to.** The root
`install.ps1` is a pure discovery driver with no special cases: it globs
`packages/<x>/install.ps1` and `projects/<x>/install.ps1` and runs each in
turn, so a new component with an installer is picked up without editing it.
The status line and the Neovim spec used to be written inline by the root
script and are now ordinary components like the two skills — which means each
package can also be installed on its own:

```powershell
.\packages\token-monitor-core\install.ps1     # just the Claude Code status line
.\packages\token-monitor.nvim\install.ps1     # just the Neovim plugin spec
```

That is the point of the layout — every package under `packages/` should be
extractable into its own repo with minimal surgery, and an installer that only
works when invoked from the suite root would undercut that.

A component installer must be idempotent, may take `-SuiteRoot` (it is passed
when the parameter exists), and should self-skip rather than fail when its
integration target is absent — `token-monitor.nvim` returns early on a machine
with no Neovim config, which is a skip, not a broken install.

An installed skill's source file is *not* what Claude Code reads — editing
`SKILL.md` or a script here does nothing until the relevant `install.ps1` runs
again. See [`CLAUDE.md`](CLAUDE.md) for the full gotcha list (PowerShell
encoding traps, the singleton watcher, the two pricing call sites).

## Tests

```sh
node run-checks.js            # everything safe to run unattended
node run-checks.js --list     # the registry and its safety notes, run nothing
```

A registry rather than a glob, on purpose: whether a script is offline logic,
needs a live model server, or is one flag away from firing a blocking desktop
popup is not derivable from its filename. The runner audits for unregistered
check-shaped files afterwards and fails if it finds one, so the registry
cannot quietly go stale.

`per-project-cost-attribution/verify.js` is the load-bearing one — it
reconciles its own transcript parser against `token-monitor-core`'s over every
real transcript on disk. It is the first thing to go red when either parser
changes, which is exactly what it is for.

## What is not in the repo

`state/` directories are gitignored. They are generated, and they contain a
verbatim record of real sessions — names, costs, working directories, and
LLM-judged verdicts on your own thinking blocks. Everything regenerates on
first run.

## License

[MIT](LICENSE).
