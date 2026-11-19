const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const browserRequire = createRequire(path.join(root, 'db-old/package.json'));
const browserCachePath = path.join(root, 'local-data/playwright-browsers');

function ensureBrowserRuntime(options = {}) {
    const run = options.run || execFileSync;
    const cachePath = options.cachePath || browserCachePath;
    const env = { ...(options.env || process.env), PLAYWRIGHT_BROWSERS_PATH: cachePath };
    const cli = path.join(path.dirname(browserRequire.resolve('playwright/package.json')), 'cli.js');
    const settings = { cwd: path.join(root, 'db-old'), env, windowsHide: true,
        timeout: 180000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    // The package's own CLI installs/checks its matching headless revision.
    // This path is shared by the real scheduler and scraper, not AppData.
    const installed = run(process.execPath, [cli, 'install', 'chromium', '--only-shell'], settings);
    if (!options.run) {
        fs.mkdirSync(path.join(root, 'local-data/logs'), { recursive: true });
        fs.appendFileSync(path.join(root, 'local-data/logs/browser-runtime.log'), `[${new Date().toISOString()}] ${installed}\n`);
    }
    const output = run(process.execPath, [path.join(root, 'db-old/browser-task-probe.cjs')], settings);
    const report = JSON.parse(String(output).trim().split(/\r?\n/).at(-1));
    if (!report.launched || report.browserPath !== cachePath) throw Error('Scheduler browser health check failed or used another cache.');
    return { cachePath, browserVersion: report.browserVersion, user: report.user, at: report.at };
}

if (require.main === module) {
    try { console.log(JSON.stringify(ensureBrowserRuntime())); }
    catch (error) {
        const message = `Browser runtime preparation failed: ${error.message}\n${String(error.stderr || error.stdout || '').slice(-3000)}`;
        fs.mkdirSync(path.join(root, 'local-data/logs'), { recursive: true });
        fs.appendFileSync(path.join(root, 'local-data/logs/browser-runtime.log'), `[${new Date().toISOString()}] ${message}\n`);
        console.error(message);
        process.exitCode = 1;
    }
}

module.exports = { ensureBrowserRuntime, browserCachePath };
