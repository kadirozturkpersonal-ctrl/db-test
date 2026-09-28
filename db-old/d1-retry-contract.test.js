const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('D1 query and import clients retry only transient Cloudflare responses', () => {
    const adapter = fs.readFileSync(path.join(__dirname, 'd1-adapter.js'), 'utf8');
    const importer = fs.readFileSync(path.join(__dirname, 'd1-import-api.js'), 'utf8');

    for (const source of [adapter, importer]) {
        assert.match(source, /fetchWithRetry\(/);
        assert.match(source, /\[408, 429, 500, 502, 503, 504\]/);
        assert.match(source, /AbortController/);
    }
});
