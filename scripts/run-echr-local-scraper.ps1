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

New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null
$nodePath = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') {
    'C:\Program Files\nodejs\node.exe'
} else {
    (Get-Command node -ErrorAction Stop).Source
}

function Import-SelectedEnvironmentFile {
    param([string]$Path, [string[]]$AllowedNames)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Yerel AİHM yapılandırması bulunamadı: $Path"
    }

    $lines = Get-Content -LiteralPath $Path
    foreach ($environmentName in $AllowedNames) {
        $escapedName = [regex]::Escape($environmentName)
        $line = $lines | Where-Object { $_ -match "^\s*$escapedName\s*=\s*(?<value>.*)\s*$" } | Select-Object -Last 1
        if ($null -eq $line) { continue }
        $null = $line -match "^\s*$escapedName\s*=\s*(?<value>.*)\s*$"
        $value = $matches.value.Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($environmentName, $value, 'Process')
    }
}

Import-SelectedEnvironmentFile -Path $panelEnv -AllowedNames $requiredNames

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
