<#
.SYNOPSIS
  Stand-in for bug-me-claude's ask-question.ps1, for testing the prefilter's "ask" path.

.DESCRIPTION
  Same parameter surface as the real ask-question.ps1 (-Question / -Detail), but echoes
  what it received and returns a canned answer on stdout instead of showing a popup.
  Pass it to the prefilter via -AskQuestionPath. See ../../CLAUDE.md for why the real
  popup cannot be used as a test oracle on this machine.
#>
param(
    [string]$Question = "Claude has a question.",
    [string]$Detail   = ""
)

Write-Output "STUB-ASK-QUESTION"
Write-Output "  question: $Question"
Write-Output "  detail:   $Detail"
Write-Output "canned answer from stub"
