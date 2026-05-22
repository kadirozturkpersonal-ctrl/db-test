const { execSync } = require('child_process');
const { log } = require('./debug');
const { D1ImportAPI } = require('./d1-import-api');

/**
 * Adapter to save scraped data to Cloudflare D1 using Wrangler CLI
 */
class D1Adapter {
    constructor(databaseName = 'echr-db') {
        this.databaseName = databaseName;
        // Representative cache: { name: id }
        this.repCache = new Map();
        this.cacheCounter = 0;
        this.CACHE_FLUSH_INTERVAL = 10; // Flush cache every 10 cases

        // Initialize D1 Import API if credentials available
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiToken = process.env.CLOUDFLARE_API_TOKEN;
        const databaseId = '141a3109-a007-4ba6-8ead-bc9649276011';

        if (accountId && apiToken) {
            this.importAPI = new D1ImportAPI(accountId, databaseId, apiToken);
            log('✅ D1 Import API initialized (fast mode enabled)', true);
        } else {
            this.importAPI = null;
            log('⚠️  D1 Import API not available - using Wrangler CLI (slower)', true);
        }
    }

    /**
     * Check if case should be marked as closed based on last event
     */
    isCaseClosed(lastMajorEvent) {
        if (!lastMajorEvent) return false;

        const eventLower = lastMajorEvent.toLowerCase();
        return eventLower.includes('finished') || eventLower.includes('inadmissible');
    }

    /**
     * Execute a SQL command on D1
     */
    executeSQL(sql) {
        try {
            // Escape quotes in SQL
            const escapedSQL = sql.replace(/"/g, '\\"');

            const command = `npx wrangler d1 execute ${this.databaseName} --command "${escapedSQL}" --remote`;

            log('   🔧 Executing SQL...');
            const result = execSync(command, {
                encoding: 'utf-8',
                cwd: process.cwd(), // Run from echr-app folder
                env: {
                    ...process.env,
                    // Pass Cloudflare credentials from environment
                    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
                    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID
                }
            });

            return result;
        } catch (error) {
            log(`   ❌ SQL Error: ${error.message}`, true);
            throw error;
        }
    }

    /**
     * Convert DD/MM/YYYY to YYYY-MM-DD for SQLite
     */
    convertDate(dateStr) {
        if (!dateStr) return null;

        // Check if already in YYYY-MM-DD format
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            return dateStr;
        }

        // Parse DD/MM/YYYY
        const [day, month, year] = dateStr.split('/');
        if (!day || !month || !year) return null;

        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    /**
     * Extract country from title "Zhukov v. Russia" -> "Russia"
     */
    extractCountry(title) {
        const match = title.match(/v\.\s+(.+)$/);
        return match ? match[1].trim() : null;
    }

    /**
     * Find or create representative, returns the ID (WITH CACHING)
     */
    async findOrCreateRepresentative(name) {
        if (!name) {
            throw new Error('Representative name is required');
        }

        // Check cache first
        if (this.repCache.has(name)) {
            const cachedId = this.repCache.get(name);
            log(`   💾 Representative found in cache: ${name} (ID: ${cachedId})`);
            return cachedId;
        }

        log(`   👤 Finding/creating representative: ${name}`);

        // Check if exists in database
        const checkSQL = `SELECT id FROM representatives WHERE name = '${name.replace(/'/g, "''")}'`;

        try {
            const result = this.executeSQL(checkSQL);

            // Parse the result to check if representative exists
            if (result && result.includes('"id"')) {
                // Extract ID from JSON result
                const idMatch = result.match(/"id":\s*(\d+)/);
                if (idMatch) {
                    const id = parseInt(idMatch[1]);
                    log(`   ✅ Representative exists with ID: ${id}`);

                    // Add to cache
                    this.repCache.set(name, id);

                    return id;
                }
            }
        } catch (error) {
            log('   ℹ️  Representative not found, creating new...');
        }

        // Create new representative - use INSERT OR IGNORE to handle duplicates
        const insertSQL = `INSERT OR IGNORE INTO representatives (name) VALUES ('${name.replace(/'/g, "''")}')`;
        this.executeSQL(insertSQL);

        // Get the ID (whether newly created or already existed)
        const getIdSQL = `SELECT id FROM representatives WHERE name = '${name.replace(/'/g, "''")}'`;
        const idResult = this.executeSQL(getIdSQL);
        const idMatch = idResult.match(/"id":\s*(\d+)/);

        if (idMatch) {
            const newId = parseInt(idMatch[1]);
            log(`   ✅ Representative ID: ${newId}`);

            // Add to cache
            this.repCache.set(name, newId);

            return newId;
        }

        throw new Error('Failed to get representative ID');
    }

    /**
     * Flush representative cache every N cases to prevent memory issues
     */
    flushCacheIfNeeded() {
        this.cacheCounter++;

        if (this.cacheCounter >= this.CACHE_FLUSH_INTERVAL) {
            const cacheSize = this.repCache.size;
            this.repCache.clear();
            this.cacheCounter = 0;
            log(`   🧹 Cache flushed! (Had ${cacheSize} representatives cached)`, true);
        }
    }

    /**
      * Save complete application data to D1 (OPTIMIZED WITHOUT TRANSACTIONS)
      */
    async saveApplication(data) {
        log(`\n💾 Saving to D1: ${data.applicationNumber}`);

        try {
            // 1. Find or create representative (if exists)
            let representativeId = null;

            if (data.representant && data.representant.trim()) {
                representativeId = await this.findOrCreateRepresentative(data.representant);
            } else {
                log('   ℹ️  No representative provided');
            }

            // 2. Convert dates
            const dateIntroduction = this.convertDate(data.dateIntroduction);
            const lastMajorEventDate = this.convertDate(data.lastMajorEventDate);
            const country = this.extractCountry(data.applicationTitle);
            const isClosed = this.isCaseClosed(data.lastMajorEvent);
            if (isClosed) {
                log(`   🔒 Case will be marked as CLOSED`, true);
            }

            log(`   🌍 Country: ${country}`);
            log(`   📅 Date intro: ${dateIntroduction}`);
            log(`   📆 Last event: ${lastMajorEventDate}`);

            // 3. Escape single quotes in text fields
            const escapeSQL = (str) => str ? str.replace(/'/g, "''") : null;

            // 4. Insert/Update application
            const appSQL = `
                INSERT INTO applications (
                    application_number, application_title, country, date_introduction,
                    representative_id, representative_name, last_major_event, last_major_event_date,
                    is_closed, last_checked_date
                ) VALUES (
                    '${data.applicationNumber}',
                    '${escapeSQL(data.applicationTitle)}',
                    ${country ? `'${escapeSQL(country)}'` : 'NULL'},
                    '${dateIntroduction}',
                    ${representativeId || 'NULL'},
                    ${data.representant ? `'${escapeSQL(data.representant)}'` : 'NULL'},
                    ${data.lastMajorEvent ? `'${escapeSQL(data.lastMajorEvent)}'` : 'NULL'},
                    ${lastMajorEventDate ? `'${lastMajorEventDate}'` : 'NULL'},
                    ${isClosed ? 1 : 0},
                    DATE('now')
                )
                ON CONFLICT(application_number) DO UPDATE SET
                    application_title = excluded.application_title,
                    country = excluded.country,
                    date_introduction = excluded.date_introduction,
                    representative_id = excluded.representative_id,
                    representative_name = excluded.representative_name,
                    last_major_event = excluded.last_major_event,
                    last_major_event_date = excluded.last_major_event_date,
                    is_closed = excluded.is_closed,
                    last_checked_date = DATE('now'),
                    not_found_count = 0,
                    updated_at = CURRENT_TIMESTAMP
            `;

            log('   🔧 Saving application...');
            this.executeSQL(appSQL);
            log('   ✅ Application saved!');

            // 5. Get application ID (needed for events)
            const getAppIdSQL = `SELECT id FROM applications WHERE application_number = '${data.applicationNumber}'`;
            const appIdResult = this.executeSQL(getAppIdSQL);
            const appIdMatch = appIdResult.match(/"id":\s*(\d+)/);

            if (!appIdMatch) {
                throw new Error('Failed to get application ID');
            }

            const applicationId = parseInt(appIdMatch[1]);

            // 6. Delete old events + Insert all new events in ONE big query
            log(`   📋 Saving ${data.majorEventsList.length} events...`, true);

            // Build multi-row INSERT for all events
            const eventValues = data.majorEventsList.map((event, i) => {
                const eventDate = this.convertDate(event.eventDate);
                const isLastEvent = (i === data.majorEventsList.length - 1) ? 1 : 0;
                return `(${applicationId}, '${eventDate}', '${escapeSQL(event.description)}', ${isLastEvent})`;
            }).join(',\n                ');

            const eventsSQL = `
                DELETE FROM events WHERE application_id = ${applicationId};
                INSERT INTO events (application_id, event_date, description, is_last_event)
                VALUES ${eventValues}
            `;

            this.executeSQL(eventsSQL);
            log('   🎉 Complete!\n', true);

            // Flush cache if needed (every 10 cases)
            this.flushCacheIfNeeded();

            return true;

        } catch (error) {
            log(`   ❌ Failed to save: ${error.message}`, true);
            return false;
        }
    }

    /**
     * Build SQL for batch import (multiple cases at once)
     */
    buildBatchSQL(casesData) {
        const sqlStatements = [];

        for (const data of casesData) {
            try {
                // 1. Find or create representative (still need this for ID)
                let representativeId = null;
                if (data.representant && data.representant.trim()) {
                    // Check cache only (don't create during batch build)
                    if (this.repCache.has(data.representant)) {
                        representativeId = this.repCache.get(data.representant);
                    }
                    // If not cached, we'll handle it separately
                }

                // 2. Convert dates
                const dateIntroduction = this.convertDate(data.dateIntroduction);
                const lastMajorEventDate = this.convertDate(data.lastMajorEventDate);
                const country = this.extractCountry(data.applicationTitle);
                const isClosed = this.isCaseClosed(data.lastMajorEvent);

                // 3. Escape function
                const escapeSQL = (str) => str ? str.replace(/'/g, "''") : null;

                // 4. Build application INSERT
                const appSQL = `
                    INSERT INTO applications (
                        application_number, application_title, country, date_introduction,
                        representative_id, representative_name, last_major_event, last_major_event_date,
                        is_closed, last_checked_date
                    ) VALUES (
                        '${data.applicationNumber}',
                        '${escapeSQL(data.applicationTitle)}',
                        ${country ? `'${escapeSQL(country)}'` : 'NULL'},
                        '${dateIntroduction}',
                        ${representativeId || 'NULL'},
                        ${data.representant ? `'${escapeSQL(data.representant)}'` : 'NULL'},
                        ${data.lastMajorEvent ? `'${escapeSQL(data.lastMajorEvent)}'` : 'NULL'},
                        ${lastMajorEventDate ? `'${lastMajorEventDate}'` : 'NULL'},
                        ${isClosed ? 1 : 0},
                        DATE('now')
                    )
                    ON CONFLICT(application_number) DO UPDATE SET
                        application_title = excluded.application_title,
                        country = excluded.country,
                        date_introduction = excluded.date_introduction,
                        representative_id = excluded.representative_id,
                        representative_name = excluded.representative_name,
                        last_major_event = excluded.last_major_event,
                        last_major_event_date = excluded.last_major_event_date,
                        is_closed = excluded.is_closed,
                        last_checked_date = DATE('now'),
                        not_found_count = 0,
                        updated_at = CURRENT_TIMESTAMP;`;

                sqlStatements.push(appSQL);

                // 5. Build events DELETE + INSERT
                const deleteSQL = `DELETE FROM events WHERE application_id = (SELECT id FROM applications WHERE application_number = '${data.applicationNumber}');`;
                sqlStatements.push(deleteSQL);

                // 6. Build multi-row events INSERT
                const eventValues = data.majorEventsList.map((event, i) => {
                    const eventDate = this.convertDate(event.eventDate);
                    const isLastEvent = (i === data.majorEventsList.length - 1) ? 1 : 0;
                    return `((SELECT id FROM applications WHERE application_number = '${data.applicationNumber}'), '${eventDate}', '${escapeSQL(event.description)}', ${isLastEvent})`;
                }).join(',\n                ');

                const eventsSQL = `INSERT INTO events (application_id, event_date, description, is_last_event) VALUES ${eventValues};`;
                sqlStatements.push(eventsSQL);

            } catch (error) {
                log(`   ⚠️  Skipping case ${data.applicationNumber} in batch: ${error.message}`, true);
            }
        }

        return sqlStatements.join('\n');
    }


    /**
     * Save multiple cases at once using Import API (OPTIMIZED VERSION)
     */
    async saveBatch(casesData) {
        if (!casesData || casesData.length === 0) {
            return { success: 0, failed: 0 };
        }

        log(`\n🚀 Batch saving ${casesData.length} cases...`, true);

        // Use Import API (fast!)
        if (this.importAPI) {
            try {
                // Build complete SQL with representatives included
                const batchSQL = this.buildBatchSQLWithReps(casesData);

                // Upload via Import API - ONE CALL DOES EVERYTHING!
                await this.importAPI.uploadSQL(batchSQL);

                log(`   ✅ Batch complete: ${casesData.length} cases saved via Import API!`, true);

                return { success: casesData.length, failed: 0 };
            } catch (error) {
                log(`   ❌ Batch import failed: ${error.message}`, true);
                log('   🔄 Falling back to individual saves...', true);
                // Fall through to individual saves as backup
            }
        }

        // Fallback: Save individually (slower but reliable)
        let successCount = 0;
        let failCount = 0;

        for (const data of casesData) {
            const saved = await this.saveApplication(data);
            if (saved) {
                successCount++;
            } else {
                failCount++;
            }
        }

        return { success: successCount, failed: failCount };
    }

    /**
     * Build SQL for batch import INCLUDING representative handling
     */
    buildBatchSQLWithReps(casesData) {
        const sqlStatements = [];
        const escapeSQL = (str) => str ? str.replace(/'/g, "''") : null;

        // 1. First, handle ALL representatives at once
        const uniqueReps = [...new Set(casesData
            .map(d => d.representant)
            .filter(r => r && r.trim()))];

        if (uniqueReps.length > 0) {
            log(`   👥 Including ${uniqueReps.length} unique representatives in batch...`, true);

            // INSERT OR IGNORE creates only if doesn't exist
            const repValues = uniqueReps
                .map(name => `('${escapeSQL(name)}')`)
                .join(',\n        ');

            sqlStatements.push(
                `INSERT OR IGNORE INTO representatives (name) VALUES\n        ${repValues};`
            );
        }

        // 2. Build all application INSERTS/UPDATES
        const appStatements = [];
        const eventStatements = [];

        for (const data of casesData) {
            try {
                // Convert dates
                const dateIntroduction = this.convertDate(data.dateIntroduction);
                const lastMajorEventDate = this.convertDate(data.lastMajorEventDate);
                const country = this.extractCountry(data.applicationTitle);
                const isClosed = this.isCaseClosed(data.lastMajorEvent);

                // Build representative subquery (gets ID from the table)
                const repSubquery = data.representant && data.representant.trim()
                    ? `(SELECT id FROM representatives WHERE name='${escapeSQL(data.representant)}' LIMIT 1)`
                    : 'NULL';

                // Application INSERT/UPDATE
                appStatements.push(`
                    INSERT INTO applications (
                        application_number, application_title, country, date_introduction,
                        representative_id, representative_name, last_major_event, last_major_event_date,
                        is_closed, last_checked_date, not_found_count, updated_at
                    ) VALUES (
                        '${data.applicationNumber}',
                        '${escapeSQL(data.applicationTitle)}',
                        ${country ? `'${escapeSQL(country)}'` : 'NULL'},
                        '${dateIntroduction}',
                        ${repSubquery},
                        ${data.representant ? `'${escapeSQL(data.representant)}'` : 'NULL'},
                        ${data.lastMajorEvent ? `'${escapeSQL(data.lastMajorEvent)}'` : 'NULL'},
                        ${lastMajorEventDate ? `'${lastMajorEventDate}'` : 'NULL'},
                        ${isClosed ? 1 : 0},
                        DATE('now'),
                        0,
                        CURRENT_TIMESTAMP
                    )
                    ON CONFLICT(application_number) DO UPDATE SET
                        application_title = excluded.application_title,
                        country = excluded.country,
                        date_introduction = excluded.date_introduction,
                        representative_id = excluded.representative_id,
                        representative_name = excluded.representative_name,
                        last_major_event = excluded.last_major_event,
                        last_major_event_date = excluded.last_major_event_date,
                        is_closed = excluded.is_closed,
                        last_checked_date = DATE('now'),
                        not_found_count = 0,
                        updated_at = CURRENT_TIMESTAMP;`);

                // Delete old events for this case
                eventStatements.push(
                    `DELETE FROM events WHERE application_id = (SELECT id FROM applications WHERE application_number = '${data.applicationNumber}');`
                );

                // Insert new events
                if (data.majorEventsList && data.majorEventsList.length > 0) {
                    const eventValues = data.majorEventsList.map((event, i) => {
                        const eventDate = this.convertDate(event.eventDate);
                        const isLastEvent = (i === data.majorEventsList.length - 1) ? 1 : 0;
                        return `((SELECT id FROM applications WHERE application_number = '${data.applicationNumber}'), '${eventDate}', '${escapeSQL(event.description)}', ${isLastEvent})`;
                    }).join(',\n        ');

                    eventStatements.push(
                        `INSERT INTO events (application_id, event_date, description, is_last_event) VALUES\n        ${eventValues};`
                    );
                }

            } catch (error) {
                log(`   ⚠️  Skipping case ${data.applicationNumber} in batch: ${error.message}`, true);
            }
        }

        // 3. Combine all SQL statements
        sqlStatements.push(...appStatements);
        sqlStatements.push(...eventStatements);

        log(`   📝 Built SQL batch: ${uniqueReps.length} reps, ${casesData.length} cases, ${eventStatements.length / 2} event sets`, true);

        return sqlStatements.join('\n');
    }

    /**
     * Mark application as not found (increment counter)
     */
    async markAsNotFound(applicationNumber, applicationYear) {
        const fullNumber = `${applicationNumber}/${applicationYear}`;
        log(`\n⚠️  Marking as not found: ${fullNumber}`);

        try {
            const sql = `
				UPDATE applications 
				SET 
					not_found_count = not_found_count + 1,
					last_checked_date = DATE('now'),
					skip_scraping = CASE 
						WHEN not_found_count + 1 >= 60 THEN 1 
						ELSE skip_scraping 
					END,
					updated_at = CURRENT_TIMESTAMP
				WHERE application_number = '${fullNumber}'
			`;

            this.executeSQL(sql);
            log('   ✅ Updated not_found_count\n', true);
            return true;

        } catch (error) {
            log('   ℹ️  Case does not exist in database yet (first check)\n', true);
            return false;
        }
    }
}

module.exports = { D1Adapter };