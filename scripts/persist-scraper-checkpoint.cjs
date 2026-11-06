const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function persistCheckpoint({ cwd, branch, remote = 'origin', file = 'db-old/scraper-state.json' }) {
    if (!branch) throw new Error('Checkpoint branch is required');
    const git = (args, extraEnv = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const original = git(['rev-parse', `HEAD:${file}`]);
    const current = git(['hash-object', '-w', '--', file]);
    if (current === original) return { status: 'unchanged' };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'echr-checkpoint-index-'));
    const env = { GIT_INDEX_FILE: path.join(directory, 'index'), GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
    try {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
            git(['fetch', remote, branch]);
            const head = git(['rev-parse', 'FETCH_HEAD']);
            const remoteBlob = git(['rev-parse', `${head}:${file}`]);
            if (remoteBlob === current) return { status: 'already_saved', commit: head };
            if (remoteBlob !== original) throw new Error('Remote checkpoint changed during this run; refusing to overwrite newer progress. Use the preserved checkpoint artifact.');
            git(['read-tree', head], env);
            git(['update-index', '--add', '--cacheinfo', `100644,${current},${file}`], env);
            const tree = git(['write-tree'], env);
            const commit = git(['commit-tree', tree, '-p', head, '-m', 'chore: update ECHR scraper checkpoint [skip ci]'], env);
            try {
                git(['push', remote, `${commit}:refs/heads/${branch}`]);
                return { status: 'saved', commit };
            } catch (error) { lastError = error; }
        }
        throw lastError;
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (require.main === module) {
    try { console.log(JSON.stringify(persistCheckpoint({ cwd: path.resolve(__dirname, '..'), branch: process.env.GITHUB_REF_NAME }))); }
    catch (error) { console.error(`Checkpoint not pushed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { persistCheckpoint };
