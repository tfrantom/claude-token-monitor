# local-inference-skill

A Claude Code skill that lets Claude delegate small mechanical subtasks —
classifying text against a fixed label list, extracting one literal value, a
throwaway summary — to the local model
([`llama-local-server`](../../packages/llama-local-server/)) instead of spending
Claude API tokens on them. One project in the
[claude-token-monitor suite](../../README.md).

## Requirements

- Windows PowerShell 5.1, for the installer
- Node 18+ (uses `fetch`)
- The suite's shared chat server reachable on `127.0.0.1:8090`, or a
  `llama-server` binary and GGUF it can start one from

## Install

```powershell
.\install.ps1                      # or: .\install.ps1 -SuiteRoot <path>
```

Copies `SKILL.md` and `scripts/` into `~/.claude/skills/local-inference/`,
writes a `config.json` there with the resolved llama.cpp paths, and inserts or
updates the `<!-- local-inference-skill:start/end -->` block in
`~/.claude/CLAUDE.md`. Idempotent.

**Editing a file here does nothing until you re-run `install.ps1`** — the
installed copy is what Claude Code reads.

## Usage

Claude invokes the skill itself, following [`SKILL.md`](SKILL.md). Each script
takes one JSON object and prints plain text:

```sh
node scripts/classify.js  --in payload.json   # {"text": "...", "labels": ["a","b"]}
                                              # or {"items": [...], "labels": [...]}
node scripts/extract.js   --in payload.json   # {"text": "...", "field": "the invoice total"}
node scripts/summarize.js --in payload.json   # {"text": "...", "max_words": 40}

node selftest.js                              # exercises ./scripts/
node selftest.js --installed                  # exercises the installed copy
```

Exit 0 means a usable answer on stdout (including `unclear` / `(not found)`);
exit 1 means delegation failed and the caller should do the subtask itself.

## Configuration

`~/.claude/skills/local-inference/config.json`, written by the installer. Env
vars win over it at runtime.

| Key | Env var | Default |
|---|---|---|
| `llamaHost` | `LLAMA_HOST` | `127.0.0.1` |
| `llamaPort` | `LLAMA_PORT` | `8090` |
| `llamaServerExe` | `LLAMA_SERVER_EXE` | Discovered from the usual llama.cpp build layouts, then `PATH` |
| `llamaModelPath` | `LLAMA_MODEL_PATH` | Resolved from Ollama's manifest for `LLAMA_MODEL` (`llama3.2:latest`) |
| `suiteRoot` | — | Where it was installed from |

## Contributing

[`CLAUDE.md`](CLAUDE.md).
