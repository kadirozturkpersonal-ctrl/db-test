const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MonthlyECHRScraper } = require('./monthly-scraper');

test('06:00 scan measures D1 max, checks the next year, then reverses from M-501', async () => {
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
    const phases = [];
    scraper.scanScheduledYearDirection = async (input) => {
        phases.push(input);
        return { completed: true, runtimeLimit: false };
    };

    const result = await scraper.processScheduledCurrentYearScan();
    assert.equal(result.handled, true);
    assert.equal(result.stopRun, true);
    assert.match(queries[0].sql, /MAX\(/);
    assert.deepEqual(queries[0].params, [`%/${String(new Date().getFullYear()).slice(-2)}`]);
    assert.deepEqual(phases.map(phase => [phase.year, phase.startNumber, phase.direction, phase.stopAfterConsecutiveEmpty || null]), [
        [new Date().getFullYear(), 16069, 1, 500],
        [new Date().getFullYear() + 1, 1, 1, 500],
        [new Date().getFullYear(), 16068, -1, null]
    ]);
    assert.match(fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8'), /observedMax - CURRENT_YEAR_PRIORITY_OVERLAP_SIZE/);
});

test('scheduled current-year scan has no queue table, status row, or resume call', () => {
    const source = fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8');
    assert.doesNotMatch(source, /CurrentScanQueue|currentScanQueue|echr_current_scan_requests/);
    assert.match(source, /processScheduledCurrentYearScan\(\)/);
    assert.match(source, /runCurrentYearPriorityScan === true/);
    assert.match(source, /CURRENT_YEAR_PRIORITY_MAX_EMPTY/);
    assert.match(source, /const nextYear = targetYear \+ 1/);
    assert.match(source, /const backwardStart = startNumber - 1/);
    assert.match(source, /direction: -1/);
});

test('the normal 2016-to-present cycle is unchanged outside the 06:00 direct scan', () => {
    const source = fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8');
    assert.match(source, /const START_YEAR = 2016/);
    assert.match(source, /while \(!stopReason\)/);
    assert.doesNotMatch(source, /processPriorityScan/);
});
