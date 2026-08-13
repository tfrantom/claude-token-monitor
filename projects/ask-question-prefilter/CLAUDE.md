# ask-question-prefilter — working notes for Claude

See [`README.md`](README.md) for what it is and how to run it. The
[projects CLAUDE.md](../CLAUDE.md) carries the rest: why this is **inert** by
design, why its smoke test is held back from `run-checks.js`, why
`stub-ask-question.ps1` exists, and why the tightening guard is load-bearing.

## A separate wrapper, not a patch to `ask-question.ps1`

`bug-me-claude` is a separate project with its own repo, so this consumes its
public entry point rather than reaching into it — the same relationship
`token-usage-skill` has with `token-monitor-core`. It also keeps the dependency
arrow pointing the right way: patching `ask-question.ps1` would make a
standalone tool depend on this suite's local model server being up. And it
leaves the un-prefiltered path intact and one command away if the prefilter
misbehaves.

`-AskQuestionPath` defaults to the *installed* copy at
`~/.claude/bin/ask-question.ps1` — what `SKILL.md` tells Claude to call — rather
than a `bug-me-claude` checkout, so this works wherever that source tree lives.
It is also the seam the smoke test uses.

## The suppression bar is high, and enforced three ways

Not by trusting the prompt alone:

- The system prompt makes `ask` the default and names `skip` as the exception,
  requiring the answer to be already stated or trivially implied by `-Detail` /
  `-Context`.
- Any verdict that is not literally `ask` or `skip` is discarded as `ask`.
- **Every failure mode fails open**: server down, timeout, unparseable JSON,
  missing keys all produce `ask` with the question unchanged, i.e. exactly
  today's behaviour.

`Get-JsonVerdict` takes the outermost `{...}` substring, so a model that wraps
its JSON in commentary or code fences despite instructions is tolerated.

## Tightening has a structural guard

A proposed tightening is accepted only if it is **≥8 characters, strictly
shorter, and contains a `?`**. Without the `?` test the 3B model turns a
question into a statement asserting an answer the user never gave, which TTS
then speaks at them — see [`../CLAUDE.md`](../CLAUDE.md) "Measured". In every
rejected case the caller's own wording is the safer thing to speak.

## The model call is hand-rolled

`Invoke-RestMethod` against `http://127.0.0.1:8090/v1/chat/completions`. It
deliberately does **not** call `llama-local-server`'s `ensureRunning()`: that is
Node, and a cold start can take ~30s, which would defeat a fast pre-interrupt
check. It does one 2s `/health` probe (mirroring `isUp()`) and fails open if
nothing answers. No retry loop.

Measured latency: ~0.15–0.25s in-process, ~0.6s including `powershell.exe` cold
start, against an 8s timeout.

## Quote handling

`powershell.exe -File` silently truncates an argument at an embedded `"` — see
[`../CLAUDE.md`](../CLAUDE.md). That bites this script's own caller exactly as it
bites direct callers of `ask-question.ps1`, and nothing here can fix that end.
What `ConvertTo-SafeArg` guards is the hazard this script would otherwise
*introduce*: the model-generated tightened question and reason are scrubbed of
`"` (replaced with `'`, which reads identically once TTS speaks it) and
flattened of newlines before being forwarded on.

## Turning it on

`bug-me-claude`'s `skill\SKILL.md` needs to point at the wrapper. The exact
proposed text is in
[`proposed/SKILL-addendum.md`](proposed/SKILL-addendum.md); it covers

1. repointing the "Ask a question" command block at the wrapper,
2. handling the `SUPPRESSED:` stdout case, and `-NoSuppress` / `-NoTighten`,
3. (independently valuable) a warning about embedded double quotes.

Applying it also means re-running `bug-me-claude`'s `install.ps1`, or copying the
file to `~\.claude\commands\bug-me-claude.md`, since that is the installed copy
Claude reads. No permission change is needed: `~\.claude\settings.json` has
`permissions.defaultMode: "auto"` with no explicit allow list, and
`bug-me-claude`'s own rule `Bash(powershell.exe*ask-question*)` would match the
wrapper by substring anyway.

## Possible next steps

- **Log verdicts.** Nothing records what got suppressed. A one-line-per-call
  JSONL would make the suppression rate auditable instead of assumed.
- **Richer `-Context`.** Redundancy detection is only as good as what the caller
  passes. Wiring it to the session transcript
  (`token-monitor-core/lib/transcript.js` already parses those) would let it
  judge against real conversation history rather than a hand-written hint.
- **A bigger model for the judgment.** `ensureRunning()` takes a `modelPath`, so
  a second instance on another port is cheap to stand up if 3B judgment proves
  too coarse. There is latency headroom.
