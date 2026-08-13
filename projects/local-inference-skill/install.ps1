param(
    # Defaults to two levels up from this script (projects/local-inference-skill
    # -> projects -> suite root) -- override if you're installing a copy that
    # doesn't live at its usual place inside the suite.
    [string]$SuiteRoot
)

$ErrorActionPreference = "Stop"

$claudeDir  = "$env:USERPROFILE\.claude"
$skillDir   = "$claudeDir\skills\local-inference"
$scriptsDir = "$skillDir\scripts"
$libDir     = "$scriptsDir\lib"
$scriptRoot = $PSScriptRoot  # .../projects/local-inference-skill

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

# The installed copy lives outside the suite, so it has no relative path back
# to it -- and the llama.cpp exe / GGUF locations aren't suite-relative at all,
# they're machine-specific. Both get resolved here at install time and written
# alongside the skill. Values are read out of the suite's own
# llama-local-server/config.js so this never drifts from what the watcher uses
# (env vars still win at runtime, same as they do there).
$llamaCfgPath = Join-Path $SuiteRoot "packages\llama-local-server\config.js"
$llamaHost = "127.0.0.1"; $llamaPort = 8090
$llamaExe = ""; $llamaModel = ""

# Ask config.js what it resolves to, rather than parsing it. This used to
# scrape the quoted defaults out of the source with four regexes, which worked
# only for as long as those values stayed string literals -- they are now
# resolved (an Ollama manifest lookup, a search of the usual build locations),
# so there is no literal left to scrape and the regexes would silently fall
# back to stale hardcoded paths. Running the file is also the only way to get
# the same answer the watcher will get at runtime, which is the entire point of
# reading it here.
if (Test-Path $llamaCfgPath) {
    # path.resolve, because require() treats a bare relative path as a module
    # name rather than a file.
    $json = & node -e "const p=require('path');const c=require(p.resolve(process.argv[1]));process.stdout.write(JSON.stringify({host:c.LLAMA_HOST,port:c.LLAMA_PORT,exe:c.LLAMA_SERVER_EXE,model:c.LLAMA_MODEL_PATH,ref:c.LLAMA_MODEL}))" $llamaCfgPath 2>$null
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

# Empty rather than wrong: local-client.js does its own discovery when a value
# is absent from config.json, so writing a known-bad path would be strictly
# worse than writing nothing.
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
# NOT Set-Content -Encoding utf8: PowerShell 5.1 writes a BOM with that, and
# Node's JSON.parse rejects a leading BOM outright. WriteAllText with an
# explicit no-BOM UTF8Encoding is the only reliable way to get clean UTF-8 out
# of 5.1. (local-client.js also strips a BOM defensively, belt-and-braces.)
[System.IO.File]::WriteAllText("$skillDir\config.json", ($skillConfig | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  Wrote config.json -> $skillDir\config.json"

# Idempotent: re-running updates the marked block in place rather than
# appending a duplicate. Double-quoted here-string so $SuiteRoot interpolates
# -- the backticks below are escaped (`` ` ``) so they survive as literal
# markdown instead of being read as PowerShell escape sequences.
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

# -Encoding UTF8 is required on the read, not optional: Windows PowerShell
# 5.1's Get-Content falls back to the system codepage for any file without a
# BOM, which silently mangles multi-byte characters (em-dashes etc.) on read --
# and that corruption then gets faithfully written back out.
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

# Same no-BOM rule as config.json above -- `Set-Content -Encoding utf8` on
# PowerShell 5.1 prepends a UTF-8 BOM, and this file is ~/.claude/CLAUDE.md,
# which Claude Code reads on every session start. Writing a BOM here also
# means the NEXT run's `Get-Content -Raw -Encoding UTF8` round-trips it back
# out, so the marker never gets cleaned up on its own.
[System.IO.File]::WriteAllText($claudeMdPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Done! The local-inference skill is installed at $skillDir"
Write-Host "It'll show up in the available-skills listing starting your next Claude Code session."
