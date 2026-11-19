const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { persistCheckpoint } = require('./persist-scraper-checkpoint.cjs');

test('checkpoint push leaves unrelated dirty files intact and never commits them', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-persist-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const remote = path.join(directory, 'remote.git');
    const cwd = path.join(directory, 'local');
    fs.mkdirSync(cwd);
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '--bare', remote]);
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.test']);
    fs.mkdirSync(path.join(cwd, 'db-old'));
    fs.writeFileSync(path.join(cwd, 'db-old/scraper-state.json'), '{"currentNumber":1}');
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'original');
    git(['add', '.']); git(['commit', '-m', 'initial']); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
    fs.writeFileSync(path.join(cwd, 'db-old/scraper-state.json'), '{"currentNumber":100}');
    fs.writeFileSync(path.join(cwd, 'other.txt'), 'keep dirty');
    const result = persistCheckpoint({ cwd, branch: 'main' });
    assert.equal(result.status, 'saved');
    assert.equal(git(['show', `${result.commit}:other.txt`]), 'original');
    assert.equal(git(['show', `${result.commit}:db-old/scraper-state.json`]), '{"currentNumber":100}');
    assert.equal(fs.readFileSync(path.join(cwd, 'other.txt'), 'utf8'), 'keep dirty');
    assert.equal(git(['diff', '--cached']), '');
    // The local base is intentionally unchanged. A second, different result
    // must not replace the checkpoint that another run already published.
    fs.writeFileSync(path.join(cwd, 'db-old/scraper-state.json'), '{"currentNumber":50}');
    assert.throws(() => persistCheckpoint({ cwd, branch: 'main' }), /refusing to overwrite newer progress/);
});
