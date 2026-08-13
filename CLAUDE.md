# claude-token-monitor — working notes for Claude

Read [`README.md`](README.md) first for what the suite is. This file is the
short list of things that will bite you, in rough order of how expensive the
mistake is.

## Before you commit

```sh
node run-checks.js
```

Green means 6 passed, 2 skipped. Both skips are on purpose:
`ask-question-prefilter` drives a blocking desktop popup, and
`token-monitor-core-lifecycle` takes over the shared port 8090 and loads a
model onto the GPU, which would disturb any other Claude Code session on the
machine. Run that one deliberately when you touch the start/stop chain:

```sh
node run-checks.js --only lifecycle --include-unsafe
```

A failure in
`per-project-cost-attribution` is usually not a bug in that project: it
reconciles its own transcript parser against `token-monitor-core`'s over every
real transcript on disk, so it is the first thing to go red when you change
either one. That is the check doing its job.

## Nothing is started by hand

```
status line render ──▶ watcher ──▶ shared llama-server (:8090)
```

Each link owns exactly the thing below it, and the chain runs in reverse on the
way down: no live Claude Code session for `IDLE_SHUTDOWN_MS` and the watcher
exits, stopping the server it owns.

The status line is the entry point because Claude Code guarantees to invoke it
on every render of every session. That makes it the suite's liveness signal —
and it also makes it the one place where cost is a hard constraint. It runs
~10x/second *per open session*: the already-running path must stay two
syscalls, and it must never touch llama.cpp itself. A process that lives 100ms
has no business spawning a model server; that is the watcher's job.

Do not "just add" work to `statusline.js`.

## Only one watcher, and only one shared server

`watcher.js` is a singleton over shared state. Every instance rewrites the same
`status.json` on the same 5s cadence, so a second one does not split the work —
it races, and a stale instance running older code silently clobbers a newer
one's output with plausible-looking wrong data. This happened for real (three
at once, from three different Claude Code sessions). The PID-file lock at
`state/watcher.lock` only stops the second start; it cannot fix a wrong number
you already trusted.

The shared llama-server has the same rule with a bigger bill attached — each
instance is a resident copy of the model on the GPU. Two sessions opened in the
same second both see nothing on 8090 and both spawn, so the spawn is serialised
behind a lock in `llama-local-server/managed.js` and the loser waits for the
winner rather than failing to bind.

**Ownership of that server is on disk, not in a variable.** `ensureRunning()`'s
`owned` flag is per-process and cannot express "live as long as some session
needs it": a watcher that *reused* a server started by a one-shot skill call
has `owned === false` and used to leave the model resident forever. The record
at `~/.claude/llama-local-server/chat-shared.json` is what fixes that, and it
is also why a new watcher can adopt a server orphaned by a hard kill. Two rules
follow:

- **No record means no kill.** A `llama-server` started by hand is reused and
  left alone.
- **Anything in this suite that spawns the shared instance must write the
  record**, including the copies that cannot `require` across the repo
  boundary (`local-inference-skill`'s client). A spawn that skips it is a leak.

If you need to restart the watcher, kill the old one first. Never start a
second to "test something."

## An external kill on Windows is always abrupt

Node on Windows never *receives* a SIGTERM from another process:
`process.kill()` maps to `TerminateProcess`, and `taskkill` without `/F` posts
`WM_CLOSE`, which a console process with no window ignores. So the watcher's
`SIGINT`/`SIGTERM` handlers only ever run for Ctrl+C in its own console.

Do not write cleanup that depends on an external stop being graceful. Anything
that must survive an abrupt exit has to be recoverable from disk on the next
start — which is exactly what the ownership record above is for.

## Cost is computed in two places — keep them in step

`costForTurn()` in `packages/token-monitor-core/lib/pricing.js` has **two**
callers:

1. `finalizeTurn()` in `packages/token-monitor-core/lib/transcript.js`
2. `totalsForTurn()` in `projects/per-project-cost-attribution/lib/attribute.js`

Both must pass the same inputs. `speed` and `at_ms` are load-bearing, not
optional: omitting `speed` under-reports a fast-mode turn by exactly half, and
omitting `at_ms` skips dated rate windows (like Sonnet 5's introductory
pricing) entirely. Add an input to one call site and you must add it to the
other, or `verify.js` will fail the reconciliation.

Two things the rate card deliberately does **not** model — do not "fix" them:

- **No long-context premium.** A 1M context window is standard-priced, so
  `claude-opus-5[1m]` costs the same as `claude-opus-5`. The bare `/opus-5/`
  match already handles it.
- **No batch discount.** Claude Code never uses the Batch API.

When you change pricing, verify against the `claude-api` skill rather than
memory — rates and intro windows move.

## PowerShell 5.1 encoding, every single time

Writing any file that another tool parses:

```powershell
# Right
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))

# Wrong — prepends a UTF-8 BOM
Set-Content -Path $path -Value $content -Encoding utf8
```

A BOM in `settings.json` or a skill's `config.json` makes the JSON parser
reject the file outright; a BOM in `~/.claude/CLAUDE.md` is quieter but
persists, because the next run reads it back and writes it out again. Both
skill installers shipped this bug while carrying a comment 46 lines above
that correctly warned against it.

Reading is the mirror image: `Get-Content -Raw -Encoding UTF8` is mandatory,
because 5.1 otherwise decodes a BOM-less UTF-8 file as the system codepage and
silently turns every em-dash into mojibake — which then gets faithfully
written back.

## Installed skills are copies

Editing `packages/token-usage-skill/SKILL.md` does nothing. Claude Code reads
`~/.claude/skills/token-usage/`, which is a copy made by that package's
`install.ps1`. Re-run the installer (or the suite one) after any skill edit.

## No package.json, no build step, no node_modules

Deliberate, and it is what keeps each package under `packages/` extractable
into its own repo with minimal surgery. Plain relative `require()`s within a
package; never reach across a package boundary except through the one
dependency that package explicitly declares in the README's table. Standard
library only — `run-checks.js` is a hand-rolled runner for exactly this reason.

If you are about to add a dependency, that is a suite-level architectural
change: raise it rather than doing it.

## Every component owns its own installer

`install.ps1` at the root is a pure discovery driver — it globs
`packages/*/install.ps1` and `projects/*/install.ps1` and runs each. There are
no special cases in it. A new component with an installer is picked up with no
edit to the root script. The convention:

- idempotent (the whole thing is re-run whenever the suite moves)
- optionally takes `-SuiteRoot`; it is passed when the parameter exists
- self-skip rather than fail when the integration target is absent (see
  `token-monitor.nvim` on a machine with no Neovim)

## Machine-specific values are resolved, not hardcoded

There used to be four absolute paths from one machine baked into source —
a llama.cpp build path in three configs, and three bare sha256 Ollama blob
digests. `packages/llama-local-server/config.js` now resolves both kinds:
the binary by searching the usual build layouts and `PATH`, the model by
reading Ollama's manifest for a human reference (`llama3.2:latest`) and
following it to the blob.

Use `resolveOllamaModel(ref)` rather than pasting a digest, and prefer an
env var or `config.local.js` (gitignored) over editing source. When a
resolver comes up empty it returns `null`, and the *spawn* reports it — never
`require` time, because `ports.js` loads that config just to read a port
number and must not explode on a machine with no llama.cpp.

## `state/` is generated and gitignored

Every `state/` directory holds machine-specific runtime data, some of it a
verbatim record of what the user was working on — session names, per-session
costs, working directories, LLM verdicts on their thinking blocks. It is
regenerated from scratch on first run. Never commit it, never read it in a
test.

Tests write fixtures to `fs.mkdtempSync()` and clean up. Nothing in
`run-checks.js` may read or write the live `status.json` — the watcher owns it
and is actively rewriting it. `renderLine()` takes a test-only status override
for exactly this reason.

## Ports are hand-claimed

There is no allocator. Add a claim to
[`packages/llama-local-server/ports.js`](packages/llama-local-server/ports.js)
and read the port back with `portFor(name)` rather than hardcoding a number;
two claims on one port throw on require instead of failing at spawn.

| Port | Owner | Model / mode |
|---|---|---|
| 8090 | `packages/llama-local-server` (shared) | `llama3.2` 3B, chat |

One claim today, and the registry still earns its keep: separate tools on the
same machine hold neighbouring ports, so `suggestPort()` probes TCP before
suggesting and `assertAvailable()` names an occupant rather than letting a
spawn fail to bind.

Expect **more than one** `llama-server.exe` at a time. Kill by PID or port,
**never** by image name — you will take out a server another session or
another repo is using.

## Conventions

- Comments explain *why*, especially when the code looks wrong but isn't. The
  measured dead ends in this codebase are documented on purpose; deleting one
  costs the next person the measurement. If you disprove one, replace it with
  what you measured — don't just remove it.
- Correct a README in place as you learn things rather than leaving it stale.
- Prefer measuring to guessing. Transcript parsing was nearly "optimized" with
  an mtime cache before anyone timed it: it is 8ms per tick against the active
  set, on a 5-second loop.
