const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'wrangler.jsonc');

function maskDatabaseId(databaseId) {
    const value = String(databaseId || '').trim();
    return value ? `...${value.slice(-8)}` : '<missing>';
}

function loadWranglerD1Target(databaseName = 'echr-db', configPath = DEFAULT_CONFIG_PATH) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const target = (config.d1_databases || []).find(database => database.database_name === databaseName);

    if (!target?.database_id) {
        throw new Error(`D1 database ${databaseName} is missing from ${configPath}`);
    }

    return {
        databaseName: target.database_name,
        databaseId: String(target.database_id).trim(),
        configPath
    };
}

function assertSingleD1Target(envDatabaseId, target) {
    const configuredId = String(envDatabaseId || '').trim();

    if (!configuredId) {
        throw new Error('CLOUDFLARE_D1_DATABASE_ID secret is required');
    }

    if (configuredId !== target.databaseId) {
        throw new Error(
            `D1 target mismatch: GitHub secret ${maskDatabaseId(configuredId)} does not match Wrangler ${maskDatabaseId(target.databaseId)}`
        );
    }

    return target;
}

function verifyConfiguredD1Target(databaseName = 'echr-db') {
    const target = loadWranglerD1Target(databaseName);
    assertSingleD1Target(process.env.CLOUDFLARE_D1_DATABASE_ID, target);
    return target;
}

if (require.main === module) {
    const target = verifyConfiguredD1Target();
    console.log(`D1 target verified: ${target.databaseName} (${maskDatabaseId(target.databaseId)})`);
}

module.exports = {
    assertSingleD1Target,
    loadWranglerD1Target,
    maskDatabaseId,
    verifyConfiguredD1Target
};
