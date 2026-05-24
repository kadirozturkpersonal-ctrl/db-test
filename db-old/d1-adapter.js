const { execSync } = require('child_process');
const { log } = require('./debug');
const { D1ImportAPI } = require('./d1-import-api');

/**
 * Adapter to save scraped data to Cloudflare D1 using Wrangler CLI
 */
class D1Adapter {
    constructor(databaseName = 'echr-db') {
        this.databaseName = databaseName;
        this.databaseId = '141a3109-a007-4ba6-8ead-bc9649276011';
        // Representative cache: { name: id }
        this.repCache = new Map();
        this.cacheCounter = 0;
        this.CACHE_FLUSH_INTERVAL = 10; // Flush cache every 10 cases
        this.sopNoInfoTrackingReady = false;

        // Initialize D1 Import API if credentials available
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiToken = process.env.CLOUDFLARE_API_TOKEN;
        const databaseId = this.databaseId;

        if (accountId && apiToken) {
            this.importAPI = new D1ImportAPI(accountId, databaseId, apiToken);
            log('✅ D1 Import API initialized (fast mode enabled)', true);
        } else {
            this.importAPI = null;
            log('⚠️  D1 Import API not available - using Wrangler CLI (slower)', true);
        }
    }

    /**
     * Query D1 through the REST API when credentials are available.
     */
    async querySQL(sql, params = []) {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiToken = process.env.CLOUDFLARE_API_TOKEN;

        if (!accountId || !apiToken) {
            const result = this.executeSQL(sql);
            const rows = [];

            for (const match of result.matchAll(/\{[^{}]*\}/g)) {
                try {
                    rows.push(JSON.parse(match[0]));
                } catch {
                    // Ignore non-row JSON fragments from wrangler output.
                }
            }

            return rows;
        }

        const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sql, params })
            }
        );
        const payload = await response.json().catch(() => null);
        const apiErrors = payload?.errors?.map(error => error.message).filter(Boolean);

        if (!response.ok || payload?.success === false) {
            throw new Error(apiErrors?.join('; ') || `Cloudflare D1 HTTP ${response.status}`);
        }

        const firstResult = payload?.result?.[0];
        if (!firstResult) {
            return [];
        }

        if (firstResult.success === false) {
            throw new Error(firstResult.error || 'Cloudflare D1 query failed');
        }

        return firstResult.results || [];
    }

    escapeSQL(str) {
        return String(str).replace(/'/g, "''");
    }

    async ensureSOPNoInfoTracking() {
        if (this.sopNoInfoTrackingReady) {
            return;
        }

        await this.querySQL(`
            CREATE TABLE IF NOT EXISTS sop_no_info_tracking (
                application_number TEXT PRIMARY KEY,
                first_not_found_date TEXT NOT NULL,
                last_not_found_date TEXT NOT NULL,
                not_found_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                administrative_rejection_date TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await this.querySQL(`
            CREATE INDEX IF NOT EXISTS idx_sop_no_info_tracking_status
            ON sop_no_info_tracking(status)
        `);

        await this.querySQL(`
            CREATE INDEX IF NOT EXISTS idx_sop_no_info_tracking_first_not_found
            ON sop_no_info_tracking(first_not_found_date)
        `);

        this.sopNoInfoTrackingReady = true;
    }

    async reconcileSOPNoInfoTracking(graceDays = 365) {
        await this.ensureSOPNoInfoTracking();
        const days = Math.max(1, parseInt(graceDays, 10) || 365);

        await this.querySQL(`
            DELETE FROM sop_no_info_tracking
            WHERE EXISTS (
                SELECT 1
                FROM applications
                WHERE applications.application_number = sop_no_info_tracking.application_number
            )
        `);

        await this.querySQL(`
            UPDATE sop_no_info_tracking
            SET
                status = 'administrative_rejection',
                administrative_rejection_date = COALESCE(administrative_rejection_date, DATE('now')),
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending'
              AND DATE(first_not_found_date, '+${days} days') <= DATE('now')
        `);
    }

    async loadKnownApplicationNumbers() {
        const known = new Set();
        const limit = 10000;
        let offset = 0;

        for (;;) {
            const rows = await this.querySQL(`
                SELECT application_number
                FROM applications
                WHERE application_number IS NOT NULL
                  AND TRIM(application_number) <> ''
                ORDER BY id ASC
                LIMIT ${limit} OFFSET ${offset}
            `);

            for (const row of rows) {
                if (row.application_number) {
                    known.add(String(row.application_number).trim());
                }
            }

            if (rows.length < limit) {
                break;
            }

            offset += limit;
        }

        return known;
    }

    async loadAdministrativelyRejectedApplicationNumbers() {
        await this.ensureSOPNoInfoTracking();
        const rejected = new Set();
        const limit = 10000;
        let offset = 0;

        for (;;) {
            const rows = await this.querySQL(`
                SELECT application_number
                FROM sop_no_info_tracking
                WHERE status = 'administrative_rejection'
                ORDER BY application_number ASC
                LIMIT ${limit} OFFSET ${offset}
            `);

            for (const row of rows) {
                if (row.application_number) {
                    rejected.add(String(row.application_number).trim());
                }
            }

            if (rows.length < limit) {
                break;
            }

            offset += limit;
        }

        return rejected;
    }

    buildClearSOPNoInfoSQL(applicationNumbers) {
        if (!this.sopNoInfoTrackingReady || !applicationNumbers || applicationNumbers.length === 0) {
            return '';
        }

        const values = [...new Set(applicationNumbers)]
            .filter(Boolean)
            .map(number => `'${this.escapeSQL(number)}'`);

        if (values.length === 0) {
            return '';
        }

        return `
            DELETE FROM sop_no_info_tracking
            WHERE application_number IN (${values.join(', ')});
        `;
    }

    async clearSOPNoInfoCandidates(applicationNumbers) {
        const sql = this.buildClearSOPNoInfoSQL(applicationNumbers);
        if (!sql) {
            return;
        }

        await this.querySQL(sql);
    }

    async saveSOPNoInfoBatch(applicationNumbers, graceDays = 365) {
        if (!applicationNumbers || applicationNumbers.length === 0) {
            return { success: 0, failed: 0 };
        }

        try {
            await this.ensureSOPNoInfoTracking();

            const days = Math.max(1, parseInt(graceDays, 10) || 365);
            const uniqueNumbers = [...new Set(applicationNumbers)]
                .filter(Boolean)
                .map(number => String(number).trim())
                .filter(Boolean);

            if (uniqueNumbers.length === 0) {
                return { success: 0, failed: 0 };
            }

            const values = uniqueNumbers
                .map(number => `('${this.escapeSQL(number)}', DATE('now'), DATE('now'), 1, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
                .join(',\n                ');

            await this.querySQL(`
                INSERT INTO sop_no_info_tracking (
                    application_number,
                    first_not_found_date,
                    last_not_found_date,
                    not_found_count,
                    status,
                    created_at,
                    updated_at
                ) VALUES
                ${values}
                ON CONFLICT(application_number) DO UPDATE SET
                    last_not_found_date = DATE('now'),
                    not_found_count = sop_no_info_tracking.not_found_count + 1,
                    status = CASE
                        WHEN sop_no_info_tracking.status = 'administrative_rejection'
                            THEN sop_no_info_tracking.status
                        WHEN DATE(sop_no_info_tracking.first_not_found_date, '+${days} days') <= DATE('now')
                            THEN 'administrative_rejection'
                        ELSE 'pending'
                    END,
                    administrative_rejection_date = CASE
                        WHEN sop_no_info_tracking.status != 'administrative_rejection'
                            AND DATE(sop_no_info_tracking.first_not_found_date, '+${days} days') <= DATE('now')
                            THEN DATE('now')
                        ELSE sop_no_info_tracking.administrative_rejection_date
                    END,
                    updated_at = CURRENT_TIMESTAMP
            `);

            const valueList = uniqueNumbers.map(number => `'${this.escapeSQL(number)}'`).join(', ');
            const rejectedRows = await this.querySQL(`
                SELECT application_number
                FROM sop_no_info_tracking
                WHERE status = 'administrative_rejection'
                  AND application_number IN (${valueList})
            `);
            const administrativeRejected = rejectedRows
                .map(row => row.application_number && String(row.application_number).trim())
                .filter(Boolean);

            log(`   📝 No-info tracking saved: ${uniqueNumbers.length}`, true);
            return { success: uniqueNumbers.length, failed: 0, administrativeRejected };
        } catch (error) {
            log(`   ⚠️  Failed to save no-info tracking: ${error.message}`, true);
            return { success: 0, failed: applicationNumbers.length, administrativeRejected: [] };
        }
    }

    /**
     * Load application numbers that reached a final successful or unsuccessful outcome.
     */
    async loadFinalizedApplicationNumbers() {
        const finalEvents = [
            'Decision to strike a case out of the list after a friendly settlement',
            'Decision to strike a case out of the list after a unilateral declaration',
            'Judgment on merits and just satisfaction final: case is finished',
            'Judgment on just satisfaction final: case is finished',
            'Decision to declare a case inadmissible',
            'Decision to declare a case inadmissible after reopening',
            'Decision to strike a case out of the list of cases'
        ];
        const finalized = new Set();
        const limit = 10000;
        let offset = 0;
        const escapeSQL = (str) => str.replace(/'/g, "''");
        const finalEventValues = finalEvents.map(event => `'${escapeSQL(event)}'`).join(', ');

        for (;;) {
            const rows = await this.querySQL(
                `
                    SELECT application_number
                    FROM applications
                    WHERE application_number IS NOT NULL
                      AND TRIM(application_number) <> ''
                      AND (
                          is_closed = 1
                          OR last_major_event IN (${finalEventValues})
                          OR LOWER(last_major_event) LIKE 'decision to strike a case out of the list%'
                      )
                    ORDER BY id ASC
                    LIMIT ${limit} OFFSET ${offset}
                `
            );

            for (const row of rows) {
                if (row.application_number) {
                    finalized.add(String(row.application_number).trim());
                }
            }

            if (rows.length < limit) {
                break;
            }

            offset += limit;
        }

        return finalized;
    }

    /**
     * Check if case should be marked as closed based on last event
     */
    isCaseClosed(lastMajorEvent) {
        if (!lastMajorEvent) return false;

        const eventLower = lastMajorEvent.toLowerCase();
        return eventLower.includes('finished')
            || eventLower.includes('inadmissible')
            || eventLower.startsWith('decision to strike a case out of the list');
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
            await this.clearSOPNoInfoCandidates([data.applicationNumber]);
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

        const clearNoInfoSQL = this.buildClearSOPNoInfoSQL(casesData.map(data => data.applicationNumber));
        if (clearNoInfoSQL) {
            sqlStatements.push(clearNoInfoSQL);
        }

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
