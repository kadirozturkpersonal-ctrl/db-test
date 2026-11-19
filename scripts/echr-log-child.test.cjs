const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoggedChild } = require('./echr-log-child.cjs');

test('native stderr is logged without aborting a successful child', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-child-test-'));
    const logPath = path.join(directory, 'child.log');
    const code = runLoggedChild({ filename: '-e', args: ['console.error("warning"); console.log("checkpoint retained")'], cwd: directory, logPath });
    assert.equal(code, 0);
    assert.match(fs.readFileSync(logPath, 'utf8'), /warning/);
    assert.match(fs.readFileSync(logPath, 'utf8'), /checkpoint retained/);
    fs.unlinkSync(logPath); fs.rmdirSync(directory);
});
test('a failed child retains its nonzero status', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-child-test-'));
    const logPath = path.join(directory, 'child.log');
    assert.equal(runLoggedChild({ filename: '-e', args: ['process.exit(17)'], cwd: directory, logPath }), 17);
    fs.unlinkSync(logPath); fs.rmdirSync(directory);
});
test('main wrapper tolerates an abandoned mutex but never bypasses a live writer', () => {
    const source = fs.readFileSync(path.join(__dirname, 'run-echr-local-scraper.ps1'), 'utf8');
    assert.match(source, /catch \[System.Threading.AbandonedMutexException\] \{ \$ownsMutex = \$true \}/);
    assert.match(source, /if \(-not \$ownsMutex\)/);
    assert.doesNotMatch(source, /Tee-Object/);
    assert.match(source, /\$env:SCRAPER_STATE_FILE = Join-Path \$runtimeDir 'scraper-state.json'/);
});
