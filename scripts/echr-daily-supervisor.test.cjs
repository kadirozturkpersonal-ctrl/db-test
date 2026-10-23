const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDaily, runChild, claimLock } = require('./echr-daily-supervisor.cjs');
const { loadWranglerD1Target } = require('../db-old/d1-target');

function setup(t) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-supervisor-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
    const env = { CLOUDFLARE_ACCOUNT_ID: 'test', CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_D1_DATABASE_ID: loadWranglerD1Target().databaseId, ECHR_STAGE_NOTIFICATION_URL: 'https://example.invalid', ECHR_STAGE_NOTIFICATION_CRON_SECRET: 'test' };
    return { runtime, date, env };
}

test('native crash is retried with the same checkpoint; only one frozen email turn is finalized', async t => {
    const options = setup(t);
    const posts = [];
    let attempts = 0;
    const result = await runDaily({ ...options, sleep: async () => {},
        fetch: async (_url, init) => {
            if (init.method === 'GET') return { ok: true, json: async () => ({ ok: true, date: options.date, applicationNumbers: ['1/26'], run: { id: 'same-run', phase: 'sync' } }) };
            posts.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ ok: true, run: { id: 'same-run', phase: 'completed', status: 'completed' } }) };
        },
        runChild: async args => {
            assert.equal(args.env.DAILY_SOP_REQUIRE_PANEL_SCOPE, 'true');
            if (++attempts === 1) { fs.writeFileSync(args.checkpointPath, 'retained progress'); return { code: 3221226505, exitHex: '0xc0000409' }; }
            assert.equal(fs.readFileSync(args.checkpointPath, 'utf8'), 'retained progress');
            fs.writeFileSync(args.env.DAILY_SOP_OUTCOME_FILE, JSON.stringify({ sourceAvailable: true }));
            return { code: 0 };
        },
    });
    assert.equal(result.completed, true);
    assert.equal(attempts, 2);
    assert.deepEqual(posts, [{ runId: 'same-run' }]);
    const again = await runDaily({ ...options, fetch: () => { throw Error('completed day must not contact panel'); } });
    assert.equal(again.alreadyCompleted, true);
});

test('three failed attempts do not send email or silently succeed', async t => {
    const options = setup(t);
    let posts = 0;
    await assert.rejects(runDaily({ ...options, sleep: async () => {},
        fetch: async (_url, init) => { if (init.method === 'POST') posts++; return { ok: true, json: async () => ({ ok: true, date: options.date, applicationNumbers: ['1/26'], run: { id: 'r', phase: 'sync' } }) }; },
        runChild: async () => ({ code: 1 }),
    }), /Scraper failed/);
    assert.equal(posts, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.runtime, 'daily-sop-supervisor-state.json'))).status, 'failed');
});

test('process watchdog terminates a hung owned child and records its reason', async t => {
    const options = setup(t);
    const filename = path.join(options.runtime, 'hung.cjs');
    fs.writeFileSync(filename, 'setInterval(() => {}, 1000);');
    const result = await runChild({ filename, cwd: options.runtime, env: process.env,
        logPath: path.join(options.runtime, 'child.log'), checkpointPath: path.join(options.runtime, 'missing.json'),
        reportDirectory: path.join(options.runtime, 'reports'), stallMs: 200,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.reason, /watchdog/);
});

test('supervisor lock prevents overlapping runners', t => {
    const options = setup(t);
    const filename = path.join(options.runtime, 'lock.json');
    const release = claimLock(filename);
    assert.equal(claimLock(filename), null);
    release();
    assert.equal(fs.existsSync(filename), false);
});

test('preflight has no remote calls or child process', async t => {
    const options = setup(t);
    assert.deepEqual(await runDaily({ ...options, preflight: true,
        fetch: () => { throw Error('no network'); }, runChild: () => { throw Error('no scan'); },
    }), { preflight: true });
});
