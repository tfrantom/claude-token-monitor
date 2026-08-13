<#
.SYNOPSIS
  Stand-in for bug-me-claude's ask-question.ps1, for testing the prefilter's "ask" path.

.DESCRIPTION
  Same parameter surface as the real ask-question.ps1 (-Question / -Detail), but instead
  of shelling out to wt-focus.exe it echoes what it received and returns a canned answer
  on stdout -- mimicking the real script's contract (the user's typed answer is the
  script's stdout).

  Exists because the real popup can't currently be used as a test oracle on this machine:
  wt-focus.exe's WinForms dialog is not rendering (process runs, TTS speaks, focus is
  restored, call returns in ~5s without blocking). That's a bug-me-claude issue, out of
  scope here -- this stub lets the prefilter's forwarding path be verified regardless.

  Pass it to the prefilter via -AskQuestionPath.
#>
param(
    [string]$Question = "Claude has a question.",
    [string]$Detail   = ""
)

Write-Output "STUB-ASK-QUESTION"
Write-Output "  question: $Question"
Write-Output "  detail:   $Detail"
Write-Output "canned answer from stub"
