const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WeeklyECHRScraper } = require('./weekly-scraper');
const { readCheckpoint, writeJsonAtomic } = require('./daily-sop-checkpoint');
const { D1Adapter } = require('./d1-adapter');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-sop-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const previous = process.env.DAILY_SOP_CHECKPOINT_FILE;
    process.env.DAILY_SOP_CHECKPOINT_FILE = path.join(directory, 'checkpoint.json');
    t.after(() => { if (previous === undefined) delete process.env.DAILY_SOP_CHECKPOINT_FILE; else process.env.DAILY_SOP_CHECKPOINT_FILE = previous; });
    return directory;
}

test('a failed case preserves successful progress and retry scans only unfinished cases', async t => {
    fixture(t);
    const calls = [];
    const saved = [];
    let fail = true;
    const dependencies = {
        d1: { querySQL: async () => [], saveDailyApplication: async row => { saved.push(row.applicationNumber); return { success: 1, failed: 0 }; } },
        createBrowser: async () => ({ close: async () => {} }),
        scrapeApplication: async (_browser, number, year) => {
            calls.push(`${number}/${year}`);
            if (number === '2' && fail) throw new Error('simulated process/write interruption');
            return { applicationNumber: `${number}/${year}`, lastMajorEvent: 'Pending' };
        },
    };
    const make = () => {
        const scraper = new WeeklyECHRScraper('echr-db', dependencies);
        scraper.getSubscribedCases = async () => ['1/26', '2/26'].map(application_number => ({ application_number, current_event: 'Pending' }));
        scraper.sleep = async () => {};
        return scraper;
    };
    const first = make();
    await assert.rejects(first.run(), /1\/2/);
    assert.equal(readCheckpoint(first.checkpointFile, today()).results.length, 1);
    fail = false;
    const resumed = make();
    await resumed.run();
    assert.deepEqual(calls, ['1/26', '2/26', '2/26']);
    assert.deepEqual(saved, ['1/26', '2/26']);
    assert.equal(resumed.runId, first.runId);
    assert.equal(resumed.processedCount, 2);
    assert.equal(resumed.stats.errors, 0);
});

test('panel manifest excludes every record outside the approved daily pool', async t => {
    const directory = fixture(t);
    const scopeFile = path.join(directory, 'scope.json');
    writeJsonAtomic(scopeFile, { date: today(), applicationNumbers: ['1/26', '2/26'] });
    const params = [];
    const scraper = new WeeklyECHRScraper('echr-db', { d1: { querySQL: async (sql, values) => { params.push(values); assert.doesNotMatch(sql, /FROM subscriptions/); return [{ application_number: '1/26', current_event: 'Pending' }]; } } });
    scraper.scopeFile = scopeFile;
    assert.deepEqual((await scraper.getSubscribedCases()).map(row => row.application_number), ['1/26', '2/26']);
    assert.deepEqual(params, [['1/26', '2/26']]);
    writeJsonAtomic(scopeFile, { date: '2000-01-01', applicationNumbers: ['1/26'] });
    await assert.rejects(scraper.getSubscribedCases(), /current Istanbul date/);
});

test('browser startup failure finalizes the run as failed', async t => {
    fixture(t);
    const statuses = [];
    const scraper = new WeeklyECHRScraper('echr-db', {
        d1: { querySQL: async (sql, params) => { if (/^UPDATE echr_scraper_runs SET status =/.test(sql)) statuses.push(params[0]); return []; } },
        createBrowser: async () => { throw new Error('browser startup failure'); },
    });
    scraper.getSubscribedCases = async () => [{ application_number: '1/26' }];
    await assert.rejects(scraper.run(), /browser startup failure/);
    assert.deepEqual(statuses, ['failed']);
});

test('completed checkpoint is restricted to the current pool and business day', t => {
    const directory = fixture(t);
    const filename = path.join(directory, 'checkpoint.json');
    writeJsonAtomic(filename, { version: 1, date: today(), runId: 'r', startedAt: new Date().toISOString(), results: [{ applicationNumber: '1/26', type: 'found' }, { applicationNumber: '99/26', type: 'found' }] });
    const scraper = new WeeklyECHRScraper('echr-db', { d1: {} });
    scraper.restoreCheckpoint([{ application_number: '1/26' }]);
    assert.equal(scraper.processedCount, 1);
    assert.equal(readCheckpoint(filename, '2000-01-01'), null);
});

test('daily writes never call bulk import or legacy shell fallbacks', async () => {
    const adapter = Object.create(D1Adapter.prototype);
    adapter.normalizeApplicationData = data => data;
    adapter.buildBatchSQLWithReps = () => 'INSERT INTO applications VALUES (1); UPDATE applications SET id=1;';
    adapter.importAPI = { uploadSQL: () => { throw Error('bulk import prohibited'); } };
    adapter.executeSQL = () => { throw Error('shell prohibited'); };
    let query;
    adapter.querySQL = async sql => { query = sql; };
    assert.deepEqual(await adapter.saveDailyApplication({}), { success: 1, failed: 0 });
    assert.match(query, /UPDATE applications/);
});
