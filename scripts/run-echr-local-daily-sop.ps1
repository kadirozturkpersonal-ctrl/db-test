[CmdletBinding()]
param([switch]$Preflight, [switch]$RecoverToday, [ValidateRange(15,240)][int]$RecoveryMinutes = 120)

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
foreach ($line in [System.IO.File]::ReadAllLines($panelEnv, [System.Text.Encoding]::UTF8)) {
    $separator = $line.IndexOf('=')
    if ($separator -lt 1) { continue }
    $settingName = $line.Substring(0, $separator).Trim()
    if ($allowedNames -contains $settingName) {
        $settingValue = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($settingName, $settingValue, 'Process')
    }
}
$nodePath = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { (Get-Command node -ErrorAction Stop).Source }
# Use Playwright's version-matched headless browser, not auto-updating desktop Chrome.
$supervisor = Join-Path $PSScriptRoot 'echr-daily-supervisor.cjs'
if ($Preflight) { & $nodePath $supervisor --preflight; exit $LASTEXITCODE }
$istanbulNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'Turkey Standard Time')
$nextMidnight = [DateTimeOffset]::new($istanbulNow.Date.AddDays(1), [TimeSpan]::FromHours(3))
$deadline = [DateTimeOffset]::new($istanbulNow.Date.AddHours(3).AddMinutes(57), [TimeSpan]::FromHours(3))
if ($RecoverToday) {
    # Explicit recovery keeps today's checkpoint/run and cannot cross midnight.
    $deadline = $istanbulNow.AddMinutes($RecoveryMinutes)
    if ($deadline -gt $nextMidnight) { $deadline = $nextMidnight }
} elseif ($istanbulNow -ge $deadline) {
    throw 'Gece suresi doldu. Bugunun ayni kaydini surdurmek icin acikca -RecoverToday kullanin.'
}
$env:DAILY_SOP_DEADLINE = $deadline.ToString('o')
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
