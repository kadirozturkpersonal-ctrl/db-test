const assert = require('node:assert/strict');
const test = require('node:test');
const { createBrowser } = require('./improved-scraper');

test('default browser is bundled, bounded and retried without desktop Chrome', async () => {
    const calls = [];
    const browser = {};
    const result = await createBrowser({ env: {}, sleep: async () => {}, launch: async options => {
        calls.push(options);
        if (calls.length === 1) throw Error('launch timeout');
        return browser;
    } });
    assert.equal(result, browser);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(options => options.headless === true && options.timeout === 60000 && !options.executablePath));
});

test('broken explicit browser falls back to bundled headless', async () => {
    const calls = [];
    await createBrowser({ env: { ECHR_BROWSER_EXECUTABLE_PATH: 'custom.exe' }, sleep: async () => {}, launch: async options => {
        calls.push(options);
        if (options.executablePath) throw Error('custom browser broken');
        return {};
    } });
    assert.equal(calls[0].executablePath, 'custom.exe');
    assert.equal(calls[1].executablePath, undefined);
});

test('all startup failures remain technical errors, never a successful scan', async () => {
    await assert.rejects(createBrowser({ env: {}, sleep: async () => {}, launch: async () => { throw Error('out of memory'); } }),
        error => error.temporary === true && /2 bounded attempts/.test(error.message));
});
