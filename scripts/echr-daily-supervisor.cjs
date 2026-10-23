const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { writeJsonAtomic } = require('../db-old/daily-sop-checkpoint');
const { assertSingleD1Target, loadWranglerD1Target } = require('../db-old/d1-target');

const istanbulDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function claimLock(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) {
        const previous = JSON.parse(fs.readFileSync(filename, 'utf8'));
        try { process.kill(previous.pid, 0); return null; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        fs.unlinkSync(filename);
    }
    let descriptor;
    try { descriptor = fs.openSync(filename, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(descriptor);
    return () => {
        const owner = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (owner.pid === process.pid) fs.unlinkSync(filename);
    };
}

function stopOwnedChild(child) {
    if (!child.pid || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else child.kill('SIGKILL');
}

function runChild({ filename, cwd, env, logPath, checkpointPath, reportDirectory, stallMs = 300000, deadline = Infinity }) {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(reportDirectory, { recursive: true });
        const descriptor = fs.openSync(logPath, 'a', 0o600);
        // Never write environment secrets into a fatal diagnostic report.
        const diagnostics = process.allowedNodeEnvironmentFlags.has('--report-exclude-env')
            ? ['--report-exclude-env', '--report-on-fatalerror', `--report-directory=${reportDirectory}`] : [];
        const child = spawn(process.execPath, [...diagnostics, filename], {
            cwd, env, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
        });
        fs.closeSync(descriptor);
        let lastProgress = Date.now();
        let lastModified = 0;
        let stoppedReason = null;
        const timer = setInterval(() => {
            try {
                const modified = fs.existsSync(checkpointPath) ? fs.statSync(checkpointPath).mtimeMs : 0;
                if (modified !== lastModified) { lastModified = modified; lastProgress = Date.now(); }
                if (!stoppedReason && (Date.now() >= deadline || Date.now() - lastProgress >= stallMs)) {
                    stoppedReason = Date.now() >= deadline ? 'nightly deadline exceeded' : 'no checkpoint progress within watchdog timeout';
                    stopOwnedChild(child);
                }
            } catch (error) { stoppedReason = error.message; try { stopOwnedChild(child); } catch {} }
        }, Math.min(1000, Math.max(10, stallMs / 4)));
        child.once('error', error => { clearInterval(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearInterval(timer);
            resolve({ code, signal, reason: stoppedReason, exitHex: code === null ? null : `0x${(code >>> 0).toString(16).padStart(8, '0')}` });
        });
    });
}

async function publishFailedRun(env, checkpointPath, error) {
    if (!fs.existsSync(checkpointPath)) return;
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (!checkpoint.runId || checkpoint.date !== istanbulDate()) return;
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CLOUDFLARE_D1_DATABASE_ID)}/query`, {
        method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: "UPDATE echr_scraper_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ? AND status = 'running'",
            params: [new Date().toISOString(), String(error.stack || error).slice(0, 2000), checkpoint.runId] }),
        signal: AbortSignal.timeout(10000),
    });
    const payload = await response.json();
    if (!response.ok || payload.success === false) throw new Error(`Could not publish failed daily run: HTTP ${response.status}`);
}

async function runDaily(options = {}) {
    const env = options.env || process.env;
    const runtime = options.runtime || path.resolve(__dirname, '../local-data');
    const date = istanbulDate();
    const logs = path.join(runtime, 'logs');
    const reports = path.join(runtime, 'daily-sop-reports', date);
    fs.mkdirSync(logs, { recursive: true });
    const log = message => fs.appendFileSync(path.join(logs, `echr-daily-supervisor-${date}.log`), `[${new Date().toISOString()}] ${message}\n`);
    const statePath = path.join(runtime, 'daily-sop-supervisor-state.json');
    const checkpointPath = path.join(runtime, `daily-sop-checkpoint-${date}.json`);
    const outcomePath = path.join(runtime, `daily-sop-outcome-${date}.json`);
    const scopePath = path.join(runtime, `daily-sop-scope-${date}.json`);
    const secret = (env.HUMAN_RIGHTS_DAILY_UPDATE_CRON_SECRET || env.ECHR_STAGE_NOTIFICATION_CRON_SECRET || '').trim();
    let endpoint = (env.HUMAN_RIGHTS_DAILY_UPDATE_URL || env.ECHR_STAGE_NOTIFICATION_URL || '').trim().replace(/\/$/, '');
    if (!secret || !endpoint) throw new Error('Panel daily-update URL and secret are required.');
    if (!endpoint.endsWith('/api/human-rights/daily-update')) endpoint += '/api/human-rights/daily-update';
    for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_D1_DATABASE_ID']) {
        if (!env[name]?.trim()) throw new Error(`Required setting missing: ${name}`);
    }
    assertSingleD1Target(env.CLOUDFLARE_D1_DATABASE_ID, loadWranglerD1Target());
    if (options.preflight) { log('Preflight passed; no scrape, D1 write or email was started.'); return { preflight: true }; }
    const release = claimLock(path.join(runtime, 'daily-sop-supervisor.lock'));
    if (!release) { log('Another daily supervisor is active; no duplicate was started.'); return { active: true }; }
    const delay = options.sleep || sleep;
    const childRunner = options.runChild || runChild;
    const deadline = options.deadline || (env.DAILY_SOP_DEADLINE ? Date.parse(env.DAILY_SOP_DEADLINE) : Date.now() + 105 * 60000);
    if (!Number.isFinite(deadline)) { release(); throw new Error('Invalid daily SOP deadline.'); }
    let phase = 'prepare';
    let attempt = 0;
    const saveState = (status, extra = {}) => writeJsonAtomic(statePath, { date, status, phase, attempt, updatedAt: new Date().toISOString(), ...extra });
    async function request(body) {
        if (istanbulDate() !== date || Date.now() >= deadline) throw new Error('Daily business-date/runtime boundary reached.');
        const response = await (options.fetch || fetch)(endpoint, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(300000),
        });
        if (!response.ok) throw new Error(`Panel daily-update HTTP ${response.status}`);
        const value = await response.json();
        if (!value.ok) throw new Error(value.error || 'Invalid panel daily-update result.');
        return value;
    }
    try {
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (state.date === date && state.status === 'completed') return { alreadyCompleted: true };
        }
        saveState('running');
        for (attempt = 1; attempt <= (options.maxAttempts || 3); attempt++) {
            try {
                saveState('running');
                let scope = await request();
                // Wednesday HUDOC preparation precedes the frozen SOP scope.
                for (let batch = 0; scope.run?.phase === 'decision_check' && batch < 160; batch++) {
                    const prepared = await request({ ...(scope.run?.id ? { runId: scope.run.id } : {}) });
                    log(`Prepare panel: ${prepared.action} ${prepared.run?.phase}`);
                    scope = await request();
                }
                if (scope.run?.phase === 'decision_check') throw new Error('Weekly HUDOC preparation did not finish.');
                if (scope.run?.phase === 'completed') {
                    log('The panel daily turn is already finalized; no extra scan or 25-person turn was started.');
                    saveState('completed', { runId: scope.run.id, alreadyCompleted: true });
                    return { alreadyCompleted: true };
                }
                if (!scope.run) {
                    await request({});
                    scope = await request();
                    if (scope.run?.phase === 'decision_check') { attempt--; continue; }
                }
                if (scope.date !== date || !Array.isArray(scope.applicationNumbers)) throw new Error('Invalid or stale panel SOP manifest.');
                writeJsonAtomic(scopePath, scope);
                if (scope.run?.phase !== 'periodic') {
                  phase = 'scan'; saveState('running', { scopeCount: scope.applicationNumbers.length });
                  const result = await childRunner({
                    filename: path.resolve(__dirname, '../db-old/weekly-scraper.js'), cwd: path.resolve(__dirname, '../db-old'),
                    env: { ...env, DAILY_SOP_REQUIRE_PANEL_SCOPE: 'true', DAILY_SOP_SCOPE_FILE: scopePath,
                        DAILY_SOP_CHECKPOINT_FILE: checkpointPath, DAILY_SOP_OUTCOME_FILE: outcomePath,
                        DAILY_SOP_ACTIVITY_FILE: path.join(runtime, 'echr-daily-sop-activity.jsonl') },
                    logPath: path.join(logs, `echr-daily-sop-${date}-attempt-${Date.now()}.log`),
                    checkpointPath, reportDirectory: reports, deadline,
                  });
                  log(`Scraper exit: ${JSON.stringify(result)}`);
                  if (result.code !== 0) throw new Error(`Scraper failed: ${result.exitHex || result.code}; ${result.reason || result.signal || 'see attempt log'}`);
                  const outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
                  if (!outcome.sourceAvailable) throw new Error('SOP scan did not complete safely.');
                }
                phase = 'notifications'; saveState('running', { scopeCount: scope.applicationNumbers.length });
                let response = await request({ ...(scope.run?.id ? { runId: scope.run.id } : {}) });
                let readinessWaits = 0;
                for (let batch = 0; response.run?.phase !== 'completed' && batch < 160; batch++) {
                    log(`Panel: ${response.action} ${response.run?.phase} ${response.run?.sync_completed}/${response.run?.sync_total}`);
                    if (response.action === 'waiting_for_source' && ++readinessWaits > 3) throw new Error('Panel SOP pool changed or is not ready; refreshing the manifest before retry.');
                    await delay(response.action === 'waiting_for_source' ? 30000 : response.run?.phase === 'periodic' ? 15000 : 3000);
                    response = await request({ runId: response.run.id });
                }
                if (response.run?.phase !== 'completed') throw new Error('Panel delivery did not finish; same durable run will be resumed.');
                phase = 'completed';
                saveState('completed', { runId: response.run.id, panelStatus: response.run.status });
                log(`Daily scan and notification turn finalized: ${response.run.status}`);
                return { completed: true, runId: response.run.id };
            } catch (error) {
                log(`Attempt ${attempt}: ${error.stack || error}`);
                saveState('retry_pending', { error: String(error.stack || error) });
                if (attempt >= (options.maxAttempts || 3) || Date.now() >= deadline || istanbulDate() !== date) throw error;
                await delay(15000);
            }
        }
    } catch (error) {
        saveState('failed', { error: String(error.stack || error) });
        try { await (options.publishFailure || publishFailedRun)(env, checkpointPath, error); }
        catch (publishError) { log(`Failure-status publication failed: ${publishError.message}`); }
        throw error;
    } finally { release(); }
}

if (require.main === module) {
    runDaily({ preflight: process.argv.includes('--preflight') }).then(result => console.log(JSON.stringify(result))).catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}
module.exports = { runDaily, runChild, claimLock };
