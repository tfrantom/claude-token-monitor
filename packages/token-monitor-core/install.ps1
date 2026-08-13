<#
.SYNOPSIS
  Wires this suite's status line into Claude Code.

.DESCRIPTION
  Points ~/.claude/settings.json's statusLine.command at this package's
  statusline.js, resolved from wherever the suite actually lives.

  Idempotent. Re-run it after moving the suite.

  Discovered and run automatically by the suite-level install.ps1, which
  passes -SuiteRoot. Runnable standalone too -- it derives the suite root
  from its own location when the parameter is absent.

  This does NOT start the watcher, and does not need to: statusline.js starts
  one on demand the next time Claude Code renders a status line, and that
  watcher stops itself (and the shared llama-server) once no Claude Code
  session is live. Nothing wired here leaves a process behind.

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

# -Encoding UTF8 on the read is mandatory -- PowerShell 5.1 otherwise decodes
# a BOM-less UTF-8 file as the system codepage and silently mangles any
# non-ASCII already in there (this bit us for real once).
$settings = if (Test-Path $settingsPath) {
    Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [PSCustomObject]@{}
}

# refreshInterval is REQUIRED, not cosmetic. Claude Code re-renders the status
# line on events (new assistant message, /compact, mode change) and those go
# quiet while the session is idle -- so without a timer the bar freezes after
# a turn ends and shows a stale name/cost until the user types again. That
# reads exactly like "the name lags one prompt behind." Rebuilding this object
# wholesale silently dropped the setting once already; keep it here so
# reinstalling can't regress it.
$statusLineObj = [PSCustomObject]@{ type = "command"; command = $statuslineCmd; refreshInterval = 2 }
if ($settings.PSObject.Properties.Name -contains 'statusLine') {
    $settings.statusLine = $statusLineObj
} else {
    $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLineObj
}

# WriteAllText with an explicit no-BOM encoder, never Set-Content -Encoding
# utf8: PowerShell 5.1's utf8 writes a BOM, and a BOM in settings.json makes
# Claude Code's JSON parser reject the file outright.
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "  [ok]   statusLine -> $statuslineCmd"
Write-Host "         the watcher starts itself on the next status line render;"
Write-Host "         to watch its logs instead: node $fwd/packages/token-monitor-core/watcher.js"
