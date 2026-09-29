[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('06:00', '12:00', '18:00', 'manual')]
    [string]$Slot,
    [switch]$CurrentYearPriority
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$scraperRoot = Join-Path $repoRoot 'db-old'
$panelEnv = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\.env.local'
$runtimeDir = Join-Path $repoRoot 'local-data'
$logDir = Join-Path $runtimeDir 'logs'
$logPath = Join-Path $logDir ("echr-scraper-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$requiredNames = @('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID')
$nodePath = (Get-Command node -ErrorAction Stop).Source

function Import-SelectedEnvironmentFile {
    param([string]$Path, [string[]]$Names)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Yerel AİHM yapılandırması bulunamadı: $Path"
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?<value>.*)\s*$') {
            $name = $matches.name
            if ($name -notin $Names) { continue }
            $value = $matches.value.Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null
Import-SelectedEnvironmentFile -Path $panelEnv -Names $requiredNames

foreach ($name in $requiredNames) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
        throw "Gerekli yerel AİHM yapılandırması eksik: $name"
    }
}

# Keep all mutable runtime files outside the Git checkout. The scraper resumes from
# this local checkpoint even if GitHub is unreachable.
$env:SCRAPER_STATE_FILE = Join-Path $runtimeDir 'scraper-state.json'
$env:SCRAPER_FAILURE_REPORT_FILE = Join-Path $runtimeDir 'scraper-failure.json'
$env:SCRAPER_SCHEDULE_SLOT = $Slot
$env:RUN_CURRENT_YEAR_PRIORITY_SCAN = if ($CurrentYearPriority) { 'true' } else { 'false' }
$env:MAX_CONSECUTIVE_EMPTY = '500'
$env:MAX_RUNTIME_MINUTES = '330'
$env:SAFE_STOP_BUFFER_MINUTES = '15'
$env:SCRAPE_ATTEMPT_TIMEOUT_MS = '60000'
$env:BROWSER_MAX_UPTIME_MINUTES = '90'

$mutex = New-Object System.Threading.Mutex($false, 'Local\EchrMonthlyScraper')
if (-not $mutex.WaitOne(0)) {
    "[$(Get-Date -Format o)] Another ECHR scraper run is already active; this slot was skipped." | Add-Content -LiteralPath $logPath
    exit 0
}

try {
    "`n[$(Get-Date -Format o)] Starting local ECHR scraper: slot=$Slot currentYearPriority=$($env:RUN_CURRENT_YEAR_PRIORITY_SCAN)" | Add-Content -LiteralPath $logPath
    Push-Location $scraperRoot
    try {
        & $nodePath d1-target.js 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        & $nodePath monthly-scraper.js 2>&1 | Tee-Object -FilePath $logPath -Append
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}
finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
