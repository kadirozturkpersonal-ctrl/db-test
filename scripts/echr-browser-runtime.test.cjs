const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ensureBrowserRuntime, browserCachePath } = require('./echr-browser-runtime.cjs');

test('scheduler installs and verifies the same project-owned browser before scanning', () => {
    const calls = [];
    const result = ensureBrowserRuntime({ env: { PLAYWRIGHT_BROWSERS_PATH: 'wrong-user-cache' }, run: (_node, args, options) => {
        calls.push({ args, options });
        return calls.length === 1 ? 'installed' : JSON.stringify({ launched: true, browserPath: browserCachePath, browserVersion: 'test' });
    } });
    assert.equal(result.cachePath, browserCachePath);
    assert.match(browserCachePath, /local-data[\\/]playwright-browsers$/);
    assert.deepEqual(calls[0].args.slice(1), ['install', 'chromium', '--only-shell']);
    assert.ok(calls.every(call => call.options.env.PLAYWRIGHT_BROWSERS_PATH === browserCachePath && call.options.windowsHide && call.options.timeout === 180000));
});

test('installation failure blocks health check and therefore blocks daily sends', () => {
    let calls = 0;
    assert.throws(() => ensureBrowserRuntime({ run: () => { calls++; throw Error('download unavailable'); } }), /download unavailable/);
    assert.equal(calls, 1);
});

test('another cache or unhealthy browser must not be accepted', () => {
    let calls = 0;
    assert.throws(() => ensureBrowserRuntime({ run: () => ++calls === 1 ? '' : JSON.stringify({ launched: true, browserPath: 'AppData' }) }), /another cache/);
});

test('daily wrapper uses the same cache and health check inside its writer mutex', () => {
    const source = fs.readFileSync(new URL('./run-echr-local-daily-sop.ps1', `file://${__filename.replace(/\\/g, '/')}`), 'utf8');
    assert.match(source, /PLAYWRIGHT_BROWSERS_PATH = Join-Path \$runtimeDir 'playwright-browsers'/);
    assert.ok(source.indexOf("'echr-browser-runtime.cjs'") > source.indexOf('$mutex.WaitOne(0)'));
    assert.ok(source.indexOf("'echr-browser-runtime.cjs'") < source.lastIndexOf('& $nodePath $supervisor'));
});

test('full scan gives the unfinished daily turn priority before acquiring its writer', () => {
    const source = fs.readFileSync(require('node:path').join(__dirname, 'run-echr-local-scraper.ps1'), 'utf8');
    const priority = source.indexOf("while ($Slot -eq '02:00')");
    assert.ok(priority >= 0 && priority < source.indexOf('$mutex = New-Object'));
    assert.match(source, /dailyState.status -eq 'completed'/);
    assert.match(source, /TimeSpan\]::new\(3,57,0\)/);
});
