[CmdletBinding()]
param([switch]$Preflight)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$panelEnv = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\.env.local'
$runtimeDir = Join-Path $repoRoot 'local-data'
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runnerLog = Join-Path $logDir ("echr-daily-launcher-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))
trap {
    ($_ | Format-List * -Force | Out-String) | Add-Content -LiteralPath $runnerLog -Encoding UTF8
    exit 1
}

$allowedNames = @('CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_D1_DATABASE_ID',
    'ECHR_STAGE_NOTIFICATION_URL','ECHR_STAGE_NOTIFICATION_CRON_SECRET',
    'HUMAN_RIGHTS_DAILY_UPDATE_URL','HUMAN_RIGHTS_DAILY_UPDATE_CRON_SECRET')
foreach ($line in (Get-Content -LiteralPath $panelEnv)) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$' -and $allowedNames -contains $matches[1]) {
        $settingName = $matches[1]
        $settingValue = $matches[2].Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($settingName, $settingValue, 'Process')
    }
}
$nodePath = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node -ErrorAction Stop).Source }
if (Test-Path -LiteralPath 'C:\Program Files\Google\Chrome\Application\chrome.exe') {
    $env:ECHR_BROWSER_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}
$supervisor = Join-Path $PSScriptRoot 'echr-daily-supervisor.cjs'
if ($Preflight) { & $nodePath $supervisor --preflight; exit $LASTEXITCODE }
$env:DAILY_SOP_DEADLINE = (Get-Date).Date.AddHours(1).AddMinutes(57).ToString('o')
$mutex = New-Object System.Threading.Mutex($false, 'Local\EchrMonthlyScraper')
$ownsMutex = $false
try {
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) {
        "[$(Get-Date -Format o)] Browser/D1 writer busy; task must retry, not report success." | Add-Content -LiteralPath $runnerLog -Encoding UTF8
        exit 75
    }
    # The supervisor owns stdout/stderr files; no PowerShell native-output pipeline.
    & $nodePath $supervisor
    exit $LASTEXITCODE
}
finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() | Out-Null }
    $mutex.Dispose()
}
