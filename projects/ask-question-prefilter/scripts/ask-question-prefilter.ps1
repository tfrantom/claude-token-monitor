<#
.SYNOPSIS
  Local-model gate in front of bug-me-claude's ask-question.ps1.

.DESCRIPTION
  Judges (via the suite's local llama-server) whether a blocking interrupt is worth
  firing, and optionally tightens an overly verbose $Question before it is spoken aloud.

  A drop-in wrapper, NOT a modification of ask-question.ps1: on verdict "ask" it calls
  the real script unmodified and passes its stdout straight through. Only "skip" is new
  behaviour -- no popup, and a SUPPRESSED: sentinel on stdout instead.

  Fails open: any problem talking to the local model gives verdict=ask with the question
  unchanged, i.e. exactly today's behaviour.

.PARAMETER Question
  Same meaning as ask-question.ps1's -Question: one sentence, gets spoken aloud via TTS.

.PARAMETER Detail
  Same meaning as ask-question.ps1's -Detail: longer text shown in the popup body.

.PARAMETER Context
  Optional. Anything already known or decided that the model should weigh when judging
  redundancy.

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
  127.0.0.1:8090.

.PARAMETER AskQuestionPath
  Path to the real ask-question.ps1. Defaults to the installed copy at
  ~/.claude/bin/ask-question.ps1.

.NOTES
  See CLAUDE.md next to this project for the design and the quote-truncation trap.
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

# Never spawns the server -- see CLAUDE.md "The model call is hand-rolled"
function Test-LlamaUp {
    try {
        $r = Invoke-WebRequest -Uri "$LlamaBaseUrl/health" -TimeoutSec 2 -UseBasicParsing
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# An embedded " truncates a -File argument -- see CLAUDE.md "Quote handling"
function ConvertTo-SafeArg {
    param([string]$Text)
    if (-not $Text) { return "" }
    return ($Text -replace '"', "'" -replace '[\r\n]+', ' ').Trim()
}

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

$judgment = Invoke-PrefilterJudgment -Q $Question -D $Detail -C $Context

$effectiveVerdict = 'ask'
$effectiveReason  = ''
$effectiveQuestion = $Question

if ($judgment) {
    if (-not $NoSuppress) {
        $effectiveVerdict = $judgment.verdict
        $effectiveReason  = $judgment.reason
    }
    # All three conditions are load-bearing -- see CLAUDE.md "Tightening has a structural guard"
    $t = $judgment.tightened_question
    if (-not $NoTighten -and
        $t.Length -ge 8 -and
        $t.Length -lt $Question.Length -and
        $t.Contains('?')) {
        $effectiveQuestion = $t
    }
}

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
