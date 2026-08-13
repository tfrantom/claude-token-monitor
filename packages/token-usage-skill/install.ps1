param(
    # Defaults to two levels up from this script (packages/token-usage-skill
    # -> packages -> suite root) -- override if you're installing a copy of
    # this package that doesn't live at its usual place inside the suite.
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$claudeDir  = "$env:USERPROFILE\.claude"
$skillDir   = "$claudeDir\skills\token-usage"
$scriptsDir = "$skillDir\scripts"
$scriptRoot = $PSScriptRoot  # .../packages/token-usage-skill

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

# The installed copy lives outside the suite, so it has no relative path back
# to it -- the resolved suite paths get written here at install time instead
# of hardcoded in lookup.js. Re-run this script if the suite ever moves.
$coreDir = "$SuiteRoot/packages/token-monitor-core" -replace '\\', '/'
$skillConfig = [ordered]@{
    suiteRoot  = ($SuiteRoot -replace '\\', '/')
    statusFile = "$coreDir/state/status.json"
    watcherCmd = "node $coreDir/watcher.js"
}
# NOT Set-Content -Encoding utf8: PowerShell 5.1 writes a BOM with that, and
# Node's JSON.parse rejects a leading BOM outright. WriteAllText with an
# explicit no-BOM UTF8Encoding is the only reliable way to get clean UTF-8
# out of 5.1. (lookup.js also strips a BOM defensively, belt-and-braces.)
[System.IO.File]::WriteAllText("$skillDir\config.json", ($skillConfig | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  Wrote config.json -> $skillDir\config.json"

# Idempotent: re-running this script updates the block in place instead of
# appending a duplicate every time. Single-quoted here-string -- no variable
# expansion, no backtick-escape processing -- so the markdown backticks in
# the block below (`token-usage`, `~/.claude/...`) survive as literal text
# instead of being parsed as PowerShell escape sequences (`` `t `` is a tab).
$claudeMdPath = "$claudeDir\CLAUDE.md"
$startMarker  = "<!-- token-usage-skill:start -->"
$endMarker    = "<!-- token-usage-skill:end -->"
# Double-quoted here-string so $SuiteRoot interpolates -- the backticks below
# are escaped (`` ` ``) so they survive as literal markdown rather than being
# read as PowerShell escape sequences.
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

# -Encoding UTF8 is required here, not optional: Windows PowerShell 5.1's
# Get-Content falls back to the system codepage for any file without a BOM,
# which silently mangles multi-byte characters (em-dashes etc.) into mojibake
# on read -- and that corruption then gets faithfully written back out.
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

# Same no-BOM rule as config.json above -- `Set-Content -Encoding utf8` on
# PowerShell 5.1 prepends a UTF-8 BOM, and this file is ~/.claude/CLAUDE.md,
# which Claude Code reads on every session start. Writing a BOM here also
# means the NEXT run's `Get-Content -Raw -Encoding UTF8` round-trips it back
# out, so the marker never gets cleaned up on its own.
[System.IO.File]::WriteAllText($claudeMdPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Done! The token-usage skill is installed at $skillDir"
Write-Host "It'll show up in the available-skills listing starting your next Claude Code session."
