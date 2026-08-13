<#
.SYNOPSIS
  Installs the token-usage skill into ~/.claude/skills/token-usage/.

.DESCRIPTION
  Copies SKILL.md and scripts/lookup.js into place, writes a config.json with
  the resolved suite paths, and inserts or updates a marked block in
  ~/.claude/CLAUDE.md. Idempotent -- re-run it after editing either source
  file or moving the suite.

.PARAMETER SuiteRoot
  Override the auto-detected suite root (defaults to two levels up).
#>
param(
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$claudeDir  = "$env:USERPROFILE\.claude"
$skillDir   = "$claudeDir\skills\token-usage"
$scriptsDir = "$skillDir\scripts"
$scriptRoot = $PSScriptRoot

if (-not $SuiteRoot) {
    $SuiteRoot = Split-Path (Split-Path $scriptRoot -Parent) -Parent
}
$SuiteRoot = $SuiteRoot.TrimEnd('\', '/')

Write-Host "claude-token-monitor: token-usage skill installer"
Write-Host "---------------------------------------------------"
Write-Host "Suite root: $SuiteRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "node.exe not found on PATH -- the lookup script needs it. Install continues, but it won't run until node is available."
}

foreach ($dir in @($skillDir, $scriptsDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "Created $dir"
    }
}

Copy-Item (Join-Path $scriptRoot "SKILL.md") "$skillDir\SKILL.md" -Force
Write-Host "  Copied SKILL.md -> $skillDir\SKILL.md"

Copy-Item (Join-Path $scriptRoot "scripts\lookup.js") "$scriptsDir\lookup.js" -Force
Write-Host "  Copied lookup.js -> $scriptsDir\lookup.js"

$coreDir ="$SuiteRoot/packages/token-monitor-core" -replace '\\', '/'
$skillConfig = [ordered]@{
    suiteRoot  = ($SuiteRoot -replace '\\', '/')
    statusFile = "$coreDir/state/status.json"
    watcherCmd = "node $coreDir/watcher.js"
}
# No-BOM, and never Set-Content -Encoding utf8 -- see CLAUDE.md "Encoding"
[System.IO.File]::WriteAllText("$skillDir\config.json", ($skillConfig | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  Wrote config.json -> $skillDir\config.json"

$claudeMdPath = "$claudeDir\CLAUDE.md"
$startMarker  = "<!-- token-usage-skill:start -->"
$endMarker    = "<!-- token-usage-skill:end -->"
# Double-quoted here-string, so the markdown backticks below must stay doubled.
$block = @"
<!-- token-usage-skill:start -->
## Token Usage Skill

You have a ``token-usage`` skill installed (``~/.claude/skills/token-usage/``) that
reports real-time token usage, cost, and a reading/writing/thinking/tool-call
breakdown for this session or any other active Claude Code session on this
machine, backed by a watcher at ``$SuiteRoot``. Use it
whenever usage or cost comes up instead of estimating -- see the skill for
full usage.
<!-- token-usage-skill:end -->
"@

# -Encoding UTF8 is mandatory on read too -- see CLAUDE.md "Encoding"
$content = if (Test-Path $claudeMdPath) { Get-Content $claudeMdPath -Raw -Encoding UTF8 } else { "" }

if ($content -match [regex]::Escape($startMarker)) {
    $pattern = "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))"
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block }
    $content = [regex]::Replace($content, $pattern, $evaluator)
    Write-Host "Updated existing token-usage block in $claudeMdPath"
} else {
    if ($content -and -not $content.EndsWith("`n`n")) {
        $content += if ($content.EndsWith("`n")) { "`n" } else { "`n`n" }
    }
    $content += "$block`n"
    Write-Host "Appended token-usage block to $claudeMdPath"
}

[System.IO.File]::WriteAllText($claudeMdPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Done! The token-usage skill is installed at $skillDir"
Write-Host "It'll show up in the available-skills listing starting your next Claude Code session."
