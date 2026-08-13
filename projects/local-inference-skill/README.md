# local-inference-skill

A Claude Code skill, parallel to
[`token-usage-skill`](../../packages/token-usage-skill/), that lets Claude
delegate small mechanical subtasks to the local model
([`llama-local-server`](../../packages/llama-local-server/)) instead of
spending Claude API tokens on them.

`llama-local-server` is already a standing endpoint on `localhost:8090`, so
every trivial subtask done via the API instead is real cost — cost that
`token-monitor-core` will faithfully report back.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The skill definition — frontmatter plus the scope rules and invocation contract Claude reads. Copied verbatim to `~/.claude/skills/local-inference/SKILL.md`. |
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

**Editing a file here does nothing until you re-run `install.ps1`** — the
installed copy is what Claude Code actually reads.

## The invocation contract

**Three narrow scripts, not one generic "ask the local model X".** A rigid
input shape per purpose is itself the main safety mechanism: there is no way to
express "review this code" as a `classify.js` payload. A generic script would
move all the scope-limiting into prose in `SKILL.md`, which is the thing that
fails quietly.

**Input is one JSON object via `--in <file.json>`**, not argv text and not
stdin from PowerShell — see [`../CLAUDE.md`](../CLAUDE.md) for why. Stdin still
works from a POSIX shell.

**Output is plain text on stdout**, one line, or one line per batched item.
Claude is the consumer; a JSON envelope would only add a parse step. The
structure lives in the *request* (JSON schema, `strict: true`).

**Exit codes carry the contract:** 0 = usable answer on stdout (including
`unclear` / `(not found)`); 1 = delegation itself failed, reason on stderr. On
exit 1 `SKILL.md` tells Claude to do the subtask itself and move on — no retry,
no hand-starting the server, no reporting it to the user. A transient failure
right after a success is normal, since other suite tools share that server.

Two smaller decisions in the same spirit:

- **`classify.js` always accepts `unclear`**, even though it isn't in the
  caller's label list. Grammar-constrained decoding *forces* a choice from the
  enum, so without an escape hatch a 3B model handed inapplicable labels will
  confidently emit one anyway. `unclear` is an exit-0 result.
- **`extract.js` returns `(not found)` rather than guessing**, and `SKILL.md`
  tells Claude to read that as "look yourself", not "it isn't there".

## Configuration

Resolution order: env vars (`LLAMA_HOST` / `LLAMA_PORT` / `LLAMA_SERVER_EXE` /
`LLAMA_MODEL_PATH` — the same names `llama-local-server/config.js` honours) →
`config.json` at the skill root → built-in discovery. The defaults keep the
source-tree copy runnable without installing first; `config.json` is what the
installed copy uses.

`install.ps1` asks the suite's own `llama-local-server/config.js` what it
resolved to, rather than parsing it, so `config.json` can't drift from what the
watcher uses. It warns if the resolved exe or GGUF isn't on disk, and writes
nothing rather than a known-bad path.

## Notable implementation details

- **`local-client.js` duplicates rather than requires** the connection logic
  from `packages/llama-local-server/`, for the same reason
  `token-usage-skill/scripts/lookup.js` does: the installed copy lives outside
  the suite and must survive the suite moving or breaking.
- **No `owned`/lifecycle bookkeeping.** These scripts never kill the server —
  they are one-shot invocations sharing it with long-lived clients. They do
  write the ownership record, which is what hands the lifetime to the watcher;
  skipping it leaks a resident model.
- **`ensureRunning()` fails fast on a bad exe path** rather than eating the
  full 30s health-check timeout, which matters for one-shot CLI use in a way it
  doesn't for the long-lived watcher.

## Possible next steps

- **Promote to `packages/`** — a pending suite-level decision.
- **Usage measurement.** Nothing tracks how often the skill is invoked or what
  it saves; `token-monitor-core` sees Claude's API usage, not the absence of
  it. A counter written by these scripts would be the cheap version.
