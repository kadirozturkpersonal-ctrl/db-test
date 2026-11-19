[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# Same dedicated runtime as the daily task; no D1/SOP queries or email.
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $PSScriptRoot '../local-data/playwright-browsers'
& 'C:\Program Files\nodejs\node.exe' (Join-Path $PSScriptRoot 'echr-browser-runtime.cjs')
exit $LASTEXITCODE
