const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');

const reportPath = path.resolve(__dirname, '../local-data/browser-task-probe.json');
const access = filename => {
    try { fs.accessSync(filename); return { accessible: true, size: fs.statSync(filename).size }; }
    catch (error) { return { accessible: false, code: error.code, message: error.message }; }
};

(async () => {
    const executable = chromium.executablePath();
    const revision = path.basename(path.resolve(executable, '../..')).replace('chromium-', '');
    const headless = path.resolve(executable, '../../..', `chromium_headless_shell-${revision}`, 'chrome-win/headless_shell.exe');
    const report = { at: new Date().toISOString(), user: os.userInfo().username, node: process.execPath,
        nodeVersion: process.version, cwd: process.cwd(), browserPackage: require('playwright/package.json').version,
        localAppData: process.env.LOCALAPPDATA, browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH || null,
        executable, executableAccess: access(executable), headless, headlessAccess: access(headless) };
    let browser;
    try {
        browser = await chromium.launch({ headless: true, timeout: 20000 });
        report.launched = true;
        report.browserVersion = browser.version();
    } catch (error) {
        report.launched = false;
        report.error = error.message;
        process.exitCode = 1;
    } finally {
        await browser?.close().catch(() => {});
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
