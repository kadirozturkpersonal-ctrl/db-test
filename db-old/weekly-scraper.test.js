const assert = require('node:assert/strict');
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
