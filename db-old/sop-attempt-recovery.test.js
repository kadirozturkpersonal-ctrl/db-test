const assert = require('node:assert/strict');
const test = require('node:test');
const { MonthlyECHRScraper } = require('./monthly-scraper');
const { scrapeECHRApplication, TemporaryScrapeError } = require('./improved-scraper');

const sample = { applicationNumber: '42/20', applicationTitle: 'Example v. State', majorEventsList: [] };
function fakeSource({ status = 200, panel = 'ResultPanel', data = sample, close } = {}) {
    const calls = { closed: 0, waited: 0 };
    const page = {
        route: async () => {},
        goto: async () => ({ ok: () => status < 400, status: () => status }),
        waitForSelector: async selector => {
            calls.waited++;
            assert.equal(selector, '#ResultPanel:visible, #error-container:visible');
            return { getAttribute: async () => panel };
        },
        evaluate: async () => data,
    };
    return { calls, browser: { newContext: async () => ({ newPage: async () => page, close: async () => { calls.closed++; if (close) await close(); } }) } };
}

test('each timeout gets its own budget and a fresh browser, without moving the checkpoint', async () => {
    const browsers = [], attempts = [], events = [];
    const scraper = new MonthlyECHRScraper({
        d1: {}, scrapeAttemptTimeoutMs: 10, maxScrapeRetries: 1,
        createBrowser: async () => { const browser = { closed: 0, close: async () => { browser.closed++; } }; browsers.push(browser); return browser; },
        scrapeApplication: async (browser, number, year, options) => {
            attempts.push({ browser, number, year, options });
            return attempts.length === 1 ? new Promise(() => {}) : sample;
        },
    });
    scraper.state = { currentYear: 2020, currentNumber: 42, consecutiveEmpty: 3 };
    scraper.sleep = async () => {};
    scraper.recordActivity = (type, detail) => events.push({ type, ...detail });
    assert.equal(await scraper.scrapeWithDeadline(42, '20'), sample);
    assert.equal(browsers.length, 2);
    assert.equal(browsers[0].closed, 1);
    assert.ok(attempts.every(a => a.number === 42 && a.year === '20' && a.options.maxRetries === 0));
    assert.equal(scraper.state.currentNumber, 42);
    assert.equal(scraper.state.consecutiveEmpty, 3);
    assert.deepEqual(events.map(e => e.type), ['technical_retry', 'source_recovered']);
    await scraper.closeBrowserWithinDeadline('test');
});

test('exhausted recovery is at most three attempts and is never a no-info result', async () => {
    let attempts = 0, closed = 0;
    const scraper = new MonthlyECHRScraper({
        d1: {}, maxScrapeRetries: 9,
        createBrowser: async () => ({ close: async () => { closed++; } }),
        scrapeApplication: async () => { attempts++; throw new TemporaryScrapeError('SOP unavailable'); },
    });
    scraper.state = { currentNumber: 42 };
    scraper.sleep = async () => {};
    await assert.rejects(scraper.scrapeWithDeadline(42, '20'), e => e.temporary && e.recoveryExhausted);
    assert.equal(attempts, 3);
    assert.equal(closed, 3);
    assert.equal(scraper.state.currentNumber, 42);
    assert.equal(scraper.stats.notFound, 0);
});

test('the daily stop boundary prevents a new retry after backoff', async () => {
    let attempts = 0;
    const scraper = new MonthlyECHRScraper({
        d1: {}, createBrowser: async () => ({ close: async () => {} }),
        scrapeApplication: async () => { attempts++; throw new TemporaryScrapeError('temporary'); },
    });
    scraper.sleep = async () => { scraper.stopNewAttemptsAt = Date.now() - 1; };
    await assert.rejects(scraper.scrapeWithDeadline(42, '20'), e => e.recoveryExhausted);
    assert.equal(attempts, 1);
});

test('source result is accepted only for the requested application', async () => {
    const source = fakeSource();
    assert.equal(await scrapeECHRApplication(source.browser, 42, '20', { maxRetries: 0 }), sample);
    assert.equal(source.calls.closed, 1);
    const wrong = fakeSource({ data: { ...sample, applicationNumber: '43/20' } });
    await assert.rejects(scrapeECHRApplication(wrong.browser, 42, '20', { maxRetries: 0 }), /application mismatch/);
});

test('only the explicit no-info panel returns null; incomplete/HTTP errors are technical', async () => {
    const empty = fakeSource({ panel: 'error-container' });
    assert.equal(await scrapeECHRApplication(empty.browser, 42, '20', { maxRetries: 0 }), null);
    const partial = fakeSource({ data: { applicationNumber: '42/20' } });
    await assert.rejects(scrapeECHRApplication(partial.browser, 42, '20', { maxRetries: 0 }), /incomplete/);
    const unavailable = fakeSource({ status: 503 });
    await assert.rejects(scrapeECHRApplication(unavailable.browser, 42, '20', { maxRetries: 0 }), /SOP HTTP 503/);
    assert.equal(unavailable.calls.waited, 0);
    assert.equal(unavailable.calls.closed, 1);
});

test('stalled context cleanup is bounded and cannot silently accept a damaged browser', async t => {
    const realSetTimeout = global.setTimeout;
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => realSetTimeout(callback, ms === 5000 ? 5 : ms, ...args));
    const source = fakeSource({ close: () => new Promise(() => {}) });
    await assert.rejects(scrapeECHRApplication(source.browser, 42, '20', { maxRetries: 0 }), e => e.temporary && /cleanup timed out/.test(e.message));
    assert.equal(source.calls.closed, 1);
});

test('priority loop does not multiply an exhausted three-attempt recovery by five', async () => {
    let attempts = 0;
    const scraper = new MonthlyECHRScraper({ d1: {} });
    scraper.scrapeWithDeadline = async () => { attempts++; const e = new TemporaryScrapeError('unavailable'); e.recoveryExhausted = true; throw e; };
    scraper.flushBatch = async () => {};
    const result = await scraper.scanScheduledYearDirection({ year: 2020, startNumber: 42, direction: 1, phase: 'test' });
    assert.equal(result.deferred, true);
    assert.equal(attempts, 1);
    assert.equal(scraper.stats.notFound, 0);
});

test('scheduler uses the verified version-matched runtime without changing its rate or checkpoint', () => {
    const fs = require('node:fs');
    const script = fs.readFileSync(require('node:path').join(__dirname, '../scripts/run-echr-local-scraper.ps1'), 'utf8');
    assert.match(script, /PLAYWRIGHT_BROWSERS_PATH = Join-Path \$runtimeDir 'playwright-browsers'/);
    assert.match(script, /ECHR_BROWSER_EXECUTABLE_PATH = \$null/);
    assert.match(script, /SCRAPER_REQUEST_DELAY_MS = '1350'/);
    assert.match(script, /SCRAPER_STATE_FILE = Join-Path \$runtimeDir 'scraper-state.json'/);
});
