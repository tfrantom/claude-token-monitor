# ask-question-prefilter

A local-model gate in front of `bug-me-claude`'s `ask-question.ps1`. Before a
blocking popup and TTS interrupt fires, a ~0.2s call to the suite's
[`llama-local-server`](../../packages/llama-local-server/) judges whether the
question is worth interrupting for, and shortens an overly verbose `-Question`
before it gets spoken aloud. One project in the
[claude-token-monitor suite](../../README.md).

**It is inert until `bug-me-claude`'s `SKILL.md` points at it** — see
[`CLAUDE.md`](CLAUDE.md) "Turning it on" and
[`proposed/SKILL-addendum.md`](proposed/SKILL-addendum.md).

## Requirements

- Windows PowerShell 5.1
- The suite's shared chat server up on `127.0.0.1:8090`
- `bug-me-claude`'s `ask-question.ps1` at `~/.claude/bin/`

## Usage

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "C:\projects\claude-token-monitor\projects\ask-question-prefilter\scripts\ask-question-prefilter.ps1" \
  -Question "Brief spoken question" \
  -Detail "Longer popup text" \
  -Context "Anything already decided that might make this redundant"
```

Two outcomes on stdout:

- **verdict `ask`** (the common case) — calls the real `ask-question.ps1`
  unmodified and passes its stdout straight through, so the existing "the user's
  answer arrives as Bash stdout" contract is unchanged.
- **verdict `skip`** — no popup, no TTS. stdout is one line:
  `SUPPRESSED: <reason> (original question: <original>)`.

| Flag | Default | Effect |
|---|---|---|
| `-NoSuppress` | off | Tighten only, never skip |
| `-NoTighten` | off | Suppress only; speak the question verbatim |
| `-DryRun` | off | Print the verdict as JSON, call nothing downstream |
| `-TimeoutSec` | `8` | Budget for the chat completion |
| `-AskQuestionPath` | `~/.claude/bin/ask-question.ps1` | The real popup script |
| `-LlamaBaseUrl` | `http://127.0.0.1:8090` | Local chat server |

## Verification

```powershell
powershell -File scripts\smoke-test.ps1
```

Ten cases; never shows a popup. Requires the chat server on :8090 — the last
case deliberately points at a dead port. It asserts nothing and exits 0
regardless, which is why `run-checks.js` holds it back by default; run it
deliberately, watching it.

## Contributing

[`CLAUDE.md`](CLAUDE.md).
