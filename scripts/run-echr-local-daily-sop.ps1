[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$scraperRoot = Join-Path $repoRoot 'db-old'
$panelEnv = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\.env.local'
$runtimeDir = Join-Path $repoRoot 'local-data'
$logDir = Join-Path $runtimeDir 'logs'
$logPath = Join-Path $logDir ("echr-daily-sop-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
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

# The daily subscription check and the full scraper share one browser/D1 writer.
# Do not overlap them if a delayed daytime run is still in progress.
$mutex = New-Object System.Threading.Mutex($false, 'Local\EchrMonthlyScraper')
if (-not $mutex.WaitOne(0)) {
    "[$(Get-Date -Format o)] Full ECHR scraper is active; daily SOP check skipped." | Add-Content -LiteralPath $logPath
    exit 0
}

try {
    "`n[$(Get-Date -Format o)] Starting local Human Rights Daily SOP Check" | Add-Content -LiteralPath $logPath
    Push-Location $scraperRoot
    try {
        & $nodePath d1-target.js 2>&1 | Tee-Object -FilePath $logPath -Append
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        & $nodePath weekly-scraper.js 2>&1 | Tee-Object -FilePath $logPath -Append
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
