# local-inference-skill — working notes for Claude

See [`README.md`](README.md) for what it is and how to install it,
[`SKILL.md`](SKILL.md) for the scope rules Claude reads at runtime, and the
[projects CLAUDE.md](../CLAUDE.md) for the shared traps (installed copies, the
PowerShell stdin re-encoding, `llama-local-server` ownership records).

## Editing files here does nothing until you reinstall

Claude Code reads `~/.claude/skills/local-inference/`, which is a **copy** made
by `install.ps1`. Re-run it after any edit. Newly installed skills also only
appear in the available-skills listing at the *next* session start.

## Three narrow scripts, not one generic "ask the local model X"

A rigid input shape per purpose is itself the main safety mechanism: there is no
way to express "review this code" as a `classify.js` payload. A generic script
would move all the scope-limiting into prose in `SKILL.md`, which is the thing
that fails quietly.

- **Input is one JSON object via `--in <file.json>`**, not argv text and not
  stdin from PowerShell — see [`../CLAUDE.md`](../CLAUDE.md). Quotes, newlines,
  backticks and `$` survive a file where they would not survive being spliced
  into a command line. Stdin still works from a POSIX shell.
- **Output is plain text on stdout**, one line, or one line per batched item.
  Claude is the consumer; a JSON envelope would only add a parse step. The
  structure lives in the *request* (JSON schema, `strict: true`).
- **Exit codes carry the contract:** 0 = usable answer on stdout (including
  `unclear` / `(not found)`); 1 = delegation itself failed, reason on stderr. On
  exit 1 `SKILL.md` tells Claude to do the subtask itself and move on — no
  retry, no hand-starting the server, no reporting it to the user. A transient
  failure right after a success is normal, since other suite tools share that
  server.

Two smaller decisions in the same spirit:

- **`classify.js` always accepts `unclear`**, even though it is not in the
  caller's label list. Grammar-constrained decoding *forces* a choice from the
  enum, so without an escape hatch a 3B model handed inapplicable labels will
  confidently emit one anyway. `unclear` is an exit-0 result.
- **`extract.js` returns `(not found)` rather than guessing**, and `SKILL.md`
  tells Claude to read that as "look yourself", not "it isn't there".

`chatJSON()` uses `response_format: json_schema` with `strict: true`. Decoding is
grammar-constrained, so an `enum` in the schema is a hard guarantee about the
output rather than a request the 3B model may ignore.

## `local-client.js` duplicates rather than requires

`install.ps1` copies it wholesale into
`~/.claude/skills/local-inference/scripts/lib/`, so the installed copy has no
relative path home and must keep working if the suite moves or is mid-edit. The
connection, discovery and spawn logic is therefore a **deliberate duplicate** of
`packages/llama-local-server/{config,server}.js`, kept in step by intent rather
than by import — the same rule `token-usage-skill/scripts/lookup.js` follows.

Do not add a `require('../../../packages/...')`. It will work in the repo and
break the moment it is installed.

## The ownership record path must match exactly

`RECORD_FILE` is `~/.claude/llama-local-server/chat-shared.json` — the same path
`llama-local-server/managed.js` writes. It is the only thing that lets the
watcher find a server this skill started and stop it when the last session
closes. Get the path wrong, or skip `recordSpawn()`, and a one-shot skill call
leaks a resident model until reboot. See the
[suite CLAUDE.md](../../CLAUDE.md) "Only one watcher, and only one shared
server".

These scripts never kill the server themselves — they are one-shot invocations
sharing it with long-lived clients, so there is no `owned`/lifecycle bookkeeping
here. Writing the record is what hands the lifetime to the watcher.
`recordSpawn()` is called only once the server is actually serving: recording a
pid that never came up would point the watcher's shutdown at a dead process. It
is best-effort — failing the user's subtask over a bookkeeping write would be
worse than the leak it risks.

## `ensureRunning()` fails fast on a bad exe path

An unhandled `'error'` event on a `ChildProcess` is a hard throw in Node, and a
wrong `LLAMA_SERVER_EXE` is the likeliest failure on a machine that is not this
one. The spawn error is captured and checked inside the poll loop, so a bad path
bails immediately instead of eating the full 30s health-check timeout. That
matters for one-shot CLI use in a way it does not for the long-lived watcher,
and `selftest.js` asserts the fail-fast (<10s) explicitly.

`findServerExe()` returns the bare exe name when nothing is found, so the
spawn's `'error'` event names it rather than failing at require time.

## Configuration resolution

Env vars (`LLAMA_HOST` / `LLAMA_PORT` / `LLAMA_SERVER_EXE` / `LLAMA_MODEL_PATH`
— the same names `llama-local-server/config.js` honours) → `config.json` at the
skill root → built-in discovery. The defaults keep the source-tree copy runnable
without installing first; `config.json` is what the installed copy uses.

`install.ps1` **runs** `llama-local-server/config.js` and asks what it resolved
to, rather than parsing it — those values are resolvers now, not string
literals, and running the file is the only way to get the answer the watcher
will get. It writes an **empty** value rather than a wrong one when the resolved
exe or GGUF is not on disk, because `local-client.js` does its own discovery
when a value is absent and a known-bad path is worse than none.

Both files `install.ps1` writes (`config.json` and `~/.claude/CLAUDE.md`) go out
UTF-8 **without** a BOM, and `~/.claude/CLAUDE.md` is read back with
`-Encoding UTF8`. See [`../CLAUDE.md`](../CLAUDE.md) "PowerShell 5.1 traps". A
BOM in `~/.claude/CLAUDE.md` is round-tripped by the next run's read, so it never
cleans itself up.

The `CLAUDE.md` block is delimited by `<!-- local-inference-skill:start -->` /
`:end` and rewritten in place. Keep both markers intact.

## Testing

`node selftest.js` (or `--installed` for the copy under `~/.claude/skills/`) —
~10 real completions against the 3B model, so it needs the chat server up.
Assertions are loose enough that a 3B model passes reliably: a failure means
broken plumbing, not an off day.

## Possible next steps

- **Promote to `packages/`** — a pending suite-level decision, see
  [`../CLAUDE.md`](../CLAUDE.md).
- **Usage measurement.** Nothing tracks how often the skill is invoked or what
  it saves; `token-monitor-core` sees Claude's API usage, not the absence of it.
  A counter written by these scripts would be the cheap version.
