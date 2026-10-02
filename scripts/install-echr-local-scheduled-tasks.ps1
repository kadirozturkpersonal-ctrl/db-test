[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-echr-local-scraper.ps1'
$dailySopRunner = Join-Path $PSScriptRoot 'run-echr-local-daily-sop.ps1'
$hiddenLauncher = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\scripts\run-hidden-powershell.vbs'

if (-not (Test-Path -LiteralPath $runner)) { throw "Çalıştırıcı bulunamadı: $runner" }
if (-not (Test-Path -LiteralPath $dailySopRunner)) { throw "Günlük SOP çalıştırıcısı bulunamadı: $dailySopRunner" }
if (-not (Test-Path -LiteralPath $hiddenLauncher)) { throw "Gizli çalıştırıcı bulunamadı: $hiddenLauncher" }

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 22)

# The daily task starts at 00:07. Keep a three-minute hand-off margin
# before the 02:00 main scraper slot without cutting into ordinary runs.
$dailySopSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1 -Minutes 50)

$definitions = @(
    # A colon is not valid in a Windows Task Scheduler task name.  This single
    # This continuous run begins at 02:00, gives current-year checks until
    # 06:00, then continues its historical checkpoint cycle until 23:45.
    @{ Name = 'ECHR Scraper - 0200'; Time = '02:00'; CurrentYear = $true; PriorityEndHour = 6 }
)

# Retire the two former slots so they cannot create a second browser session
# or duplicate requests during the continuous daytime run.
foreach ($legacyTask in 'ECHR Scraper - 0600', 'ECHR Scraper - 1200', 'ECHR Scraper - 1800') {
    if (Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $legacyTask -Confirm:$false
    }
}

foreach ($definition in $definitions) {
    $arguments = '"{0}" "{1}" -Slot "{2}"' -f $hiddenLauncher, $runner, $definition.Time
    if ($definition.CurrentYear) { $arguments += " -CurrentYearPriority -CurrentYearPriorityEndHour $($definition.PriorityEndHour)" }
    # schtasks creates the same InteractiveToken task type as the existing
    # local automation on this computer. Register-ScheduledTask rejects that
    # principal form on this Windows installation.
    $taskCommand = '"{0}" {1}' -f "$env:WINDIR\System32\wscript.exe", $arguments
    # Re-trigger every ten minutes throughout the daytime window.  When the
    # scraper is healthy, IgnoreNew keeps this to one process.  If a network,
    # browser, or power interruption ends that process, the following trigger
    # resumes from its local checkpoint instead of waiting for the next day.
    & schtasks.exe /Create /TN $definition.Name /TR $taskCommand /SC DAILY /ST $definition.Time /RI 10 /DU 21:45 /RU $env:USERNAME /IT /RL LIMITED /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Görev oluşturulamadı: $($definition.Name)" }
    Set-ScheduledTask -TaskName $definition.Name -Settings $settings | Out-Null
}

# Mirrors the GitHub daily subscription-stage check at 00:07 Istanbul, while
# avoiding the top-of-hour window and sharing the same overlap protection.
$dailySopArguments = '"{0}" "{1}"' -f $hiddenLauncher, $dailySopRunner
$dailySopCommand = '"{0}" {1}' -f "$env:WINDIR\System32\wscript.exe", $dailySopArguments
& schtasks.exe /Create /TN 'ECHR Daily SOP Check - 0007' /TR $dailySopCommand /SC DAILY /ST '00:07' /RU $env:USERNAME /IT /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Günlük SOP görevi oluşturulamadı.' }
Set-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0007' -Settings $dailySopSettings | Out-Null

Get-ScheduledTask -TaskName 'ECHR Scraper -*', 'ECHR Daily SOP Check - 0007' | Select-Object TaskName, State
