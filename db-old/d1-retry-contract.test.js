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

    assert.match(adapter, /function getIstanbulBusinessDate\(date = new Date\(\)\)/);
    assert.match(adapter, /const ISTANBUL_SQL_DATE = `'?\$\{getIstanbulBusinessDate\(\)\}'?`/);
    assert.match(adapter, /last_checked_date = \$\{ISTANBUL_SQL_DATE\}/);
    assert.match(weeklyScraper, /last_checked_date = \$\{ISTANBUL_SQL_DATE\}/);
    assert.match(weeklyScraper, /function getIstanbulDate\(\)/);
    assert.match(weeklyScraper, /verifyDailyD1Writes\(\)/);
    assert.match(weeklyScraper, /D1 Istanbul tarih dogrulamasi basarisiz/);
    assert.doesNotMatch(adapter, /DATE\('now', '\+3 hours'\)/);
    assert.doesNotMatch(weeklyScraper, /last_checked_date = DATE\('now'\)/);
});

test('the Istanbul business-date literal changes across midnight', () => {
    const { getIstanbulBusinessDate } = require('./d1-adapter');

    assert.equal(getIstanbulBusinessDate(new Date('2026-10-14T20:59:59.000Z')), '2026-10-14');
    assert.equal(getIstanbulBusinessDate(new Date('2026-10-14T21:00:00.000Z')), '2026-10-15');
});
