[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
if ((Get-TimeZone).BaseUtcOffset.TotalHours -ne 3) { throw 'Bu gorev Turkiye saat diliminde kurulmalidir.' }
$runner = Join-Path $PSScriptRoot 'run-echr-local-daily-sop.ps1'
$launcher = 'C:\Users\kadir\Projects\hukuki-is-dosya-yonetim-paneli\scripts\run-hidden-powershell.vbs'
if (-not (Test-Path -LiteralPath $runner) -or -not (Test-Path -LiteralPath $launcher)) { throw 'Gizli gunluk calistirici bulunamadi.' }
$command = '"{0}" "{1}" "{2}"' -f "$env:WINDIR\System32\wscript.exe", $launcher, $runner
$firstRunDate = (Get-Date).Date.AddDays(1).ToString('dd/MM/yyyy')
# Install tomorrow's schedule without launching an unrequested daytime scan.
& schtasks.exe /Create /TN 'ECHR Daily SOP Check - 0000' /TR $command /SC DAILY /SD $firstRunDate /ST '00:00' /RI 10 /DU 01:57 /RU $env:USERNAME /IT /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Gunluk SOP gorevi kurulamadi.' }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) -ExecutionTimeLimit (New-TimeSpan -Hours 1 -Minutes 50)
Set-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0000' -Settings $settings | Out-Null
# Keep the former task recoverable, but never leave both schedules enabled.
if (Get-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0007' -ErrorAction SilentlyContinue) {
    Disable-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0007' | Out-Null
}
Get-ScheduledTask -TaskName 'ECHR Daily SOP Check - 0000' | Select-Object TaskName,State,Triggers,Settings
