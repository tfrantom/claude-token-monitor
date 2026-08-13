<#
.SYNOPSIS
  Suite-level installer for claude-token-monitor.

.DESCRIPTION
  Runs each packages\<x>\install.ps1 and projects\<x>\install.ps1, wiring
  every external integration point to wherever this suite lives. Idempotent:
  re-run it after moving the suite.

  Starts nothing. The last section reports which background services are
  running and how to start the ones that aren't.

.PARAMETER SuiteRoot
  Override the auto-detected suite root (defaults to this script's directory).

.PARAMETER SkipNvim
  Don't write the lazy.nvim plugin spec (suppresses the token-monitor.nvim
  component installer).

.PARAMETER SkipStatusLine
  Don't touch ~/.claude/settings.json (suppresses the token-monitor-core
  component installer).

.PARAMETER SkipComponents
  Don't run any discovered per-package / per-project installer. Since every
  integration is owned by a component, this makes the script write nothing.
#>
param(
    [string]$SuiteRoot,
    [switch]$SkipNvim,
    [switch]$SkipStatusLine,
    [switch]$SkipComponents
)

$ErrorActionPreference = "Stop"

if (-not $SuiteRoot) { $SuiteRoot = $PSScriptRoot }
$SuiteRoot = (Resolve-Path $SuiteRoot).Path.TrimEnd('\', '/')
$fwd = $SuiteRoot -replace '\\', '/'

$claudeDir = "$env:USERPROFILE\.claude"

Write-Host ""
Write-Host "claude-token-monitor -- suite installer"
Write-Host "======================================="
Write-Host "Suite root: $SuiteRoot"
Write-Host ""

Write-Host "Checking prerequisites..."

if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "  [ok]   node $(node --version)"
} else {
    Write-Warning "  node.exe not on PATH -- the watcher and skill lookup both need it."
}

$llamaCfg =Join-Path $SuiteRoot "packages\llama-local-server\config.js"
if ((Test-Path $llamaCfg) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $json = & node -e "const p=require('path');const c=require(p.resolve(process.argv[1]));process.stdout.write(JSON.stringify({exe:c.LLAMA_SERVER_EXE,model:c.LLAMA_MODEL_PATH,ref:c.LLAMA_MODEL}))" $llamaCfg 2>$null
    if ($LASTEXITCODE -eq 0 -and $json) {
        $r = $json | ConvertFrom-Json

        if ($r.exe -and (Test-Path $r.exe)) {
            Write-Host "  [ok]   llama-server.exe: $($r.exe)"
        } else {
            Write-Warning "  llama-server.exe not found (looked for a llama.cpp build and on PATH)"
            Write-Host  "         Build llama.cpp, or set LLAMA_SERVER_EXE / LLAMA_CPP_DIR." -ForegroundColor DarkYellow
        }

        if ($r.model -and (Test-Path $r.model)) {
            Write-Host "  [ok]   model '$($r.ref)': $($r.model)"
        } else {
            Write-Warning "  no GGUF found for '$($r.ref)'"
            Write-Host  "         Run: ollama pull $($r.ref -replace ':latest$', '')" -ForegroundColor DarkYellow
            Write-Host  "         ...or set LLAMA_MODEL / LLAMA_MODEL_PATH." -ForegroundColor DarkYellow
        }
    } else {
        Write-Warning "  could not read resolved paths from $llamaCfg"
    }
}

$failedComponents = @()

$skipComponentNames = @()
if ($SkipStatusLine) { $skipComponentNames += 'token-monitor-core' }
if ($SkipNvim)       { $skipComponentNames += 'token-monitor.nvim' }

if (-not $SkipComponents) {
    Write-Host ""
    Write-Host "Running component installers..."

    $componentInstallers = @(
        (Join-Path $SuiteRoot "packages"),
        (Join-Path $SuiteRoot "projects")
    ) | Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem -Path $_ -Directory } |
        ForEach-Object { Join-Path $_.FullName "install.ps1" } |
        Where-Object { Test-Path $_ } |
        Sort-Object

    if (-not $componentInstallers) {
        Write-Host "  [skip] no component install.ps1 found under packages\ or projects\"
    }

    foreach ($installer in $componentInstallers) {
        $label = Split-Path (Split-Path $installer -Parent) -Leaf

        if ($skipComponentNames -contains $label) {
            Write-Host ""
            Write-Host "  --- $label"
            Write-Host "  [skip] suppressed by a -Skip switch"
            continue
        }

        Write-Host ""
        Write-Host "  --- $label"

        try {
            $takesSuiteRoot = $false
            try {
                $takesSuiteRoot = (Get-Command -Name $installer -CommandType ExternalScript -ErrorAction Stop).Parameters.ContainsKey('SuiteRoot')
            } catch {
                Write-Warning "    couldn't read $label's parameters -- calling it with no arguments."
            }

            if ($takesSuiteRoot) { & $installer -SuiteRoot $SuiteRoot } else { & $installer }
        } catch {
            $failedComponents += $label
            Write-Warning "    $label installer failed: $($_.Exception.Message)"
            Write-Host   "         Continuing with the rest of the suite install." -ForegroundColor DarkYellow
        }
    }
}

Write-Host ""
Write-Host "Background services (this installer does not start or manage these)"

$nodeCmdLines = @()
try {
    $nodeCmdLines = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
        ForEach-Object { $_.CommandLine } |
        Where-Object { $_ } |
        ForEach-Object { $_ -replace '/', '\' })
} catch {
    Write-Host "  (couldn't enumerate node.exe processes -- running/stopped state unknown)"
}

$daemons = @(
    @{ Name = "token-monitor watcher"; Rel = "packages\token-monitor-core\watcher.js";  Note = "core -- starts itself on the next status line render" },
    @{ Name = "cost-anomaly-alerts";   Rel = "projects\cost-anomaly-alerts\monitor.js"; Note = "optional -- notifies when a session crosses a cost tier" },
    @{ Name = "usage-history-rollups"; Rel = "projects\usage-history-rollups\poller.js"; Note = "optional -- appends session history to history.jsonl" }
)

foreach ($d in $daemons) {
    $abs = Join-Path $SuiteRoot $d.Rel
    if (-not (Test-Path $abs)) { continue }
    # Matches a path-qualified launch or a bare `node watcher.js`; Win32_Process exposes no cwd.
    $leaf    =Split-Path $d.Rel -Leaf
    $dirLeaf = Split-Path (Split-Path $d.Rel -Parent) -Leaf
    $bare    = '(?i)(^|[\s"])(\.\\)?' + [regex]::Escape($leaf) + '("|\s|$)'
    $up = @($nodeCmdLines | Where-Object { $_ -like "*$dirLeaf\$leaf*" -or $_ -match $bare }).Count -gt 0
    $tag = if ($up) { "[ up ]" } else { "[down]" }
    Write-Host "  $tag   $($d.Name) -- $($d.Note)"
    if (-not $up) {
        Write-Host "         node $fwd/$($d.Rel -replace '\\', '/')"
    }
}

if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $ports = @()
    $portsJson = & node -e "const p=require('path');const r=require(p.resolve(process.argv[1]));process.stdout.write(JSON.stringify(r.list().map(c=>({Port:c.port,What:c.owner+' -- '+c.model}))))" (Join-Path $SuiteRoot "packages\llama-local-server\ports.js") 2>$null
    if ($LASTEXITCODE -eq 0 -and $portsJson) {
        $ports = @($portsJson | ConvertFrom-Json)
    } else {
        $ports = @(@{ Port = 8090; What = "llama-local-server -- shared chat" })
    }
    foreach ($p in $ports) {
        $listening = $false
        try { $listening = [bool](Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction Stop) } catch { }
        $tag = if ($listening) { "[ up ]" } else { "[----]" }
        Write-Host "  $tag   :$($p.Port) $($p.What)"
    }
    Write-Host "         llama-server instances start on demand and stop with the watcher -- [----] is normal."
}

$manual = @()
if (Test-Path (Join-Path $SuiteRoot "projects\ask-question-prefilter")) {
    $manual += "ask-question-prefilter is inert until bug-me-claude's own SKILL.md points at it (a cross-project edit, then re-run bug-me-claude's install.ps1). See projects/ask-question-prefilter/proposed/."
}
if ($manual) {
    Write-Host ""
    Write-Host "Not wired automatically:"
    foreach ($m in $manual) { Write-Host "  - $m" }
}

Write-Host ""
Write-Host "======================================="
if ($failedComponents) {
    Write-Warning "Component installers that failed: $($failedComponents -join ', ')"
    Write-Host "Everything else was wired. Fix the above and re-run -- this script is idempotent."
    Write-Host ""
}
Write-Host "Done. Nothing left to start:"
Write-Host "  open a Claude Code session and the status line brings up the watcher,"
Write-Host "  which brings up the shared llama.cpp server. Give it a few seconds"
Write-Host "  before the first numbers appear (the model has to load)."
Write-Host ""
Write-Host "  Closing the last Claude Code session stops both again."
Write-Host ""
Write-Host "To run the watcher by hand instead, and see its logs:"
Write-Host "  node $fwd/packages/token-monitor-core/watcher.js"
