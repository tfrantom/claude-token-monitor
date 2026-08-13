# ask-question-prefilter

A local-model gate in front of `bug-me-claude`'s `ask-question.ps1`. Before a
blocking popup + TTS interrupt fires, a ~0.2s call to the suite's
[`llama-local-server`](../../packages/llama-local-server/) judges whether the
question is worth interrupting for, and shortens an overly verbose `-Question`
before it gets spoken aloud.

**It is inert until `bug-me-claude`'s `SKILL.md` points at it** — nothing tells
Claude to call the wrapper, so sessions keep calling `ask-question.ps1`
directly. See [Turning it on](#turning-it-on).

## Files

| Path | What it is |
|---|---|
| `scripts/ask-question-prefilter.ps1` | The wrapper. Same `-Question`/`-Detail` surface as `ask-question.ps1`. |
| `scripts/stub-ask-question.ps1` | Test double for the real popup script — echoes its args, returns a canned answer on stdout. |
| `scripts/smoke-test.ps1` | Ten-case smoke test. Never shows a popup. |
| `proposed/SKILL-addendum.md` | **Not applied.** The `bug-me-claude` `SKILL.md` change that routes Claude through the wrapper. |

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
  unmodified and passes its stdout straight through, so the existing "the
  user's answer arrives as Bash stdout" contract is unchanged.
- **verdict `skip`** — no popup, no TTS. stdout is one line:
  `SUPPRESSED: <reason> (original question: <original>)`. A caller told to use
  the wrapper can tell the two apart by that prefix.

Flags: `-NoSuppress` (tighten only, never skip), `-NoTighten` (suppress only,
speak the question verbatim), `-DryRun` (print the verdict as JSON, call
nothing downstream), `-TimeoutSec` (default 8), `-AskQuestionPath` (defaults to
`~/.claude/bin/ask-question.ps1`; the seam the smoke test uses),
`-LlamaBaseUrl` (defaults to `127.0.0.1:8090`).

## Design

**A separate wrapper, not a patch to `ask-question.ps1`.** `bug-me-claude` is a
separate project with its own repo, so this consumes its public entry point
rather than reaching into it — the same relationship `token-usage-skill` has
with `token-monitor-core`. That also keeps the dependency arrow pointing the
right way: patching `ask-question.ps1` would make a standalone tool depend on
this suite's local model server being up. And it keeps the un-prefiltered path
intact and one command away if the prefilter misbehaves.

**The suppression bar is set high, and enforced three ways** rather than by
trusting the prompt alone:

- The system prompt makes `ask` the default and names `skip` as the exception,
  requiring the answer to be already stated or trivially implied by
  `-Detail`/`-Context`.
- Any verdict that isn't literally `ask` or `skip` is discarded as `ask`.
- Every failure mode fails open: server down, timeout, unparseable JSON,
  missing keys — all produce `ask` with the question unchanged, i.e. exactly
  today's behaviour.

**Tightening has a structural guard.** A proposed tightening is accepted only
if it is at least 8 characters, strictly shorter than the original, **and
contains a `?`**; otherwise the caller's wording is used. See
[`../CLAUDE.md`](../CLAUDE.md) for the failure mode that requires it.

**The model call is hand-rolled `Invoke-RestMethod`** against
`http://127.0.0.1:8090/v1/chat/completions`. It does *not* call
`llama-local-server`'s `ensureRunning()`: that's Node, and a cold start can
take 30s, which would defeat a fast pre-interrupt check. It does one 2s
`/health` probe (mirroring `isUp()`) and fails open if nothing answers.

## Verification

```powershell
powershell -File scripts\smoke-test.ps1
```

Requires the chat server up on :8090; the last case deliberately points at a
dead port. Ten cases: seven `-DryRun` judgment calls, two forwarding cases
against the stub, one fail-open case. It asserts nothing — it prints an
expectation next to each result for a human to eyeball — which is one of the
two reasons `run-checks.js` holds it back by default. Latency is ~0.15–0.25s
in-process, ~0.6s including `powershell.exe` cold start.

## Turning it on

`bug-me-claude`'s `skill\SKILL.md` needs to point at the wrapper. The exact
proposed text is in
[`proposed/SKILL-addendum.md`](proposed/SKILL-addendum.md); it covers

1. repointing the "Ask a question" command block at the wrapper,
2. handling the `SUPPRESSED:` stdout case, and `-NoSuppress` / `-NoTighten`,
3. (independently valuable) a warning about embedded double quotes.

Applying it also means re-running `bug-me-claude`'s `install.ps1`, or copying
the file to `~\.claude\commands\bug-me-claude.md`, since that's the installed
copy Claude reads. No permission change is needed: `~\.claude\settings.json`
has `permissions.defaultMode: "auto"` with no explicit allow list, and
`bug-me-claude`'s own rule `Bash(powershell.exe*ask-question*)` would match the
wrapper by substring anyway.

## Possible next steps

- **Log verdicts.** Nothing records what got suppressed. A one-line-per-call
  JSONL would make the suppression rate auditable instead of assumed.
- **Richer `-Context`.** Redundancy detection is only as good as what the
  caller passes. Wiring it to the session transcript
  (`token-monitor-core/lib/transcript.js` already parses those) would let it
  judge against real conversation history rather than a hand-written hint.
- **A bigger model for the judgment.** `ensureRunning()` takes a `modelPath`,
  so a second instance on another port is cheap to stand up if 3B judgment
  proves too coarse. There is latency headroom — 0.2s of an 8s timeout.
