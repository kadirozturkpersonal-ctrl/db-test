const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

function runLoggedChild({ filename, cwd, logPath, args = [], run = spawnSync }) {
    const descriptor = fs.openSync(logPath, 'a', 0o600);
    try {
        // Native stderr must go straight to a file, not through PowerShell's
        // ErrorAction=Stop pipeline (which can terminate the writer wrapper).
        const result = run(process.execPath, [filename, ...args], {
            cwd, env: process.env, windowsHide: true, stdio: ['ignore', descriptor, descriptor],
        });
        if (result.error) throw result.error;
        return result.status === null ? 1 : result.status;
    } finally { fs.closeSync(descriptor); }
}

if (require.main === module) {
    const [logPath, cwd, filename, ...args] = process.argv.slice(2);
    try { process.exitCode = runLoggedChild({ logPath, cwd, filename, args }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runLoggedChild };
