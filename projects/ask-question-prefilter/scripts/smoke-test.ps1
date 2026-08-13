<#
.SYNOPSIS
  Repeatable smoke test for ask-question-prefilter.ps1. Never shows a popup.

.DESCRIPTION
  Judgment cases run with -DryRun (verdict as JSON, nothing called downstream).
  Forwarding cases run for real against scripts/stub-ask-question.ps1 via
  -AskQuestionPath, so neither path reaches a popup or TTS.

  Requires the chat server already up on 127.0.0.1:8090; it does not start it. If
  model_reachable comes back false, start `node packages/token-monitor-core/watcher.js`.
  The final case points at a dead port on purpose, to verify the fail-open path.

  NOT a pass/fail harness -- it asserts nothing and exits 0 regardless. Each case prints
  an expectation next to its actual result for a human to eyeball.
#>

$ErrorActionPreference = "Stop"
$scriptDir  = $PSScriptRoot
$prefilter  = Join-Path $scriptDir "ask-question-prefilter.ps1"
$stub       = Join-Path $scriptDir "stub-ask-question.ps1"

function Run-Case {
    param([string]$Name, [string]$Expect, [hashtable]$Params)
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    Write-Host "expect: $Expect" -ForegroundColor DarkGray
    $result = & $prefilter @Params
    $result | ForEach-Object { Write-Host "  $_" }
    Write-Host ""
}

Run-Case "Obviously redundant -- detail already states the answer" `
    "verdict=skip" `
    @{ DryRun = $true
       Question = "Should I use tabs or spaces for this file?"
       Detail   = "The existing file already uses tabs consistently throughout." }

Run-Case "Genuine judgment call" `
    "verdict=ask (this is exactly what interrupts are for)" `
    @{ DryRun = $true
       Question = "Should I rewrite the auth module or patch it?"
       Detail   = "Rewriting takes about 2 hours and touches 12 files. Patching is faster but leaves tech debt. No strong signal either way from the codebase." }

Run-Case "Verbose question, real decision" `
    "verdict=ask, effective_question noticeably shorter than original" `
    @{ DryRun = $true
       Question = "Do you want me to delete the old backup directory containing 40GB of data now that the migration is verified working, or would you prefer to keep it around for a while longer just in case something unexpected comes up later?"
       Detail   = "Migration verified successful, all tests passing." }

Run-Case "Context (not detail) carries the answer" `
    "verdict=skip -- shows -Context feeds the redundancy judgment" `
    @{ DryRun = $true
       Question = "Which port should the dev server run on?"
       Context  = "User said five minutes ago: always use port 4000 for local dev, never the default." }

Run-Case "-NoSuppress escape hatch" `
    "verdict=ask despite the redundant case above; tightening still applied" `
    @{ DryRun = $true
       NoSuppress = $true
       Question = "Should I use tabs or spaces for this file?"
       Detail   = "The existing file already uses tabs consistently throughout." }

Run-Case "-NoTighten escape hatch" `
    "effective_question identical to original_question" `
    @{ DryRun = $true
       NoTighten = $true
       Question = "Do you want me to delete the old backup directory containing 40GB of data now that the migration is verified working, or would you prefer to keep it around for a while longer?"
       Detail   = "Migration verified successful, all tests passing." }

Run-Case "Embedded double quotes survive to the model call" `
    "verdict printed, nothing truncated at the quote; any quotes the model emits come back as apostrophes" `
    @{ DryRun = $true
       Question = 'Should I name the flag "force" or "overwrite"?'
       Detail   = 'Both appear elsewhere in the codebase; no convention established.' }

Run-Case "ASK path forwards to ask-question.ps1 and passes stdout through" `
    "STUB-ASK-QUESTION block, then 'canned answer from stub' as the last line" `
    @{ AskQuestionPath = $stub
       Question = "Should I rewrite the auth module or patch it?"
       Detail   = "Rewriting takes about 2 hours and touches 12 files. Patching is faster but leaves tech debt." }

Run-Case "SKIP path never reaches ask-question.ps1" `
    "a single SUPPRESSED: line, no STUB-ASK-QUESTION output at all" `
    @{ AskQuestionPath = $stub
       Question = "Should I use tabs or spaces for this file?"
       Detail   = "The existing file already uses tabs consistently throughout." }

Run-Case "Fail open when the local model is unreachable" `
    "model_reachable=false, verdict=ask, effective_question == original_question" `
    @{ DryRun = $true
       LlamaBaseUrl = "http://127.0.0.1:59999"
       Question = "Should I use tabs or spaces for this file?"
       Detail   = "The existing file already uses tabs consistently throughout." }
