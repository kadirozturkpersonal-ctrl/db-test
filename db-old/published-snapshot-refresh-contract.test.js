const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'scrape-echr.yml');

test('a completed scraper run requires published snapshot refresh instead of accepting a missing endpoint', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /Refresh HukukiPanel AİHM published data/);
    assert.match(workflow, /api\/echr-db\/refresh\?wait=1/);
    assert.match(workflow, /preflight_status.*!=.*200/);
    assert.doesNotMatch(workflow, /preflight_status.*=.*404[\s\S]{0,250}exit 0/);
    assert.match(workflow, /tarama başarılı sayılmaz/);
});
