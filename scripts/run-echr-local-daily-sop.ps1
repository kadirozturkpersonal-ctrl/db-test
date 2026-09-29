[CmdletBinding()]
param(
    [switch]$Preflight
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$scraperRoot = Join-Path $repoRoot 'db-old'
$panelEnv = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\.env.local'
$runtimeDir = Join-Path $repoRoot 'local-data'
$logDir = Join-Path $runtimeDir 'logs'
$logPath = Join-Path $logDir ("echr-daily-sop-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
$requiredNames = @('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID')
$notificationNames = @('ECHR_STAGE_NOTIFICATION_URL', 'ECHR_STAGE_NOTIFICATION_CRON_SECRET')
$outcomePath = Join-Path $runtimeDir 'daily-sop-outcome.json'

trap {
    New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir -ErrorAction SilentlyContinue | Out-Null
    "[$(Get-Date -Format o)] Daily SOP runner failed before completion: $($_.Exception.GetType().Name)" | Add-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
    exit 1
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null
$nodePath = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') {
    'C:\Program Files\nodejs\node.exe'
} else {
    (Get-Command node -ErrorAction Stop).Source
}

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

Import-SelectedEnvironmentFile -Path $panelEnv -Names $requiredNames
Import-SelectedEnvironmentFile -Path $panelEnv -Names $notificationNames

foreach ($name in $requiredNames) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
        throw "Gerekli yerel AİHM yapılandırması eksik: $name"
    }
}

# The daily subscription check and the full scraper share one browser/D1 writer.
# Do not overlap them if a delayed daytime run is still in progress.
$mutex = New-Object System.Threading.Mutex($false, 'Local\EchrMonthlyScraper')
if (-not $mutex.WaitOne(0)) {
    "[$(Get-Date -Format o)] Full ECHR scraper is active; daily SOP check skipped." | Add-Content -LiteralPath $logPath
    exit 0
}

try {
    "`n[$(Get-Date -Format o)] Starting local Human Rights Daily SOP Check" | Add-Content -LiteralPath $logPath
    if ($Preflight) {
        "[$(Get-Date -Format o)] Daily SOP runner preflight completed." | Add-Content -LiteralPath $logPath
        exit 0
    }
    Push-Location $scraperRoot
    try {
        & $nodePath d1-target.js 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        Remove-Item -LiteralPath $outcomePath -Force -ErrorAction SilentlyContinue
        $env:DAILY_SOP_OUTCOME_FILE = $outcomePath
        & $nodePath weekly-scraper.js 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        $outcome = if (Test-Path -LiteralPath $outcomePath) { Get-Content -LiteralPath $outcomePath -Raw | ConvertFrom-Json } else { $null }
        if (-not $outcome -or -not $outcome.sourceAvailable) {
            "[$(Get-Date -Format o)] SOP source was unavailable; panel notification queue was not started." | Add-Content -LiteralPath $logPath
            exit 0
        }

        $updateUrl = [Environment]::GetEnvironmentVariable('ECHR_STAGE_NOTIFICATION_URL', 'Process')
        $updateSecret = [Environment]::GetEnvironmentVariable('ECHR_STAGE_NOTIFICATION_CRON_SECRET', 'Process')
        if ([string]::IsNullOrWhiteSpace($updateUrl) -or [string]::IsNullOrWhiteSpace($updateSecret)) {
            "[$(Get-Date -Format o)] Daily SOP check completed, but panel update credentials are not configured." | Add-Content -LiteralPath $logPath
            exit 0
        }

        $endpoint = $updateUrl.TrimEnd('/')
        if (-not $endpoint.EndsWith('/api/human-rights/daily-update', [System.StringComparison]::OrdinalIgnoreCase)) {
            $endpoint = "$endpoint/api/human-rights/daily-update"
        }
        $headers = @{ Authorization = "Bearer $updateSecret" }
        $response = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType 'application/json' -Body '{"dryRun":false}' -TimeoutSec 120
        "[$(Get-Date -Format o)] Panel daily update: action=$($response.action) status=$($response.run.status) phase=$($response.run.phase)" | Add-Content -LiteralPath $logPath

        for ($attempt = 1; $attempt -le 80 -and $response.run.status -eq 'running'; $attempt++) {
            Start-Sleep -Seconds 3
            $body = @{ runId = $response.run.id } | ConvertTo-Json -Compress
            $response = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 120
            "[$(Get-Date -Format o)] Panel daily update: action=$($response.action) status=$($response.run.status) phase=$($response.run.phase)" | Add-Content -LiteralPath $logPath
        }
        if ($response.run.status -eq 'running') {
            "[$(Get-Date -Format o)] Panel daily update is still running; it will resume safely on the next invocation." | Add-Content -LiteralPath $logPath
        }
        exit 0
    }
    finally {
        Pop-Location
    }
}
finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
