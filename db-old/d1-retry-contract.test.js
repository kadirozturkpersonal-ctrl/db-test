const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('D1 query and import clients retry only transient Cloudflare responses', () => {
    const adapter = fs.readFileSync(path.join(__dirname, 'd1-adapter.js'), 'utf8');
    const importer = fs.readFileSync(path.join(__dirname, 'd1-import-api.js'), 'utf8');

    for (const source of [adapter, importer]) {
        assert.match(source, /fetchWithRetry\(/);
        assert.match(source, /\[408, 429, 500, 502, 503, 504\]/);
        assert.match(source, /AbortController/);
    }
});

test('nightly SOP writes stamp last_checked_date with the Istanbul business date', () => {
    const adapter = fs.readFileSync(path.join(__dirname, 'd1-adapter.js'), 'utf8');
    const weeklyScraper = fs.readFileSync(path.join(__dirname, 'weekly-scraper.js'), 'utf8');

    assert.match(adapter, /const ISTANBUL_SQL_DATE = "DATE\('now', '\+3 hours'\)"/);
    assert.match(adapter, /last_checked_date = \$\{ISTANBUL_SQL_DATE\}/);
    assert.match(weeklyScraper, /last_checked_date = \$\{ISTANBUL_SQL_DATE\}/);
    assert.doesNotMatch(adapter, /last_checked_date = DATE\('now'\)/);
    assert.doesNotMatch(weeklyScraper, /last_checked_date = DATE\('now'\)/);
});
