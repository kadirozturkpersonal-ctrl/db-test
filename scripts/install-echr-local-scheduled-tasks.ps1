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
    -ExecutionTimeLimit (New-TimeSpan -Hours 5 -Minutes 45)

$definitions = @(
    # A colon is not valid in a Windows Task Scheduler task name.
    @{ Name = 'ECHR Scraper - 0600'; Time = '06:00'; CurrentYear = $true },
    @{ Name = 'ECHR Scraper - 1200'; Time = '12:00'; CurrentYear = $false },
    @{ Name = 'ECHR Scraper - 1800'; Time = '18:00'; CurrentYear = $false }
)

foreach ($definition in $definitions) {
    $arguments = '"{0}" "{1}" -Slot "{2}"' -f $hiddenLauncher, $runner, $definition.Time
    if ($definition.CurrentYear) { $arguments += ' -CurrentYearPriority' }
    # schtasks creates the same InteractiveToken task type as the existing
    # local automation on this computer. Register-ScheduledTask rejects that
    # principal form on this Windows installation.
    $taskCommand = '"{0}" {1}' -f "$env:WINDIR\System32\wscript.exe", $arguments
    & schtasks.exe /Create /TN $definition.Name /TR $taskCommand /SC DAILY /ST $definition.Time /RU $env:USERNAME /IT /RL LIMITED /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Görev oluşturulamadı: $($definition.Name)" }
    Set-ScheduledTask -TaskName $definition.Name -Settings $settings | Out-Null
}

# Mirrors the GitHub daily subscription-stage check at 00:07 Istanbul, while
# avoiding the top-of-hour window and sharing the same overlap protection.
$dailySopArguments = '"{0}" "{1}"' -f $hiddenLauncher, $dailySopRunner
$dailySopCommand = '"{0}" {1}' -f "$env:WINDIR\System32\wscript.exe", $dailySopArguments
& schtasks.exe /Create /TN 'ECHR Daily SOP Check - 0007' /TR $dailySopCommand /SC DAILY /ST '00:07' /RU $env:USERNAME /IT /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Günlük SOP görevi oluşturulamadı.' }
Set-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0007' -Settings $settings | Out-Null

Get-ScheduledTask -TaskName 'ECHR Scraper -*', 'ECHR Daily SOP Check - 0007' | Select-Object TaskName, State
