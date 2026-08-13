<#
.SYNOPSIS
  Local-model gate in front of bug-me-claude's ask-question.ps1.

.DESCRIPTION
  Judges (via the suite's local llama-server, see ../../../packages/llama-local-server)
  whether a blocking interrupt is actually worth firing, and optionally tightens an
  overly verbose $Question before it gets spoken aloud by wt-focus.exe's TTS.

  Design choice (see ../README.md "Which design option got built" for the full writeup):
  this script is a drop-in wrapper, NOT a modification of ask-question.ps1. It calls the
  real, unmodified ask-question.ps1 when the verdict is "ask" and passes its stdout straight
  through unchanged -- so the existing "answer comes back as Bash stdout" contract holds
  exactly as before for the common case. Only the "skip" case is new behavior: no popup is
  shown, and a SUPPRESSED: sentinel is written to stdout instead, so a Claude session that
  has been instructed to call this script instead of ask-question.ps1 directly can tell the
  two outcomes apart.

  Fails open by design: any problem talking to the local model (server not running, timeout,
  malformed response) results in verdict=ask with the question/detail unchanged -- i.e.
  behaves exactly like calling ask-question.ps1 directly. No retry loop; a single fast
  /health probe plus a single chat-completions call, same try/catch-and-move-on style as
  packages/llama-local-server/server.js's isUp().

.PARAMETER Question
  Same meaning as ask-question.ps1's -Question: one sentence, gets spoken aloud via TTS.

.PARAMETER Detail
  Same meaning as ask-question.ps1's -Detail: longer text shown in the popup body.

.PARAMETER Context
  Optional. Anything already known/decided that the local model should weigh when judging
  redundancy -- e.g. a short excerpt of relevant recent conversation. Empty by default;
  without it the model can only judge redundancy against Question/Detail's own content
  (e.g. Detail already stating the answer), not against anything Claude alone knows.

.PARAMETER NoSuppress
  Disable the suppression judgment entirely -- the local model is still consulted for
  question-tightening only, but verdict is always treated as "ask". Use this to adopt only
  the lower-risk tightening feature per the open design question in the project README.

.PARAMETER NoTighten
  Disable question-tightening -- Question is passed to ask-question.ps1 verbatim even when
  the model proposes a shorter phrasing. Suppression judgment still applies unless -NoSuppress
  is also set.

.PARAMETER DryRun
  Don't call ask-question.ps1 (no popup, no TTS) and don't suppress anything for real --
  just print the model's verdict/reason/tightened question as JSON to stdout. For testing
  the filter itself.

.PARAMETER TimeoutSec
  Budget for the local model chat completion. Default 8s. On timeout, fails open per the
  DESCRIPTION above.

.PARAMETER LlamaBaseUrl
  Base URL of the local llama-server. Defaults to the suite's shared chat instance
  (packages/llama-local-server/config.js -> 127.0.0.1:8090). Overridable so the smoke test
  can point at a dead port to verify the fail-open path.

.PARAMETER AskQuestionPath
  Path to the real ask-question.ps1. Defaults to the installed copy at
  ~/.claude/bin/ask-question.ps1 (what SKILL.md actually tells Claude to call today), not
  this repo's bug-me-claude checkout -- keeps this script working the same way regardless
  of where the bug-me-claude source tree happens to live. Also the seam the smoke test
  uses to exercise the "ask" path against a stub instead of a real popup.

.NOTES
  Embedded double quotes: `powershell.exe -File` re-parses its arguments and SILENTLY
  TRUNCATES a value at an embedded `"`. That bites the *caller* of this script (Claude
  invoking `powershell.exe -File ask-question-prefilter.ps1 -Question "...\"...\""`) exactly
  as it already bites direct callers of ask-question.ps1 -- nothing this script can do about
  that end; the guidance is in ../README.md and ../proposed/SKILL-addendum.md. What this
  script *does* guard is the new hazard it would otherwise introduce: the model-generated
  tightened question is scrubbed of `"` before being forwarded onward, so an LLM's habit of
  quoting things can't silently truncate a question that the caller passed in cleanly.
#>
param(
    [string]$Question = "Claude has a question.",
    [string]$Detail   = "",
    [string]$Context  = "",
    [switch]$NoSuppress,
    [switch]$NoTighten,
    [switch]$DryRun,
    [int]$TimeoutSec = 8,
    [string]$AskQuestionPath = "$env:USERPROFILE\.claude\bin\ask-question.ps1",
    [string]$LlamaBaseUrl = "http://127.0.0.1:8090"
)

$ErrorActionPreference = "Stop"

$SystemPrompt = @'
You are a suppression filter sitting in front of a blocking interrupt that will pull a human away from their screen with an audible question. Your default answer is "ask" -- interrupts are wanted by default, the human explicitly prefers proactive check-ins over silence. Only recommend "skip" when the Detail or Context already states or trivially implies the answer, or the Question is not really a question needing a human decision. If uncertain in any way, choose "ask".
Also propose a tightened version of Question: the same question compressed to one short sentence suitable for being spoken aloud by text-to-speech. If Question is already short and clear, repeat it unchanged.
Respond with ONLY a single-line JSON object, no markdown fences, no commentary, no extra keys:
{"verdict":"ask|skip","reason":"<short reason, under 15 words>","tightened_question":"<Question tightened to one short spoken sentence>"}
'@

# Mirrors packages/llama-local-server/server.js's isUp(): one short-timeout probe,
# no retry, no attempt to spawn the server ourselves -- starting a cold llama-server
# can take up to ~30s (see config.js), which would defeat the point of a *quick*
# pre-interrupt check. If it's not already up, we just fail open.
function Test-LlamaUp {
    try {
        $r = Invoke-WebRequest -Uri "$LlamaBaseUrl/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# An embedded double quote silently truncates a value when it crosses a
# `powershell.exe -File` boundary or a native-exe arg boundary (ask-question.ps1 forwards
# to wt-focus.exe). Anything this script *generates* and forwards gets scrubbed; single
# quotes read identically once TTS speaks it aloud. Newlines are flattened for the same
# reason -- the spoken question is meant to be one sentence anyway.
function ConvertTo-SafeArg {
    param([string]$Text)
    if (-not $Text) { return "" }
    return ($Text -replace '"', "'" -replace '[\r\n]+', ' ').Trim()
}

# Extracts the outermost {...} substring and parses it. Tolerates the model wrapping
# the JSON in commentary or code fences despite instructions not to.
function Get-JsonVerdict {
    param([string]$Content)
    if (-not $Content) { return $null }
    $start = $Content.IndexOf('{')
    $end   = $Content.LastIndexOf('}')
    if ($start -lt 0 -or $end -lt $start) { return $null }
    $slice = $Content.Substring($start, $end - $start + 1)
    try {
        return $slice | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Invoke-PrefilterJudgment {
    param([string]$Q, [string]$D, [string]$C)

    if (-not (Test-LlamaUp)) { return $null }

    $userContent = "Question: $Q`nDetail: $D`nContext: $(if ($C) { $C } else { '(none provided)' })"
    $body = @{
        model       = 'local'
        messages    = @(
            @{ role = 'system'; content = $SystemPrompt }
            @{ role = 'user';   content = $userContent }
        )
        temperature = 0
        max_tokens  = 200
    } | ConvertTo-Json -Depth 6

    try {
        $resp = Invoke-RestMethod -Uri "$LlamaBaseUrl/v1/chat/completions" `
            -Method Post -Body $body -ContentType 'application/json' `
            -TimeoutSec $TimeoutSec
        $content = $resp.choices[0].message.content
        $parsed  = Get-JsonVerdict -Content $content
        if (-not $parsed) { return $null }

        $verdict = "$($parsed.verdict)".ToLowerInvariant().Trim()
        if ($verdict -ne 'ask' -and $verdict -ne 'skip') { return $null }

        $reason    = ConvertTo-SafeArg ("$($parsed.reason)")
        $tightened = ConvertTo-SafeArg ("$($parsed.tightened_question)")

        return [pscustomobject]@{
            verdict            = $verdict
            reason             = $reason
            tightened_question = $tightened
        }
    } catch {
        return $null
    }
}

# ---- main ----

$judgment = Invoke-PrefilterJudgment -Q $Question -D $Detail -C $Context

$effectiveVerdict = 'ask'
$effectiveReason  = ''
$effectiveQuestion = $Question

if ($judgment) {
    if (-not $NoSuppress) {
        $effectiveVerdict = $judgment.verdict
        $effectiveReason  = $judgment.reason
    }
    # Only accept a tightening that is actually a tightening, and is still a question.
    # Observed failure mode with the 3B model: given "Should I use tabs or spaces?" plus a
    # detail implying the answer, it returns "Use tabs consistently." -- shorter, but now a
    # statement asserting an answer the user never gave. Requiring a question mark cheaply
    # rules that whole class out. Also rejects empty/degenerate and non-shortening results;
    # in any of those cases the caller's own wording is the safer thing to speak.
    $t = $judgment.tightened_question
    if (-not $NoTighten -and
        $t.Length -ge 8 -and
        $t.Length -lt $Question.Length -and
        $t.Contains('?')) {
        $effectiveQuestion = $t
    }
}
# else: local model unreachable/unusable -- fail open, defaults above already say
# verdict=ask, question unchanged.

if ($DryRun) {
    [pscustomobject]@{
        verdict             = $effectiveVerdict
        reason              = $effectiveReason
        original_question   = $Question
        effective_question  = $effectiveQuestion
        model_reachable     = [bool]$judgment
    } | ConvertTo-Json -Compress
    exit 0
}

if ($effectiveVerdict -eq 'skip') {
    $reasonText = if ($effectiveReason) { $effectiveReason } else { "judged redundant with information already available" }
    Write-Output "SUPPRESSED: $reasonText (original question: $Question)"
    exit 0
}

Write-Output (& $AskQuestionPath -Question $effectiveQuestion -Detail $Detail)
