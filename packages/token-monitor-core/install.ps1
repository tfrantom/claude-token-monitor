<#
.SYNOPSIS
  Points ~/.claude/settings.json's statusLine.command at this package's
  statusline.js. Idempotent, and starts nothing.

.PARAMETER SuiteRoot
  Override the auto-detected suite root (defaults to two levels up).
#>
param(
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$scriptRoot = $PSScriptRoot
if (-not $SuiteRoot) { $SuiteRoot = Split-Path (Split-Path $scriptRoot -Parent) -Parent }
$SuiteRoot = (Resolve-Path $SuiteRoot).Path.TrimEnd('\', '/')
$fwd = $SuiteRoot -replace '\\', '/'

$claudeDir    = "$env:USERPROFILE\.claude"
$settingsPath = "$claudeDir\settings.json"
$statuslineCmd = "node $fwd/packages/token-monitor-core/statusline.js"

if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

# -Encoding UTF8 on the read and the no-BOM encoder on the write are both
# mandatory -- see the suite CLAUDE.md "PowerShell 5.1 encoding, every single
# time".
$settings = if (Test-Path $settingsPath) {
    Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
} else {
    [PSCustomObject]@{}
}

# refreshInterval is required, not cosmetic -- see CLAUDE.md "The status line
# starts the watcher, and that budget is tiny".
$statusLineObj = [PSCustomObject]@{ type = "command"; command = $statuslineCmd; refreshInterval = 2 }
if ($settings.PSObject.Properties.Name -contains 'statusLine') {
    $settings.statusLine = $statusLineObj
} else {
    $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLineObj
}

[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "  [ok]   statusLine -> $statuslineCmd"
Write-Host "         the watcher starts itself on the next status line render;"
Write-Host "         to watch its logs instead: node $fwd/packages/token-monitor-core/watcher.js"
