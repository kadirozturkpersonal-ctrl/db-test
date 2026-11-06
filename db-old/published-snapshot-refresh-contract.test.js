const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'scrape-echr.yml');

test('a completed scraper run refreshes a published snapshot when available and tolerates the legacy direct-D1 panel', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /Refresh HukukiPanel AİHM published data/);
    assert.match(workflow, /api\/echr-db\/refresh\?wait=1/);
    assert.match(workflow, /preflight_status.*!=.*200/);
    assert.match(workflow, /preflight_status.*=.*404[\s\S]{0,500}exit 0/);
    assert.match(workflow, /Cloudflare D1'den doğrudan okuyor/);
    assert.match(workflow, /steps\.published_snapshot\.outputs\.available == 'true'/);
	assert.match(workflow, /D1 tarama verisi kaydedildi; panel yenilemesi sonraki run'da yeniden denenecek/);
	// Dirty-checkout and concurrent-checkpoint behavior is exercised against
	// real local Git repositories by scripts/persist-scraper-checkpoint.test.cjs.
	assert.match(workflow, /SCRAPER_RUN_SOURCE: 'github-actions'/);
	assert.match(workflow, /SCRAPER_RUN_SOURCE_REFERENCE: \$\{\{ github\.server_url \}\}/);
});
