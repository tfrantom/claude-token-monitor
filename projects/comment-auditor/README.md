# comment-auditor

Reports code comments that a repo's own conventions say should not exist —
restatements of the code, history notes, commented-out code, section banners —
using deterministic rules plus the shared local 3B model, entirely offline. It
reports by default and only writes when asked.

See [`CLAUDE.md`](CLAUDE.md) for how it works and what it will not do.

## Requirements

| Needs | Why |
|---|---|
| Node 18+ | `fetch`, `AbortSignal.timeout` |
| `packages/llama-local-server` on port 8090 | the classifier; `--rules-only` runs without it |
| `packages/token-monitor-core` | `status.json`, for the `--apply` safety gate |
| a git repository above the file | `--apply` refuses without one |

No install step, no dependencies. Nothing is started by hand — the shared model
server comes up with the watcher.

## Run

```sh
node audit.js <file>...                 # report; never writes
node audit.js --json <file>...          # one JSON object on stdout
node audit.js --rules-only <file>...    # deterministic pass only, no model
node audit.js --apply <file>...         # delete 'remove' findings, if quiescent
node audit.js --apply --force <file>... # apply without the quiescence check
node audit.js --lines 12,40-58 <file>   # only comments touching those lines
node test.js                            # 47 offline assertions
```

Report marks: `-` remove, `~` relocate (never deleted), `?` review.

Only rule-backed findings are ever `remove`. Anything the model labelled is
capped at `review` and is never written — see [`CLAUDE.md`](CLAUDE.md).

| Flag | Default |
|---|---|
| `--lines <a,b-c>` | whole file; scope to changed lines for far better precision |
| `--min-confidence <0..1>` | `0.75` — below this a rule removal becomes review |
| `--no-cache` | off; verdicts are cached by comment content |
| `--fail-on-findings` | off; exit 1 when anything is reported |

Exit codes: `0` ran, `1` error (or findings with `--fail-on-findings`), `3`
nothing auditable.

## Configuration

Every value has an env override.

| Variable | Default | Meaning |
|---|---|---|
| `COMMENT_AUDITOR_MAX_FILE_CHARS` | `6000` | above this the model sees a window, not the file |
| `COMMENT_AUDITOR_MIN_CONFIDENCE` | `0.75` | removal threshold |
| `COMMENT_AUDITOR_BUDGET_MS` | `12000` | total model time per audit |
| `COMMENT_AUDITOR_TIMEOUT_MS` | `20000` | per-request timeout |
| `COMMENT_AUDITOR_QUIESCENT_MS` | `45000` | how long a file must be untouched before `--apply` |
| `COMMENT_AUDITOR_AUTOAPPLY` | unset | reserved for the surfaces; the CLI still needs `--apply` |
| `COMMENT_AUDITOR_STATE_DIR` | `./state` | verdict cache |
| `COMMENT_AUDITOR_STATUS_FILE` | core's `state/status.json` | quiescence input |

## Languages

| Family | Extensions |
|---|---|
| C-like | `.js .jsx .mjs .cjs .ts .tsx .mts .cts .c .h .cc .cpp .hpp .cs .java .go .rs .swift .kt .kts .scala .php .dart .zig` |
| Lua | `.lua` |
| Hash | `.py .sh .bash .zsh .ps1 .psm1 .psd1 .rb .pl .yml .yaml .toml .tf .nix` |

Anything else is reported as unauditable rather than guessed at.
