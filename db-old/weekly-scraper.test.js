const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WeeklyECHRScraper } = require('./weekly-scraper');

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
