const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WeeklyECHRScraper } = require('./weekly-scraper');

test('daily subscription scan reads active cases through the D1 API instead of the Wrangler shell', async () => {
    let queried = false;
    const scraper = new WeeklyECHRScraper('echr-db', {
        d1: {
            async querySQL(sql) {
                queried = /FROM subscriptions/.test(sql);
                return [{ application_number: '123/26', current_event: 'Pending' }];
            },
            executeSQL() {
                throw new Error('The legacy Wrangler shell must not be used.');
            }
        }
    });

    const cases = await scraper.getSubscribedCases();

    assert.equal(queried, true);
    assert.deepEqual(cases, [{ application_number: '123/26', current_event: 'Pending' }]);
});

test('daily subscription scan defers safely when SOP is temporarily unavailable', async () => {
    let closed = 0;
    const scraper = new WeeklyECHRScraper('echr-db', {
        d1: {
            async saveApplication() {
                throw new Error('A deferred scan must not save application data');
            },
            async markAsNotFound() {
                throw new Error('A deferred scan must not mark applications as missing');
            }
        },
        createBrowser: async () => ({
            close: async () => { closed++; }
        }),
        scrapeApplication: async () => {
            const error = new Error('SOP unavailable');
            error.temporary = true;
            throw error;
        }
    });
    scraper.getSubscribedCases = async () => Array.from(
        { length: 10 },
        (_, index) => ({ application_number: `${index + 1}/26`, current_event: 'Pending' })
    );
    scraper.sleep = async () => {};

    const result = await scraper.run();

    assert.deepEqual(result, { sourceAvailable: false });
    assert.equal(scraper.sourceUnavailable, true);
    assert.equal(scraper.stats.errors, 5);
    assert.equal(scraper.stats.notFound, 0);
    assert.equal(closed, 1);
});

test('daily subscription scan writes a local source-availability outcome for the panel queue', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-daily-sop-'));
    const outcomePath = path.join(directory, 'outcome.json');
    const previous = process.env.DAILY_SOP_OUTCOME_FILE;
    process.env.DAILY_SOP_OUTCOME_FILE = outcomePath;
    try {
        const scraper = new WeeklyECHRScraper('echr-db', { d1: {} });
        scraper.stats.updated = 2;
        scraper.writeWorkflowOutcome();
        assert.deepEqual(JSON.parse(fs.readFileSync(outcomePath, 'utf8')), {
            sourceAvailable: true,
            stats: scraper.stats
        });
    } finally {
        if (previous === undefined) delete process.env.DAILY_SOP_OUTCOME_FILE;
        else process.env.DAILY_SOP_OUTCOME_FILE = previous;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('daily subscription scan writes SOP results through the batch D1 API', async () => {
    const savedBatches = [];
    const scraper = new WeeklyECHRScraper('echr-db', {
        d1: {
            async saveBatch(rows) {
                savedBatches.push(rows);
                return { success: rows.length, failed: 0 };
            },
            async querySQL() {
                throw new Error('No not-found write is expected for this result.');
            }
        },
        createBrowser: async () => ({ close: async () => {} }),
        scrapeApplication: async () => ({
            applicationNumber: '123/26',
            applicationTitle: 'Example v. Türkiye',
            lastMajorEvent: 'Pending',
            majorEventsList: []
        })
    });
    scraper.getSubscribedCases = async () => [{ application_number: '123/26', current_event: 'Pending' }];
    scraper.sleep = async () => {};

    const result = await scraper.run();

    assert.deepEqual(result, { sourceAvailable: true });
    assert.equal(savedBatches.length, 1);
    assert.equal(savedBatches[0][0].applicationNumber, '123/26');
});
