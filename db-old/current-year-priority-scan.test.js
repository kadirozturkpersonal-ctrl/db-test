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

test('each scraper run records only application numbers absent before its D1 write', async () => {
    const queries = [];
    let lookup = 0;
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                if (sql.startsWith('SELECT application_number')) {
                    lookup++;
                    return lookup === 1 ? [{ application_number: '100/26' }] : [{ application_number: '101/26' }];
                }
                return [];
            },
            async saveBatch() { return { success: 2, failed: 0 }; },
            async saveSOPNoInfoBatch() { return { success: 0, failed: 0 }; }
        },
        runId: 'run-1',
        scheduleSlot: '06:00'
    });
    scraper.batchQueue = [{ applicationNumber: '100/26' }, { applicationNumber: '101/26' }];
    await scraper.flushBatch();
    assert.equal(scraper.newApplicationsAdded, 1);
    await scraper.startScrapeRun();
    await scraper.finishScrapeRun();
    assert.match(queries.map((query) => query.sql).join('\n'), /CREATE TABLE IF NOT EXISTS echr_scraper_runs/);
    assert.match(queries.map((query) => query.sql).join('\n'), /new_applications_added/);
});

test('scraper history preserves the smallest and largest actually attempted application numbers', async () => {
    const scraper = new MonthlyECHRScraper({ d1: {} });
    scraper.recordScannedApplication('300/27');
    scraper.recordScannedApplication('20/26');
    scraper.recordScannedApplication('999/26');
    assert.equal(scraper.smallestScannedApplicationNumber, '20/26');
    assert.equal(scraper.largestScannedApplicationNumber, '300/27');
    assert.equal(scraper.compareApplicationNumbers('999/26', '1/27') < 0, true);
});

test('existing-number lookup stays below the Cloudflare D1 bind-variable limit', async () => {
    const lookups = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                lookups.push({ sql, params });
                return params.slice(0, 1).map(application_number => ({ application_number }));
            }
        }
    });
    const numbers = Array.from({ length: 105 }, (_, index) => `${index + 1}/24`);
    const existing = await scraper.loadExistingApplicationNumbers(numbers);
    assert.deepEqual(lookups.map(lookup => lookup.params.length), [50, 50, 5]);
    assert.equal(existing.size, 3);
    assert.match(lookups[0].sql, /application_number IN \(\?, \?/);
});
