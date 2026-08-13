<#
.SYNOPSIS
  Installs the local-inference skill into ~/.claude/skills/local-inference/.

.DESCRIPTION
  Copies SKILL.md and scripts/ into place, writes a config.json with the
  resolved llama.cpp paths, and inserts or updates a marked block in
  ~/.claude/CLAUDE.md. Idempotent -- re-run it after editing any source file
  or moving the suite.

.PARAMETER SuiteRoot
  Override the auto-detected suite root (defaults to two levels up).
#>
param(
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$claudeDir  = "$env:USERPROFILE\.claude"
$skillDir   = "$claudeDir\skills\local-inference"
$scriptsDir = "$skillDir\scripts"
$libDir     = "$scriptsDir\lib"
$scriptRoot = $PSScriptRoot

if (-not $SuiteRoot) {
    $SuiteRoot = Split-Path (Split-Path $scriptRoot -Parent) -Parent
}
$SuiteRoot = $SuiteRoot.TrimEnd('\', '/')

Write-Host "claude-token-monitor: local-inference skill installer"
Write-Host "------------------------------------------------------"
Write-Host "Suite root: $SuiteRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "node.exe not found on PATH -- the delegation scripts need it. Install continues, but they won't run until node is available."
}

foreach ($dir in @($skillDir, $scriptsDir, $libDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Host "Created $dir"
    }
}

Copy-Item (Join-Path $scriptRoot "SKILL.md") "$skillDir\SKILL.md" -Force
Write-Host "  Copied SKILL.md -> $skillDir\SKILL.md"

foreach ($s in @("classify.js", "extract.js", "summarize.js")) {
    Copy-Item (Join-Path $scriptRoot "scripts\$s") "$scriptsDir\$s" -Force
    Write-Host "  Copied $s -> $scriptsDir\$s"
}
Copy-Item (Join-Path $scriptRoot "scripts\lib\local-client.js") "$libDir\local-client.js" -Force
Write-Host "  Copied lib\local-client.js -> $libDir\local-client.js"

$llamaCfgPath = Join-Path $SuiteRoot "packages\llama-local-server\config.js"
$llamaHost = "127.0.0.1"; $llamaPort = 8090
$llamaExe = ""; $llamaModel = ""

if (Test-Path $llamaCfgPath) {
    # path.resolve, or require() reads the bare path as a module name.
    $json =& node -e "const p=require('path');const c=require(p.resolve(process.argv[1]));process.stdout.write(JSON.stringify({host:c.LLAMA_HOST,port:c.LLAMA_PORT,exe:c.LLAMA_SERVER_EXE,model:c.LLAMA_MODEL_PATH,ref:c.LLAMA_MODEL}))" $llamaCfgPath 2>$null
    if ($LASTEXITCODE -eq 0 -and $json) {
        $resolved = $json | ConvertFrom-Json
        $llamaHost  = $resolved.host
        $llamaPort  = [int]$resolved.port
        $llamaExe   = $resolved.exe
        $llamaModel = $resolved.model
    } else {
        Write-Warning "  could not read resolved config from $llamaCfgPath -- config.json will rely on runtime discovery."
    }
} else {
    Write-Warning "  $llamaCfgPath not found -- config.json will rely on runtime discovery."
}

# Empty rather than wrong: local-client.js rediscovers an absent value.
if (-not $llamaExe -or -not (Test-Path $llamaExe)) {
    Write-Warning "  llama-server.exe not found -- build llama.cpp, or set the LLAMA_SERVER_EXE env var."
    $llamaExe = ""
}
if (-not $llamaModel -or -not (Test-Path $llamaModel)) {
    Write-Warning "  no GGUF found -- run ``ollama pull llama3.2``, or set the LLAMA_MODEL_PATH env var."
    $llamaModel = ""
}

$skillConfig = [ordered]@{
    suiteRoot      = ($SuiteRoot -replace '\\', '/')
    llamaHost      = $llamaHost
    llamaPort      = $llamaPort
    llamaServerExe = $llamaExe
    llamaModelPath = $llamaModel
}
# No-BOM, and never Set-Content -Encoding utf8 -- see ../CLAUDE.md "PowerShell 5.1 traps"
[System.IO.File]::WriteAllText("$skillDir\config.json", ($skillConfig | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  Wrote config.json -> $skillDir\config.json"

# Double-quoted here-string, so the markdown backticks below must stay doubled.
$claudeMdPath = "$claudeDir\CLAUDE.md"
$startMarker  = "<!-- local-inference-skill:start -->"
$endMarker    = "<!-- local-inference-skill:end -->"
$block = @"
<!-- local-inference-skill:start -->
## Local Inference Skill

You have a ``local-inference`` skill installed (``~/.claude/skills/local-inference/``)
that offloads small mechanical subtasks -- classifying text against a fixed
label list, extracting one literal value, a throwaway summary -- to a local
llama.cpp model on port 8090 instead of spending API tokens on them. Backed by
the suite at ``$SuiteRoot``. It is a 3B model: read the skill's scope rules
before delegating, and never send it judgment calls, code, or user-facing
prose.
<!-- local-inference-skill:end -->
"@

# -Encoding UTF8 is mandatory on read too -- see ../CLAUDE.md "PowerShell 5.1 traps"
$content = if (Test-Path $claudeMdPath) { Get-Content $claudeMdPath -Raw -Encoding UTF8 } else { "" }

if ($content -match [regex]::Escape($startMarker)) {
    $pattern = "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))"
    $evaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block }
    $content = [regex]::Replace($content, $pattern, $evaluator)
    Write-Host "Updated existing local-inference block in $claudeMdPath"
} else {
    if ($content -and -not $content.EndsWith("`n`n")) {
        $content += if ($content.EndsWith("`n")) { "`n" } else { "`n`n" }
    }
    $content += "$block`n"
    Write-Host "Appended local-inference block to $claudeMdPath"
}

[System.IO.File]::WriteAllText($claudeMdPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Done! The local-inference skill is installed at $skillDir"
Write-Host "It'll show up in the available-skills listing starting your next Claude Code session."
