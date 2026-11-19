const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertSingleD1Target,
    loadWranglerD1Target,
    maskDatabaseId
} = require('./d1-target');

test('Wrangler points to the live HukukiPanel D1 database', () => {
    const target = loadWranglerD1Target();

    assert.equal(target.databaseName, 'echr-db');
    assert.equal(target.databaseId, '66df38db-7f00-4b45-8520-6f0c70ed01a6');
});

test('matching GitHub and Wrangler targets are accepted', () => {
    const target = loadWranglerD1Target();

    assert.equal(assertSingleD1Target(target.databaseId, target), target);
});

test('a mismatched GitHub secret stops the scraper before writes', () => {
    const target = loadWranglerD1Target();

    assert.throws(
        () => assertSingleD1Target('00000000-0000-0000-0000-000000000000', target),
        /D1 target mismatch/
    );
});

test('database ids are masked in logs and errors', () => {
    assert.equal(maskDatabaseId('66df38db-7f00-4b45-8520-6f0c70ed01a6'), '...70ed01a6');
});
