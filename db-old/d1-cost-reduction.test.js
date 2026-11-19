const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { D1Adapter, ISTANBUL_SQL_DATE } = require('./d1-adapter');
const { D1CostTracker } = require('./d1-cost-tracker');
const os = require('node:os');

function fixture(t) {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(`
        CREATE TABLE representatives(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,total_cases INTEGER DEFAULT 0,updated_at TEXT);
        CREATE TABLE applications(id INTEGER PRIMARY KEY AUTOINCREMENT,application_number TEXT UNIQUE NOT NULL,application_title TEXT NOT NULL,country TEXT,date_introduction TEXT,representative_id INTEGER,representative_name TEXT,last_major_event TEXT,last_major_event_date TEXT,is_closed INTEGER DEFAULT 0,last_checked_date TEXT,not_found_count INTEGER DEFAULT 0,updated_at TEXT);
        CREATE INDEX idx_applications_representative ON applications(representative_id);
        CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER,event_date TEXT,description TEXT,is_last_event INTEGER);
        CREATE INDEX idx_events_application ON events(application_id);
        CREATE TABLE sop_no_info_tracking(application_number TEXT PRIMARY KEY,status TEXT,first_not_found_date TEXT);
    `);
    const adapter = Object.create(D1Adapter.prototype);
    adapter.repCache = new Map();
    adapter.sopNoInfoTrackingReady = false;
    adapter.querySQL = async (sql, params = []) => {
        if (/^\s*SELECT/.test(sql)) return db.prepare(sql).all(...params);
        db.exec(sql);
        return [];
    };
    return { db, adapter };
}

function sample(overrides = {}) {
    return { applicationNumber: '10/26', applicationTitle: "Applicant v. Türkiye", dateIntroduction: '2026-01-01', representant: 'Representative', lastMajorEvent: 'Pending', lastMajorEventDate: '2026-02-01', majorEventsList: [{ eventDate: '2026-02-01', description: "Pending; applicant's request" }], ...overrides };
}

test('unchanged daily result preserves event IDs and does not rewrite business rows', async t => {
    const { db, adapter } = fixture(t);
    await adapter.saveBatch([sample()]);
    const before = db.prepare('SELECT * FROM events').all();
    const changes = db.prepare('SELECT total_changes() AS n').get().n;
    assert.deepEqual(await adapter.saveDailyApplication(sample()), { success: 1, failed: 0 });
    assert.deepEqual(db.prepare('SELECT * FROM events').all(), before);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n - changes, 0);
    assert.equal(db.prepare('SELECT last_checked_date AS d FROM applications').get().d, ISTANBUL_SQL_DATE.slice(1, -1));
});

test('changed title, representative, date and events are still persisted; stale events are removed', async t => {
    const { db, adapter } = fixture(t);
    await adapter.saveBatch([sample()]);
    await adapter.saveBatch([sample({ applicationTitle: 'New title v. Türkiye', representant: 'New representative', lastMajorEventDate: '2026-03-01', majorEventsList: [{ eventDate: '2026-03-01', description: 'Updated' }] })]);
    assert.equal(db.prepare('SELECT application_title AS t FROM applications').get().t, 'New title v. Türkiye');
    assert.equal(db.prepare('SELECT representative_name AS n FROM applications').get().n, 'New representative');
    assert.deepEqual({ ...db.prepare('SELECT event_date,description,is_last_event FROM events').get() }, { event_date: '2026-03-01', description: 'Updated', is_last_event: 1 });
    await adapter.saveBatch([sample({ majorEventsList: [] })]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('repeating an unchanged result on a new day updates freshness without rewriting events', async t => {
    const { db, adapter } = fixture(t);
    await adapter.saveBatch([sample()]);
    db.exec("UPDATE applications SET last_checked_date='2000-01-01',not_found_count=3");
    const events = db.prepare('SELECT * FROM events').all();
    await adapter.saveDailyApplication(sample());
    assert.deepEqual(db.prepare('SELECT * FROM events').all(), events);
    assert.equal(db.prepare('SELECT not_found_count AS n FROM applications').get().n, 0);
    assert.equal(db.prepare('SELECT last_checked_date AS d FROM applications').get().d, ISTANBUL_SQL_DATE.slice(1, -1));
});

test('keyset pagination preserves all records and finalized semantics over multiple pages', async t => {
    const { db, adapter } = fixture(t);
    const insert = db.prepare('INSERT INTO applications(id,application_number,application_title,is_closed,last_major_event) VALUES(?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 1; i <= 20005; i++) insert.run(i * 2, `${i}/26`, 'Case', i % 3 === 0 ? 1 : 0, i % 5 === 0 ? 'Decision to strike a case out of the list following withdrawal' : 'Pending');
    db.exec('COMMIT');
    const known = await adapter.loadKnownApplicationNumbers();
    const finalized = await adapter.loadFinalizedApplicationNumbers();
    assert.equal(known.size, 20005);
    assert.ok(known.has('20005/26'));
    for (let i = 1; i <= 20005; i++) assert.equal(finalized.has(`${i}/26`), i % 3 === 0 || i % 5 === 0);
});

test('migration skips lawyer recounts on freshness changes and repairs both sides on reassignment', t => {
    const { db } = fixture(t);
    db.exec("INSERT INTO representatives(id,name,total_cases) VALUES(1,'A',1),(2,'B',0); INSERT INTO applications(application_number,application_title,representative_id) VALUES('1/26','Case',1)");
    db.exec(fs.readFileSync(path.join(__dirname, 'migrations/20261106_d1_cost_reduction.sql'), 'utf8'));
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    db.exec("UPDATE applications SET representative_id=representative_id,last_checked_date='2026-11-06'");
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n - before, 1);
    db.exec('UPDATE applications SET representative_id=2');
    assert.deepEqual(db.prepare('SELECT total_cases FROM representatives ORDER BY id').all().map(row => row.total_cases), [0, 1]);
});

test('cost tracker attributes every statement, redacts literals, and counts one HTTP request', () => {
    const tracker = new D1CostTracker();
    tracker.record("SELECT * FROM events WHERE description='secret; case'; UPDATE applications SET application_title='private' WHERE id=123", [
        { meta: { rows_read: 100, rows_written: 0, duration: 2 } },
        { meta: { rows_read: 1, rows_written: 2, duration: 1 } },
    ]);
    const report = tracker.snapshot();
    assert.equal(report.totals.requests, 1);
    assert.equal(report.totals.statements, 2);
    assert.equal(report.totals.rowsRead, 101);
    assert.equal(report.totals.rowsWritten, 2);
    assert.equal(report.queries.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /secret|private|123/);
});

test('uncertain write errors propagate without invoking the import or shell fallback', async t => {
    const { adapter } = fixture(t);
    adapter.findUnchangedEvents = async () => new Set();
    adapter.querySQL = async () => { throw new Error('network outcome uncertain'); };
    adapter.importAPI = { uploadSQL() { assert.fail('must not replay through import'); } };
    adapter.executeSQL = () => assert.fail('must not replay through shell');
    await assert.rejects(adapter.saveBatch([sample()]), /network outcome uncertain/);
});

test('a quota response stops subsequent API calls for the same account', async t => {
    const originalFetch = global.fetch;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    t.after(() => {
        global.fetch = originalFetch;
        if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = account;
        if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = token;
    });
    process.env.CLOUDFLARE_ACCOUNT_ID = 'cost-test-account';
    process.env.CLOUDFLARE_API_TOKEN = 'cost-test-token';
    let calls = 0;
    global.fetch = async () => {
        calls++;
        return { ok: false, status: 400, json: async () => ({ success: false, result: [], errors: [{ message: "Your account has exceeded D1's free tier daily row read limit." }] }) };
    };
    const adapter = Object.create(D1Adapter.prototype);
    adapter.costTracker = new D1CostTracker();
    adapter.databaseId = 'test-db';
    await assert.rejects(adapter.querySQL('SELECT 1'), { code: 'D1_QUOTA_EXCEEDED' });
    await assert.rejects(adapter.querySQL('UPDATE applications SET not_found_count=0'), { code: 'D1_QUOTA_EXCEEDED' });
    assert.equal(calls, 1);
    assert.equal(adapter.costTracker.snapshot().totals.missingMeta, 1);
});

test('pending package checkpoints stay before the first unconfirmed case', t => {
    const { MonthlyECHRScraper } = require('./monthly-scraper');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-cost-checkpoint-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const stateFile = path.join(directory, 'state.json');
    const scraper = new MonthlyECHRScraper({ d1: {}, stateFile });
    scraper.state = { currentYear: 2026, currentNumber: 125, consecutiveEmpty: 1 };
    scraper.batchCheckpoint = { currentYear: 2026, currentNumber: 100, consecutiveEmpty: 0 };
    scraper.saveState('pending');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).currentNumber, 100);
    assert.equal(scraper.state.currentNumber, 125);
    scraper.batchCheckpoint = null;
    scraper.saveState('confirmed');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).currentNumber, 125);
});

test('ambiguous REST write failure is never retried and is reported as unknown cost', async t => {
    const oldFetch = global.fetch;
    const oldAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    const oldToken = process.env.CLOUDFLARE_API_TOKEN;
    t.after(() => {
        global.fetch = oldFetch;
        if (oldAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccount;
        if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = oldToken;
    });
    process.env.CLOUDFLARE_ACCOUNT_ID = 'network-test-account';
    process.env.CLOUDFLARE_API_TOKEN = 'network-test-token';
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('connection lost'); };
    const adapter = Object.create(D1Adapter.prototype);
    adapter.costTracker = new D1CostTracker();
    await assert.rejects(adapter.querySQL('UPDATE applications SET not_found_count=0'), { code: 'D1_WRITE_FAILED' });
    assert.equal(calls, 1);
    assert.equal(adapter.costTracker.snapshot().totals.missingMeta, 1);
});
