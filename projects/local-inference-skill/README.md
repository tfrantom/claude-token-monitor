# local-inference-skill

**Status: built and installed.** This folder started life as a primer; it's
now a working package. It still lives under `projects/` rather than
`packages/`: promoting it is a **pending suite-level decision**, not an
oversight, so nothing here assumes the move will happen.

A Claude Code skill, parallel to
[`token-usage-skill`](../../packages/token-usage-skill/), that lets Claude
delegate small mechanical subtasks to the local model
([`llama-local-server`](../../packages/llama-local-server/)) instead of
spending Claude API tokens on them.

## Why

`llama-local-server` is already a standing endpoint on `localhost:8090`.
Every trivial subtask Claude does via the API instead of this is real cost —
cost that `token-monitor-core` itself will faithfully report back, which is
a little absurd once the tool to avoid it exists.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The skill definition — frontmatter + the scope rules and invocation contract Claude reads. Copied verbatim to `~/.claude/skills/local-inference/SKILL.md`. |
| `scripts/classify.js` | One label from a fixed, closed list, for one text or a batch of up to 20 items. |
| `scripts/extract.js` | One literal, explicitly-present value out of a block of text. |
| `scripts/summarize.js` | Short plain-prose gist of a block of text. |
| `scripts/lib/local-client.js` | Shared plumbing: config resolution, `ensureRunning()`/`isUp()`, `chatText()`/`chatJSON()`, input parsing, uniform failure exit. |
| `install.ps1` | Copies the above into `~/.claude/skills/local-inference/`, writes `config.json`, and idempotently maintains a marked block in `~/.claude/CLAUDE.md`. |
| `selftest.js` | Smoke test for all three scripts (plumbing, not model quality). Not installed. |

## Install / verify

```powershell
.\install.ps1                      # or: .\install.ps1 -SuiteRoot <path>
```

```sh
node selftest.js                   # exercises ./scripts/
node selftest.js --installed       # exercises ~/.claude/skills/local-inference/scripts/
```

Both currently pass, 13/13, against the live server. Same gotcha as
`token-usage-skill`: **editing a file here does nothing until you re-run
`install.ps1`** — the installed copy is what Claude Code actually reads.

## Design questions the primer left open, and how they were resolved

### Scoping what's safe to delegate

Resolved by making the tools narrow rather than by writing a long list of
caveats around a general one. Three purpose-specific scripts, each with a
rigid input shape, is itself the main safety mechanism: there's no way to
express "review this code" as a `classify.js` payload.

`SKILL.md` then adds one memorable rule — *delegate only work whose answer
you could verify at a glance if you had to* — plus explicit good/never lists.
The "never" list calls out the specific failure modes that would make the
skill counterproductive: correctness-critical work, user-facing prose,
anything needing real judgment, anything where Claude doesn't have the source
text to check against, and long input (these scripts truncate at 4–6k chars,
so an answer living in the truncated middle is silently lost).

Two smaller decisions in the same spirit:

- **`classify.js` always accepts `unclear`**, even though it isn't in the
  caller's label list. Grammar-constrained decoding *forces* a choice from
  the enum, so without an escape hatch a 3B model handed inapplicable labels
  will confidently emit one anyway. `unclear` is an exit-0 result.
- **`extract.js` returns `(not found)` rather than guessing**, and `SKILL.md`
  tells Claude to read that as "look yourself", not "it isn't there" — the
  honest characterization of a 3B model's recall.

### Invocation contract

**Several narrow scripts, not one generic "ask the local model X".** A generic
script would move all the scope-limiting into prose in `SKILL.md`, which is
exactly the thing that fails quietly. Narrow tools make the boundary
structural.

**Input is one JSON object via `--in <file.json>`, not argv text.** Two
findings drove this, both verified on this machine:

1. Splicing arbitrary text into a command line breaks on quotes, newlines,
   backticks and `$` sooner or later, in either shell.
2. Piping to stdin is *not* safe from Windows PowerShell: it re-encodes
   anything piped to a native executable through the console codepage, so
   `Résumé` arrives at Node as `RÃ©sumÃ©`. Reading the file directly with an
   explicit utf8 decode sidesteps the shell entirely and round-trips
   non-ASCII correctly (verified both directions). Stdin still works and is
   still supported — just from a POSIX shell.

**Output is plain text on stdout**, not JSON — one line, or one line per
batched item. Claude is the consumer; a JSON envelope would only add a parse
step. The structure lives in the *request* (JSON schema, `strict: true`),
where it actually buys something.

**Exit codes carry the contract:** 0 = usable answer on stdout (including
`unclear` / `(not found)`); 1 = delegation itself failed, reason on stderr.

### Fallback when the server's down

`SKILL.md` states it explicitly rather than leaving it implicit: **on exit 1,
do the subtask yourself and move on** — don't retry, don't hand-start the
server, don't report it to the user. A missing optimization isn't worth their
attention. It also warns that a transient failure right after a success is
normal on this machine, since other suite tools share the same server and one
may be restarting it.

The scripts follow the codebase's existing convention exactly (`llm-client.js`
and `semantic-classifier.js`): try/catch, return null on any fetch failure, no
retry logic. `ensureRunning()` handles the "not started yet" case; anything
past that is Claude's problem to route around, not the script's.

## Notable implementation details

- **`ensureRunning()` fails fast on a bad exe path.** An unhandled `'error'`
  event on a `ChildProcess` is a hard throw in Node, and a wrong
  `LLAMA_SERVER_EXE` is the likeliest failure on a machine that isn't this
  one. The spawn error is captured and surfaced immediately instead of eating
  the full 30s health-check timeout — which matters for one-shot CLI use in a
  way it doesn't for the long-lived watcher.
- **No `owned`/lifecycle bookkeeping.** Unlike
  `llama-local-server/server.js`, these scripts never kill the server. They're
  one-shot invocations sharing a server with long-lived clients, so whatever
  they start is deliberately left running for the next call (spawned
  `detached: true`).
- **`local-client.js` duplicates rather than requires** the connection logic
  from `packages/llama-local-server/`, for the same reason
  `token-usage-skill/scripts/lookup.js` does: the installed copy lives outside
  the suite and must survive the suite moving or breaking.
- **Config resolution order:** env vars (`LLAMA_HOST` / `LLAMA_PORT` /
  `LLAMA_SERVER_EXE` / `LLAMA_MODEL_PATH` — the same names
  `llama-local-server/config.js` honours) → `config.json` at the skill root →
  built-in defaults. The defaults keep the source-tree copy runnable without
  installing first; `config.json` is what the installed copy uses.
- **`install.ps1` reads the defaults out of the suite's own
  `llama-local-server/config.js`** by regex at install time, so `config.json`
  can't drift from what the watcher actually uses. It also warns if the
  resolved exe or GGUF isn't on disk.
- **No-BOM UTF-8 for `config.json`.** `Set-Content -Encoding utf8` on
  PowerShell 5.1 writes a BOM and Node's `JSON.parse` rejects it outright;
  `[System.IO.File]::WriteAllText` with an explicit `UTF8Encoding($false)` is
  the reliable way out. `local-client.js` strips a BOM defensively anyway.

## Left to do

- ~~**Wire into the suite installer.**~~ **Done, and better than asked for:**
  the root `install.ps1` no longer hardcodes a list of component installers —
  it globs every `packages\<x>\install.ps1` and `projects\<x>\install.ps1` and
  runs each one, passing `-SuiteRoot` where the script declares that
  parameter. This folder's installer is picked up automatically. Running it
  directly still works and is the fast path when only this skill changed.
- **Promote to `packages/`.** See the status note at the top — still a pending
  suite-level decision, not something to do unilaterally.
- **No usage measurement.** Nothing tracks how often the skill is actually
  invoked or what it saves. `token-monitor-core` sees Claude's API usage, not
  the absence of it, so proving the value would need something new — a
  counter written by these scripts would be the cheap version.
