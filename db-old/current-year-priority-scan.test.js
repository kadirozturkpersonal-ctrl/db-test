const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MonthlyECHRScraper } = require('./monthly-scraper');

test('06:00 scan measures D1 max, checks the next year, then lets the historical cycle continue', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [{ max_number: 16569 }];
            }
        },
        runCurrentYearPriorityScan: true,
        currentYearPriorityEndHour: 24,
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
    assert.equal(result.stopRun, false);
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

test('a run records its execution source without relabelling earlier D1 history', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [];
            }
        },
        runId: 'github-run',
        scheduleSlot: '12:00',
        runSource: 'github-actions',
        runSourceReference: 'https://github.com/example/repo/actions/runs/123'
    });

    await scraper.startScrapeRun();

    const insert = queries.find(query => /INSERT INTO echr_scraper_runs/.test(query.sql));
    assert.ok(insert);
    assert.match(queries.map((query) => query.sql).join('\n'), /run_source TEXT NOT NULL DEFAULT 'unspecified'/);
    assert.deepEqual(insert.params, [
        'github-run', '12:00', 'historical-cycle', 'github-actions',
        'https://github.com/example/repo/actions/runs/123', null, insert.params.at(-1)
    ]);
});

test('a local cycle records a replaceable phase snapshot for aggregation across restarts', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [];
            }
        },
        runId: 'local-cycle-run',
        runSource: 'local-windows-task',
        logicalCycleId: 'local-2026-09-30',
    });
    await scraper.startScrapeRun();
    scraper.recordScannedApplication('100/26');
    scraper.stats.totalChecked = 25;
    await scraper.queueProgressUpdate();

    const cycleMetric = queries.find((query) => /INSERT INTO echr_scraper_cycle_phase_metrics/.test(query.sql));
    assert.ok(cycleMetric);
    assert.equal(cycleMetric.params[0], 'local-2026-09-30');
    assert.equal(cycleMetric.params[1], 'local-cycle-run');
    assert.equal(cycleMetric.params[2], 'local-windows-task');
    assert.equal(cycleMetric.params[3], 'historical-cycle');
    assert.match(cycleMetric.sql, /ON CONFLICT\(cycle_id, run_id, phase\) DO UPDATE/);
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

test('an active scraper run persists its live checkpoint and speed for the panel', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [];
            }
        },
        runId: 'live-run',
        scheduleSlot: '12:00'
    });
    scraper.recordScannedApplication('14852/26');
    scraper.stats.totalChecked = 25;
    await scraper.startScrapeRun();

    const progress = queries.find(query => /UPDATE echr_scraper_runs[\s\S]*last_heartbeat_at/.test(query.sql));
    assert.ok(progress);
    assert.equal(progress.params[0], '14852/26');
    assert.equal(progress.params.at(-1), 'live-run');
});

test('a completed phase keeps its own final range and D1 counters for the panel', async () => {
    const queries = [];
    const scraper = new MonthlyECHRScraper({
        d1: {
            async querySQL(sql, params = []) {
                queries.push({ sql, params });
                return [];
            }
        },
        runId: 'phase-run',
        scheduleSlot: '06:00',
        runCurrentYearPriorityScan: true,
    });
    await scraper.startScrapeRun();
    scraper.recordScannedApplication('28652/26');
    scraper.recordScannedApplication('28883/26');
    scraper.stats.totalChecked = 245;
    scraper.newApplicationsAdded = 3;
    scraper.stats.d1Saved = 29;
    scraper.stats.errors = 1;

    await scraper.completePhaseTelemetry('current-year-priority');

    const summary = queries.find((query) => /INSERT INTO echr_scraper_phase_summaries/.test(query.sql));
    assert.ok(summary);
    assert.deepEqual(summary.params.slice(0, 6), [
        'phase-run', 'current-year-priority', summary.params[2], summary.params[3], '28652/26', '28883/26'
    ]);
    assert.deepEqual(summary.params.slice(6), [245, summary.params[7], 3, 29, 1]);
});

test('the historical phase records its own first application after the priority phase', () => {
    const scraper = new MonthlyECHRScraper({
        d1: {},
        runCurrentYearPriorityScan: true,
    });
    scraper.beginPhaseTelemetry('current-year-priority');
    scraper.recordScannedApplication('28652/26');
    scraper.recordScannedApplication('15930/26');

    scraper.currentPhase = 'historical-cycle';
    scraper.beginPhaseTelemetry('historical-cycle', true);
    scraper.recordScannedApplication('15931/26');

    const historical = scraper.getPhaseTelemetry('historical-cycle');
    assert.equal(historical.firstApplicationNumber, '15931/26');
    assert.equal(historical.currentApplicationNumber, '15931/26');
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

test('a stalled Playwright attempt is bounded and its browser is discarded', async () => {
    let closeCalls = 0;
    const scraper = new MonthlyECHRScraper({
        d1: {},
        scrapeAttemptTimeoutMs: 5,
        createBrowser: async () => ({
            close: async () => { closeCalls++; }
        }),
        scrapeApplication: async () => new Promise(() => {})
    });

    await assert.rejects(
        scraper.scrapeWithDeadline(1, '26'),
        /SOP attempt exceeded 5ms/
    );
    assert.equal(closeCalls, 1);
    assert.equal(scraper.browser, null);
});

test('a Chromium launch failure is treated as temporary and does not become an empty SOP result', async () => {
    const scraper = new MonthlyECHRScraper({
        d1: {},
        createBrowser: async () => { throw new Error('browser unavailable'); }
    });

    await assert.rejects(
        scraper.scrapeWithDeadline(1, '26'),
        error => error.temporary === true && /Could not launch Chromium/.test(error.message)
    );
});

test('a scheduled priority scan defers after sustained technical errors instead of failing the workflow', async () => {
    const scraper = new MonthlyECHRScraper({ d1: {} });
    scraper.scrapeWithDeadline = async () => {
        const error = new Error('SOP unavailable');
        error.temporary = true;
        throw error;
    };
    scraper.sleep = async () => {};

    const result = await scraper.scanScheduledYearDirection({
        year: 2026,
        startNumber: 1,
        direction: 1,
        phase: 'current-year-forward'
    });

    assert.deepEqual(result, { completed: false, runtimeLimit: false, deferred: true });
    assert.equal(scraper.stats.errors, 5);
    assert.equal(scraper.stats.notFound, 0);
});

test('the normal cycle keeps its checkpoint on a temporary SOP failure', async () => {
    const reasons = [];
    const scraper = new MonthlyECHRScraper({ d1: {} });
    scraper.startScrapeRun = async () => {};
    scraper.loadState = () => {
        scraper.state = { version: 1, currentYear: 2016, currentNumber: 42, consecutiveEmpty: 0 };
    };
    scraper.saveState = reason => reasons.push(reason);
    scraper.loadFinalizedApplicationNumbers = async () => {};
    scraper.prepareAdministrativeRejectionTracking = async () => {};
    scraper.scrapeWithDeadline = async () => {
        const error = new Error('SOP unavailable');
        error.temporary = true;
        throw error;
    };
    scraper.flushBatch = async () => {};
    scraper.printFinalStats = () => {};
    scraper.finishScrapeRun = async () => {};
    scraper.persistPortfolioStageChanges = () => {};

    await scraper.run();

    assert.equal(scraper.state.currentNumber, 42);
    assert.ok(reasons.includes('temporary-source-error'));
    assert.equal(scraper.stats.notFound, 0);
});
