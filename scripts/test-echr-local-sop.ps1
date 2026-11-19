[CmdletBinding()]
param(
    [string]$ApplicationNumber = '14852/26'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$scraperRoot = Join-Path $repoRoot 'db-old'

Push-Location $scraperRoot
try {
    $env:APPLICATION_NUMBER = $ApplicationNumber
    @'
const { chromium } = require('playwright');

(async () => {
  const number = process.env.APPLICATION_NUMBER;
  const browser = await chromium.launch({ headless: true, timeout: 30000 });
  try {
    const page = await browser.newPage();
    await page.goto(`https://app.echr.coe.int/SOP/en-GB/application?number=${encodeURIComponent(number)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.locator('#ResultPanel').waitFor({ state: 'visible', timeout: 30000 });
    console.log(`SOP_OK ${number}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
'@ | node
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
