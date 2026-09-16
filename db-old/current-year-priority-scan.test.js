const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MonthlyECHRScraper } = require('./monthly-scraper');

test('06:00 current-year scan measures D1 max and starts exactly 500 numbers behind it', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [{ max_number: 16569 }];
            }
        },
        runCurrentYearPriorityScan: true,
        scrapeApplication: async () => null
    });
    scraper.browser = {};
    scraper.flushBatch = async () => {};
    scraper.sleep = async () => {};
    let checks = 0;
    scraper.shouldStopBeforeNextAttempt = () => checks++ > 0;

    const result = await scraper.processScheduledCurrentYearScan();
    assert.equal(result.handled, true);
    assert.equal(scraper.stats.totalChecked, 1);
    assert.match(queries[0].sql, /MAX\(/);
    assert.deepEqual(queries[0].params, [`%/${String(new Date().getFullYear()).slice(-2)}`]);
    assert.match(fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8'), /observedMax - CURRENT_YEAR_PRIORITY_OVERLAP_SIZE/);
});

test('scheduled current-year scan has no queue table, status row, or resume call', () => {
    const source = fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8');
    assert.doesNotMatch(source, /CurrentScanQueue|currentScanQueue|echr_current_scan_requests/);
    assert.match(source, /processScheduledCurrentYearScan\(\)/);
    assert.match(source, /runCurrentYearPriorityScan === true/);
    assert.match(source, /CURRENT_YEAR_PRIORITY_MAX_EMPTY/);
});

test('the normal 2016-to-present cycle is unchanged outside the 06:00 direct scan', () => {
    const source = fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8');
    assert.match(source, /const START_YEAR = 2016/);
    assert.match(source, /while \(!stopReason\)/);
    assert.doesNotMatch(source, /processPriorityScan/);
});
