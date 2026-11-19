const fs = require('node:fs');
const path = require('node:path');

function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filename);
}

function readCheckpoint(filename, date) {
    if (!filename || !fs.existsSync(filename)) return null;
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value.date !== date) return null;
    if (value.version !== 1 || !value.runId || !Array.isArray(value.results)) {
        throw new Error('Invalid daily SOP checkpoint; refusing to discard its progress.');
    }
    return value;
}

module.exports = { writeJsonAtomic, readCheckpoint };
