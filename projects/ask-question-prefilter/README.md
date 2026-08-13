# ask-question-prefilter

**Status: built and verified.** This was a primer; it's now a description of what exists.

A local-model gate in front of `bug-me-claude`'s `ask-question.ps1`. Before a blocking
popup + TTS interrupt fires, a ~0.2s call to the suite's
[`llama-local-server`](../../packages/llama-local-server/) judges whether the question is
actually worth interrupting for, and shortens an overly verbose `-Question` before it gets
spoken aloud.

## Why

Interrupts from `ask-question.ps1` are expensive in a real sense — blocking, audible, they
pull focus away from whatever else is on screen. A cheap local check can catch the cases
where the answer is already sitting in the `-Detail` text, and can stop a three-clause
question from being read aloud verbatim by TTS.

## Files

| Path | What it is |
|---|---|
| `scripts/ask-question-prefilter.ps1` | The thing. Drop-in wrapper with the same `-Question`/`-Detail` surface as `ask-question.ps1`. |
| `scripts/stub-ask-question.ps1` | Test double for the real popup script — echoes its args, returns a canned answer on stdout. |
| `scripts/smoke-test.ps1` | Ten-case smoke test. Never shows a popup. |
| `proposed/SKILL-addendum.md` | **Not applied.** The `bug-me-claude` `SKILL.md` change that would actually route Claude through the wrapper. Needs someone with authority over that project. |

## Usage

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "C:\projects\claude-token-monitor\projects\ask-question-prefilter\scripts\ask-question-prefilter.ps1" \
  -Question "Brief spoken question" \
  -Detail "Longer popup text" \
  -Context "Anything already decided that might make this redundant"
```

Two outcomes on stdout:

- **verdict `ask`** (the common case) — calls the real `ask-question.ps1` unmodified and
  passes its stdout straight through. The existing "user's answer arrives as Bash stdout"
  contract is identical to calling `ask-question.ps1` directly.
- **verdict `skip`** — no popup, no TTS. stdout is one line: `SUPPRESSED: <reason>
  (original question: <original>)`. A caller that was told to use the wrapper can tell the
  two apart by that prefix.

Flags: `-NoSuppress` (tighten only, never skip), `-NoTighten` (suppress only, speak the
question verbatim), `-DryRun` (print the verdict as JSON, call nothing downstream),
`-TimeoutSec` (default 8), `-AskQuestionPath` (defaults to `~/.claude/bin/ask-question.ps1`;
the seam the smoke test uses), `-LlamaBaseUrl` (defaults to `127.0.0.1:8090`).

## Which design option got built, and why

The primer laid out two options. **Option 2 — separate wrapper script, `ask-question.ps1`
untouched — is what got built.** Reasons, in order of weight:

1. **Scope.** `bug-me-claude` is a separate project with its own git repo, outside this
   suite. Option 1 means editing a file in it. Option 2 means a script that lives entirely
   here and calls the other project's public entry point. That's the same relationship
   `token-usage-skill` has with `token-monitor-core` — consume the other thing's interface,
   don't reach into it.
2. **The dependency would point the wrong way.** Option 1 makes `bug-me-claude` depend on
   this suite's local model server being up. `bug-me-claude` is a standalone tool whose
   README lists its prerequisites as Windows Terminal and .NET; "also, a llama.cpp server on
   :8090" is a bad thing to add to that list. Option 2 keeps the arrow pointing from this
   suite at `bug-me-claude`, matching the suite README's dependency rule.
3. **Failure isolation.** With option 1, a bug in the prefilter is a bug in everyone's
   interrupt path with no way around it. With option 2 the un-prefiltered path stays intact
   and is one command away.
4. **Option 1's "fewer moving parts" edge is smaller than it looks.** Option 1 avoids
   needing the `SKILL.md` change — but it needs an edit to `ask-question.ps1` (a
   cross-project edit) *plus* a `SKILL.md` note anyway, because a suppressed question
   returns something other than the user's answer on stdout and Claude has to know that.
   Both options need the doc change; only option 1 also needs the code change.

The cost of option 2 is that it's inert until `SKILL.md` points at it — see
[`proposed/SKILL-addendum.md`](proposed/SKILL-addendum.md) and the escalation note below.

## Resolved design questions

**Suppression bar.** Set high, as the primer demanded, and enforced three ways rather than
trusting the prompt alone:

- The system prompt makes `ask` the default and names `skip` as the exception, requiring the
  answer to be *already stated or trivially implied* by `-Detail`/`-Context`.
- Any verdict that isn't literally `ask` or `skip` is discarded and treated as `ask`.
- Every failure mode fails open: server down, timeout, unparseable JSON, missing keys — all
  produce `ask` with the question unchanged, i.e. exactly today's behavior.

Measured on eight realistic questions (see Verification), it skipped one — the one where
`-Detail` literally contained the answer. It even chose `ask` on a case designed to be
skippable ("which port?" with `-Context` saying "always use port 4000"), which is the
conservative direction to err in.

**Ship tightening alone first?** No — both shipped, because the suppression side turned out
to be cheap to make safe (fail-open plus a strict verdict whitelist) and because
`-NoSuppress` gives anyone who disagrees a one-flag downgrade to tightening-only. The
primer's caution was right about the *risk ordering*, not about needing to split the
release.

**Tightening needed a structural guard.** Not anticipated by the primer; found during
verification. Given "Should I use tabs or spaces?" with a `-Detail` implying tabs, the 3B
model returns `"Use tabs consistently."` — shorter, but it has silently converted a question
into a statement *asserting an answer the user never gave*. TTS would then speak a directive
at the user. A proposed tightening is now accepted only if it is at least 8 characters,
strictly shorter than the original, **and contains a `?`**. That one check eliminates the
whole class. Rejected tightenings fall back to the caller's wording.

**Where the model call lives.** Hand-rolled `Invoke-RestMethod` against
`http://127.0.0.1:8090/v1/chat/completions` — the primer correctly noted there was no
PowerShell example in the suite to copy. It does *not* call `llama-local-server`'s
`ensureRunning()`: that's Node, and a cold start can take up to 30s, which would defeat the
point of a fast pre-interrupt check. Instead it does one 2s `/health` probe (mirroring
`isUp()`) and gives up immediately if the server isn't already there. Transient failures
while another session restarts the server are therefore just a fail-open, which is the
correct behavior anyway.

## Verification

Run it: `powershell -File scripts\smoke-test.ps1` (requires the chat server up on :8090;
the last case deliberately points at a dead port).

Ten cases, all behaving as intended as of the last run:

| Case | Result |
|---|---|
| Redundant (`-Detail` states the answer) | `skip` |
| Genuine judgment call | `ask` |
| Verbose question, real decision | `ask`, tightened to `"Delete old backup directory now?"` |
| `-Context` carries the answer | `ask` — conservative miss, acceptable |
| `-NoSuppress` on the redundant case | `ask` |
| `-NoTighten` on the verbose case | question passed through verbatim |
| Embedded `"` in question and detail | survives intact, nothing truncated |
| ASK path via `-AskQuestionPath` stub | forwards both args, stdout passes through |
| SKIP path via stub | `SUPPRESSED:` line only, stub never invoked |
| Dead port (`:59999`) | `model_reachable=false`, `ask`, question unchanged |

Plus an eight-question calibration sweep (1 skip out of 8, and it was the right one) and
latency: **~0.15–0.25s** in-process, **~0.6s** including `powershell.exe` cold start. Cheap
enough to be free relative to a blocking human interrupt.

### Two environment gotchas that shaped the verification

**The `wt-focus.exe` popup is not currently rendering on this machine.** The process runs,
TTS speaks, tab focus is restored — but no window appears and the call returns in ~5s
instead of blocking until dismissed. Two other agents confirmed this reproduces on a direct
invocation of `notify-done.ps1`, independent of any caller, so it is a `bug-me-claude` issue
and out of scope here. It does mean the real popup **cannot be used as a test oracle right
now** — hence `scripts/stub-ask-question.ps1` and `-AskQuestionPath`. The forwarding path is
verified against the stub; whether the popup itself renders is orthogonal to, and unaffected
by, anything in this project.

**`powershell.exe -File` silently truncates an argument at an embedded `"`.** Confirmed the
hard way by another agent. The wrapper can't fix that for its own callers (the damage
happens before the script runs), but it does prevent itself from *introducing* the problem:
anything the model generates and the script forwards onward — the tightened question, the
suppression reason — has `"` replaced with `'` and newlines flattened. An LLM's habit of
quoting things can't silently truncate a question the caller passed in cleanly. The hazard
for callers is documented in the proposed `SKILL.md` addendum, and is worth fixing there
whether or not the prefilter is adopted.

## Needs escalation (cross-project, deliberately not done here)

**`bug-me-claude`'s `skill\SKILL.md` needs updating for any of this to take effect.** The
wrapper works, but nothing tells Claude to call it — sessions will keep calling
`ask-question.ps1` directly. The exact proposed text is in
[`proposed/SKILL-addendum.md`](proposed/SKILL-addendum.md). It needs:

1. The "Ask a question" command block repointed at the wrapper.
2. A note on handling the `SUPPRESSED:` stdout case, and on `-NoSuppress` / `-NoTighten`.
3. (Independently valuable) a warning about embedded double quotes.

Applying it also means re-running `bug-me-claude`'s `install.ps1`, or copying the file to
`~\.claude\commands\bug-me-claude.md`, since that's the installed copy Claude reads.

No permission change is needed: `~\.claude\settings.json` currently has
`permissions.defaultMode: "auto"` with no explicit allow list. (For reference, if an
explicit allow list is ever reintroduced, `bug-me-claude`'s installer rule
`Bash(powershell.exe*ask-question*)` already matches `ask-question-prefilter.ps1` by
substring.)

## Possible next steps

- **Log verdicts.** Nothing records what got suppressed. A one-line-per-call JSONL alongside
  `packages/token-monitor-core/state/` would make the suppression rate auditable instead of
  assumed, and would turn the eight-question calibration sweep into real data.
- **Richer `-Context`.** Redundancy detection is only as good as what the caller passes.
  Wiring it to the session transcript (`token-monitor-core/lib/transcript.js` already parses
  those) would let it judge against actual conversation history rather than a hand-written
  hint.
- **A bigger model for the judgment.** `ensureRunning()` now takes a `modelPath`, so a
  second instance on another port serving `mistral` or `deepseek-r1:8b` is cheap to stand up
  if 3B judgment ever proves too coarse. There's latency headroom — 0.2s of an 8s timeout.
