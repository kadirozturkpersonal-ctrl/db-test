const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    CurrentScanQueue,
    calculatePriorityStart,
    shouldCompletePriorityScan
} = require('./current-scan-queue');
const { MonthlyECHRScraper } = require('./monthly-scraper');

test('priority scan starts exactly 500 numbers behind the current D1 maximum', () => {
    assert.equal(calculatePriorityStart(16569), 16069);
    assert.equal(calculatePriorityStart(400), 1);
});

test('priority scan completes only after the observed maximum and 500 real empty results', () => {
    assert.equal(shouldCompletePriorityScan(17070, 16569, 500), true);
    assert.equal(shouldCompletePriorityScan(16569, 16569, 500), false);
    assert.equal(shouldCompletePriorityScan(17070, 16569, 499), false);
});

test('claim recomputes the current-year maximum and stores max minus 500', async () => {
    const calls = [];
    const d1 = {
        async querySQL(sql, params = []) {
            calls.push({ sql, params });
            if (sql.includes("WHERE active_key = 'current-year'")) {
                return [{ id: 7, status: 'pending', requested_at: '2026-07-17T00:00:00.000Z' }];
            }
            if (sql.includes('AS max_number')) return [{ max_number: 16569 }];
            return [];
        }
    };
    const queue = new CurrentScanQueue(d1);
    const request = await queue.claimOrResume();
    assert.equal(request.observed_max_number, 16569);
    assert.equal(request.start_number, 16069);
    assert.equal(request.current_number, 16069);
    const update = calls.find(call => call.sql.includes("SET status = 'running'"));
    assert.deepEqual(update.params.slice(0, 4), [new Date().getFullYear(), 16569, 16069, 16069]);
});

test('a running request resumes from its saved number without measuring a new maximum', async () => {
    let queryCount = 0;
    const d1 = {
        async querySQL(sql) {
            queryCount++;
            if (sql.includes("WHERE active_key = 'current-year'")) {
                return [{
                    id: 8,
                    status: 'running',
                    target_year: 2026,
                    observed_max_number: 16569,
                    start_number: 16069,
                    current_number: 16250,
                    consecutive_empty: 12,
                    found_count: 90,
                    checked_count: 181,
                    technical_error_count: 2
                }];
            }
            return [];
        }
    };
    const queue = new CurrentScanQueue(d1);
    const request = await queue.claimOrResume();
    assert.equal(request.current_number, 16250);
    assert.equal(request.consecutive_empty, 12);
    assert.equal(queryCount, 3); // schema, index, active request; no MAX query
});

test('technical scrape errors retain the number, empty counter, and long-cycle checkpoint', async () => {
    let savedProgress = null;
    const currentScanQueue = {
        async claimOrResume() {
            return {
                id: 9,
                status: 'running',
                target_year: 2026,
                observed_max_number: 16569,
                start_number: 16069,
                current_number: 16250,
                consecutive_empty: 12,
                found_count: 90,
                checked_count: 181,
                technical_error_count: 2
            };
        },
        async saveProgress(_request, progress) {
            savedProgress = { ...progress };
        },
        async complete() {
            throw new Error('must not complete');
        }
    };
    const scraper = new MonthlyECHRScraper({
        d1: {},
        currentScanQueue,
        scrapeApplication: async () => { throw new Error('temporary network failure'); }
    });
    scraper.browser = {};
    scraper.state = { currentYear: 2021, currentNumber: 777, consecutiveEmpty: 4 };
    scraper.sleep = async () => {};
    let stopChecks = 0;
    scraper.shouldStopBeforeNextAttempt = () => stopChecks++ > 0;

    await scraper.processPriorityScan('test');
    assert.equal(savedProgress.currentNumber, 16250);
    assert.equal(savedProgress.consecutiveEmpty, 12);
    assert.equal(savedProgress.technicalErrorCount, 3);
    assert.deepEqual(scraper.state, { currentYear: 2021, currentNumber: 777, consecutiveEmpty: 4 });
});

test('scraper contract keeps the long checkpoint separate and checks priority after a 250 batch', () => {
    const source = fs.readFileSync(path.join(__dirname, 'monthly-scraper.js'), 'utf8');
    assert.match(source, /this\.BATCH_ATTEMPTS = 250/);
    assert.match(source, /saveState\('batch-flush'\);\s*const priority = await this\.processPriorityScan\('after-saved-batch'\)/);
    assert.doesNotMatch(source, /saveState\([^)]*priority/i);
    assert.match(source, /technical error[\s\S]*empty-result counter is unchanged/i);
});
