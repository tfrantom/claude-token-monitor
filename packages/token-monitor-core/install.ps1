<#
.SYNOPSIS
  Wires this suite's status line into Claude Code.

.DESCRIPTION
  Points ~/.claude/settings.json's statusLine.command at this package's
  statusline.js, resolved from wherever the suite actually lives.

  Idempotent. Re-run it after moving the suite. Starts nothing: the next
  status line render brings the watcher up on its own.

  Discovered and run automatically by the suite-level install.ps1, which
  passes -SuiteRoot. Runnable standalone too -- it derives the suite root
  from its own location when the parameter is absent.

.PARAMETER SuiteRoot
  Override the auto-detected suite root (defaults to two levels up).
#>
param(
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot   # .../packages/token-monitor-core
if (-not $SuiteRoot) { $SuiteRoot = Split-Path (Split-Path $scriptRoot -Parent) -Parent }
$SuiteRoot = (Resolve-Path $SuiteRoot).Path.TrimEnd('\', '/')
$fwd = $SuiteRoot -replace '\\', '/'

$claudeDir    = "$env:USERPROFILE\.claude"
$settingsPath = "$claudeDir\settings.json"
$statuslineCmd = "node $fwd/packages/token-monitor-core/statusline.js"

if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

# -Encoding UTF8 is mandatory on the read -- see the suite CLAUDE.md
# "PowerShell 5.1 encoding, every single time".
$settings = if (Test-Path $settingsPath) {
    Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [PSCustomObject]@{}
}

# refreshInterval is required, not cosmetic -- without it the bar freezes
# whenever a session goes idle. See CLAUDE.md "The status line starts the
# watcher, and that budget is tiny".
$statusLineObj = [PSCustomObject]@{ type = "command"; command = $statuslineCmd; refreshInterval = 2 }
if ($settings.PSObject.Properties.Name -contains 'statusLine') {
    $settings.statusLine = $statusLineObj
} else {
    $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLineObj
}

# Explicit no-BOM encoder, never Set-Content -Encoding utf8: a BOM makes
# Claude Code's JSON parser reject settings.json outright.
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "  [ok]   statusLine -> $statuslineCmd"
Write-Host "         the watcher starts itself on the next status line render;"
Write-Host "         to watch its logs instead: node $fwd/packages/token-monitor-core/watcher.js"
