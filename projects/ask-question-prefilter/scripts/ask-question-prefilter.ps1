<#
.SYNOPSIS
  Local-model gate in front of bug-me-claude's ask-question.ps1.

.DESCRIPTION
  Judges (via the suite's local llama-server) whether a blocking interrupt is worth
  firing, and optionally tightens an overly verbose $Question before wt-focus.exe's TTS
  speaks it aloud.

  A drop-in wrapper, NOT a modification of ask-question.ps1: on verdict "ask" it calls
  the real script unmodified and passes its stdout straight through, so the existing
  "answer comes back as Bash stdout" contract holds. Only "skip" is new behaviour -- no
  popup, and a SUPPRESSED: sentinel on stdout instead, which a session told to call this
  script can distinguish. See ../README.md.

  Fails open: any problem talking to the local model (not running, timeout, malformed
  response) gives verdict=ask with the question unchanged, i.e. exactly today's
  behaviour. No retry loop -- one fast /health probe, one chat-completions call.

.PARAMETER Question
  Same meaning as ask-question.ps1's -Question: one sentence, gets spoken aloud via TTS.

.PARAMETER Detail
  Same meaning as ask-question.ps1's -Detail: longer text shown in the popup body.

.PARAMETER Context
  Optional. Anything already known or decided that the model should weigh when judging
  redundancy. Without it, redundancy can only be judged against Question/Detail's own
  content, not against anything Claude alone knows.

.PARAMETER NoSuppress
  Never skip. The model is still consulted for question-tightening, but the verdict is
  always treated as "ask".

.PARAMETER NoTighten
  Never tighten. Question is passed through verbatim; suppression still applies unless
  -NoSuppress is also set.

.PARAMETER DryRun
  Print the verdict, reason and tightened question as JSON and call nothing downstream --
  no popup, no TTS, no suppression for real.

.PARAMETER TimeoutSec
  Budget for the chat completion. Default 8s. On timeout, fails open.

.PARAMETER LlamaBaseUrl
  Base URL of the local llama-server. Defaults to the suite's shared chat instance on
  127.0.0.1:8090. Overridable so the smoke test can verify the fail-open path against a
  dead port.

.PARAMETER AskQuestionPath
  Path to the real ask-question.ps1. Defaults to the installed copy at
  ~/.claude/bin/ask-question.ps1 -- what SKILL.md tells Claude to call -- rather than a
  bug-me-claude checkout, so this works wherever that source tree lives. Also the seam
  the smoke test uses to exercise the "ask" path against a stub.

.NOTES
  `powershell.exe -File` silently truncates an argument at an embedded `"`. That bites
  this script's own caller exactly as it bites direct callers of ask-question.ps1, and
  nothing here can fix that end. What it does guard is the hazard it would otherwise
  introduce: the model-generated tightened question is scrubbed of `"` before being
  forwarded on.
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

# One short-timeout probe, no retry, and no attempt to spawn the server: a cold
# llama-server can take ~30s to come up, which would defeat the point of a *quick*
# pre-interrupt check. Not already up means fail open.
function Test-LlamaUp {
    try {
        $r = Invoke-WebRequest -Uri "$LlamaBaseUrl/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# An embedded double quote silently truncates a value crossing a `powershell.exe -File`
# or native-exe argument boundary, and ask-question.ps1 forwards to wt-focus.exe. Single
# quotes read identically once TTS speaks it. Newlines are flattened because the spoken
# question is meant to be one sentence anyway.
function ConvertTo-SafeArg {
    param([string]$Text)
    if (-not $Text) { return "" }
    return ($Text -replace '"', "'" -replace '[\r\n]+', ' ').Trim()
}

# Outermost {...} substring, so the model wrapping its JSON in commentary or code
# fences despite instructions is tolerated.
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
    # Accept only a tightening that is actually shorter AND still a question -- the 3B
    # model will otherwise turn a question into a statement asserting an answer the user
    # never gave, which TTS then speaks at them. See ../CLAUDE.md. In every rejected
    # case the caller's own wording is the safer thing to speak.
    $t = $judgment.tightened_question
    if (-not $NoTighten -and
        $t.Length -ge 8 -and
        $t.Length -lt $Question.Length -and
        $t.Contains('?')) {
        $effectiveQuestion = $t
    }
}
# else: model unreachable or unusable -- the defaults above already fail open.

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
