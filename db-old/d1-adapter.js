const { execSync } = require('child_process');
const { log } = require('./debug');
const path = require('node:path');
const { maskDatabaseId, verifyConfiguredD1Target } = require('./d1-target');
const { D1CostTracker } = require('./d1-cost-tracker');
const { isD1StopError } = require('./d1-runtime-errors');
const quotaBlocks = new Map();

// D1's DATE('now') is UTC. More importantly, the Import API de-duplicates an
// identical SQL payload by its hash. A dynamic DATE('now', ...) expression
// therefore caused an unchanged application to be treated as an old import on
// the next day, leaving last_checked_date on yesterday. Embed today's Istanbul
// business date in the SQL text so each daily payload is both timezone-correct
// and unique to that business day.
function getIstanbulBusinessDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

const ISTANBUL_SQL_DATE = `'${getIstanbulBusinessDate()}'`;

/**
 * Measured REST adapter for small scraper packages.
 */
class D1Adapter {
    constructor(databaseName = 'echr-db') {
        this.databaseName = databaseName;
        const target = verifyConfiguredD1Target(databaseName);
        this.databaseId = target.databaseId;
        log(`[D1] Target verified: ${databaseName} (${maskDatabaseId(this.databaseId)})`, true);

        // Representative cache: { name: id }
        this.repCache = new Map();
        this.cacheCounter = 0;
        this.CACHE_FLUSH_INTERVAL = 10; // Flush cache every 10 cases
        this.sopNoInfoTrackingReady = false;
        this.costTracker = new D1CostTracker();
        this.costReportFile = process.env.D1_COST_REPORT_FILE || path.resolve(__dirname, '../local-data/d1-query-costs.json');
    }

    async fetchWithRetry(url, options, label, maxAttempts = 3, onRetry = () => {}) {
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30_000);
            try {
                const response = await fetch(url, { ...options, signal: controller.signal });
                // Authentication and SQL validation failures are permanent. Only retry
                // transient service pressure and upstream gateway failures.
                if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === maxAttempts) {
                    return response;
                }
                lastError = new Error(`${label} HTTP ${response.status}`);
            } catch (error) {
                lastError = error;
                if (attempt === maxAttempts) throw error;
            } finally {
                clearTimeout(timeout);
            }

            const delayMs = attempt * 1000;
            onRetry();
            log(`   ⚠️  ${label} temporarily failed (${lastError.message}); retrying in ${delayMs}ms.`, true);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        throw lastError;
    }

    /**
     * Query D1 through the REST API when credentials are available.
     */
    async querySQL(sql, params = []) {
        const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
        const apiToken = process.env.CLOUDFLARE_API_TOKEN;

        const block = quotaBlocks.get(accountId);
        if (block && block.until > Date.now()) throw block.error;
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

        const readOnly = /^\s*(SELECT|EXPLAIN|PRAGMA)\b/i.test(sql);
        let response;
        try { response = await this.fetchWithRetry(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ sql, params })
            },
            'D1 SQL',
            readOnly ? 3 : 1,
            () => this.costTracker.record(sql, [])
        ); } catch (error) {
            this.costTracker.record(sql, []);
            try { this.costTracker.save(this.costReportFile); } catch { /* Never replay a write because telemetry failed. */ }
            error.code = readOnly ? 'D1_READ_FAILED' : 'D1_WRITE_FAILED';
            throw error;
        }
        const payload = await response.json().catch(() => null);
        this.costTracker.record(sql, payload?.result || []);
        try { this.costTracker.save(this.costReportFile); }
        catch (error) { log(`D1 cost report could not be saved: ${error.code || 'IO_ERROR'}`, true); }
        const apiErrors = payload?.errors?.map(error => error.message).filter(Boolean);

        if (!response.ok || payload?.success === false) {
            const error = new Error(apiErrors?.join('; ') || `Cloudflare D1 HTTP ${response.status}`);
            if (isD1StopError(error)) {
                error.code = 'D1_QUOTA_EXCEEDED';
                const now = new Date();
                quotaBlocks.set(accountId, { error, until: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) });
            } else error.code = 'D1_SQL_FAILED';
            throw error;
        }

        const failedResult = payload?.result?.find(result => result.success === false);
        if (failedResult) throw Object.assign(new Error(failedResult.error || 'Cloudflare D1 query failed'), { code: 'D1_SQL_FAILED' });
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

    cleanTextField(value, fieldName, maxLength, required = false) {
        if (value === undefined || value === null) {
            if (required) {
                throw new Error(`${fieldName} is required`);
            }
            return null;
        }

        const text = String(value).trim();
        if (!text) {
            if (required) {
                throw new Error(`${fieldName} is required`);
            }
            return null;
        }

        if (text.length > maxLength) {
            throw new Error(`${fieldName} is too long (${text.length}/${maxLength})`);
        }

        return text;
    }

    cleanDateField(value, fieldName, required = false) {
        const text = this.cleanTextField(value, fieldName, 20, required);
        if (!text) {
            return null;
        }

        if (!/^(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(text)) {
            throw new Error(`${fieldName} has invalid date format: ${text}`);
        }

        return text;
    }

    normalizeApplicationData(data) {
        if (!data || typeof data !== 'object') {
            throw new Error('application data must be an object');
        }

        const applicationNumber = this.cleanTextField(data.applicationNumber, 'applicationNumber', 20, true);
        if (!/^\d+\/\d{2}$/.test(applicationNumber)) {
            throw new Error(`applicationNumber has invalid format: ${applicationNumber}`);
        }

        const majorEventsList = Array.isArray(data.majorEventsList)
            ? data.majorEventsList.map((event, index) => ({
                description: this.cleanTextField(event?.description, `majorEventsList[${index}].description`, 2000, true),
                eventDate: this.cleanDateField(event?.eventDate, `majorEventsList[${index}].eventDate`, true)
            }))
            : [];

        return {
            ...data,
            applicationNumber,
            applicationTitle: this.cleanTextField(data.applicationTitle, 'applicationTitle', 1000, true),
            dateIntroduction: this.cleanDateField(data.dateIntroduction, 'dateIntroduction'),
            representant: this.cleanTextField(data.representant, 'representant', 1000),
            lastMajorEvent: this.cleanTextField(data.lastMajorEvent, 'lastMajorEvent', 2000),
            lastMajorEventDate: this.cleanDateField(data.lastMajorEventDate, 'lastMajorEventDate'),
            majorEventsList
        };
    }

    validateApplications(casesData) {
        const valid = [];
        let failed = 0;

        for (const data of casesData) {
            try {
                valid.push(this.normalizeApplicationData(data));
            } catch (error) {
                const applicationNumber = data?.applicationNumber || 'unknown';
                failed++;
                log(`   ⚠️  Skipping invalid case ${applicationNumber}: ${error.message}`, true);
            }
        }

        return { valid, failed };
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
              AND first_not_found_date <= DATE('now', '-${days} days')
        `);
    }

    async loadKnownApplicationNumbers() {
        const known = new Set();
        const limit = 10000;
        let afterId = 0;

        for (;;) {
            const rows = await this.querySQL(`
                SELECT id, application_number
                FROM applications
                WHERE id > ${afterId}
                  AND application_number IS NOT NULL
                  AND TRIM(application_number) <> ''
                ORDER BY id ASC
                LIMIT ${limit}
            `);

            for (const row of rows) {
                if (row.application_number) {
                    known.add(String(row.application_number).trim());
                }
            }

            if (rows.length < limit) {
                break;
            }

            afterId = rows[rows.length - 1].id;
        }

        return known;
    }

    async loadAdministrativelyRejectedApplicationNumbers() {
        await this.ensureSOPNoInfoTracking();
        const rejected = new Set();
        const limit = 10000;
        let afterNumber = '';

        for (;;) {
            const rows = await this.querySQL(`
                SELECT application_number
                FROM sop_no_info_tracking
                WHERE status = 'administrative_rejection'
                  AND application_number > '${this.escapeSQL(afterNumber)}'
                ORDER BY application_number ASC
                LIMIT ${limit}
            `);

            for (const row of rows) {
                if (row.application_number) {
                    rejected.add(String(row.application_number).trim());
                }
            }

            if (rows.length < limit) {
                break;
            }

            afterNumber = rows[rows.length - 1].application_number;
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
            if (isD1StopError(error)) throw error;
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
        let afterId = 0;
        const escapeSQL = (str) => str.replace(/'/g, "''");
        const finalEventValues = finalEvents.map(event => `'${escapeSQL(event)}'`).join(', ');

        for (;;) {
            const rows = await this.querySQL(
                `
                    SELECT id, application_number
                    FROM applications
                    WHERE id > ${afterId}
                      AND application_number IS NOT NULL
                      AND TRIM(application_number) <> ''
                      AND (
                          is_closed = 1
                          OR last_major_event IN (${finalEventValues})
                          OR LOWER(last_major_event) LIKE 'decision to strike a case out of the list%'
                      )
                    ORDER BY id ASC
                    LIMIT ${limit}
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

            afterId = rows[rows.length - 1].id;
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
                    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
                    CLOUDFLARE_D1_DATABASE_ID: process.env.CLOUDFLARE_D1_DATABASE_ID
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
        try {
            const result = await this.saveBatch([data]);
            return result.success === 1 && result.failed === 0;
        } catch (error) {
            if (isD1StopError(error)) throw error;
            log(`   ❌ Failed to save: ${error.message}`, true);
            return false;
        }
    }
    /**
     * Build SQL for batch import (multiple cases at once)
     */
    buildBatchSQL(casesData) {
        const sqlStatements = [];

        for (const rawData of casesData) {
            try {
                const data = this.normalizeApplicationData(rawData);

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
                        ${dateIntroduction ? `'${dateIntroduction}'` : 'NULL'},
                        ${representativeId || 'NULL'},
                        ${data.representant ? `'${escapeSQL(data.representant)}'` : 'NULL'},
                        ${data.lastMajorEvent ? `'${escapeSQL(data.lastMajorEvent)}'` : 'NULL'},
                        ${lastMajorEventDate ? `'${lastMajorEventDate}'` : 'NULL'},
                        ${isClosed ? 1 : 0},
                        ${ISTANBUL_SQL_DATE}
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
                        last_checked_date = ${ISTANBUL_SQL_DATE},
                        not_found_count = 0,
                        updated_at = CURRENT_TIMESTAMP;`;

                sqlStatements.push(appSQL);

                // 5. Build events DELETE + INSERT
                const deleteSQL = `DELETE FROM events WHERE application_id = (SELECT id FROM applications WHERE application_number = '${data.applicationNumber}');`;
                sqlStatements.push(deleteSQL);

                // 6. Build multi-row events INSERT
                if (data.majorEventsList.length > 0) {
                    const eventValues = data.majorEventsList.map((event, i) => {
                        const eventDate = this.convertDate(event.eventDate);
                        const isLastEvent = (i === data.majorEventsList.length - 1) ? 1 : 0;
                        return `((SELECT id FROM applications WHERE application_number = '${data.applicationNumber}'), '${eventDate}', '${escapeSQL(event.description)}', ${isLastEvent})`;
                    }).join(',\n                ');

                    const eventsSQL = `INSERT INTO events (application_id, event_date, description, is_last_event) VALUES ${eventValues};`;
                    sqlStatements.push(eventsSQL);
                }

            } catch (error) {
                log(`   ⚠️  Skipping case ${rawData?.applicationNumber || 'unknown'} in batch: ${error.message}`, true);
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

        const validation = this.validateApplications(casesData);
        const validCases = validation.valid;

        if (validCases.length === 0) {
            log(`\n⚠️  Batch skipped: no valid cases (${validation.failed} invalid)`, true);
            return { success: 0, failed: validation.failed };
        }

        log(`\n🚀 Batch saving ${validCases.length} valid cases...`, true);
        if (validation.failed > 0) {
            log(`   ⚠️  Invalid cases skipped before D1 write: ${validation.failed}`, true);
        }

        // Small, recoverable REST batches expose actual rows_read/rows_written.
        // Do not replay an uncertain bulk import through a second write path.
        for (let offset = 0; offset < validCases.length; offset += 25) {
            const chunk = validCases.slice(offset, offset + 25);
            const unchangedEvents = await this.findUnchangedEvents(chunk);
            // A normal 25-case package is below D1's 100 KB SQL ceiling. Split
            // larger packages before sending anything from that package.
            await this.writeMeasuredBatch(chunk, unchangedEvents);
        }
        return { success: validCases.length, failed: validation.failed };
    }

    async findUnchangedEvents(casesData) {
        const numbers = [...new Set(casesData.map(data => data.applicationNumber))];
        const rows = await this.querySQL(`
            SELECT a.application_number, e.event_date, e.description, e.is_last_event
            FROM applications a JOIN events e ON e.application_id = a.id
            WHERE a.application_number IN (${numbers.map(() => '?').join(',')})
            ORDER BY a.id, e.id
        `, numbers);
        const byNumber = new Map(numbers.map(number => [number, []]));
        for (const row of rows) byNumber.get(row.application_number)?.push([
            row.event_date, row.description, Number(row.is_last_event) || 0
        ]);
        const unchanged = new Set();
        const changed = new Set();
        for (const data of casesData) {
            const next = data.majorEventsList.map((event, index) => [
                this.convertDate(event.eventDate), event.description,
                index === data.majorEventsList.length - 1 ? 1 : 0
            ]);
            if (!changed.has(data.applicationNumber) && JSON.stringify(byNumber.get(data.applicationNumber)) === JSON.stringify(next)) {
                unchanged.add(data.applicationNumber);
            } else {
                unchanged.delete(data.applicationNumber);
                changed.add(data.applicationNumber);
            }
        }
        return unchanged;
    }

    async writeMeasuredBatch(casesData, unchangedEvents) {
        const sql = this.buildBatchSQLWithReps(casesData, { unchangedEvents });
        if (Buffer.byteLength(sql, 'utf8') <= 90_000) {
            await this.querySQL(sql);
            return;
        }
        if (casesData.length === 1) throw new Error('D1 case package exceeds the safe SQL size limit; no fallback replay was attempted.');
        const middle = Math.ceil(casesData.length / 2);
        await this.writeMeasuredBatch(casesData.slice(0, middle), unchangedEvents);
        await this.writeMeasuredBatch(casesData.slice(middle), unchangedEvents);
    }

    // A daily check saves one small record, not a bulk database import. Keep
    // this on the bounded REST query path: no R2 upload, import polling,
    // Wrangler subprocess, or fallback that can outlive the scheduled task.
    async saveDailyApplication(data) {
        const normalized = this.normalizeApplicationData(data);
        return this.saveBatch([normalized]);
    }

    /**
     * Build SQL for batch import INCLUDING representative handling
     */
    buildBatchSQLWithReps(casesData, { unchangedEvents = new Set() } = {}) {
        casesData = this.validateApplications(casesData).valid;

        const sqlStatements = [];
        const escapeSQL = (str) => str ? str.replace(/'/g, "''") : null;

        // 1. First, handle ALL representatives at once
        const uniqueReps = [...new Set(casesData
            .map(d => d.representant)
            .filter(r => r && r.trim()))];

        if (uniqueReps.length > 0) {
            log(`   👥 Including ${uniqueReps.length} unique representatives in batch...`, true);

            // Avoid even attempting an AUTOINCREMENT insert for known names.
            for (const name of uniqueReps) {
                sqlStatements.push(`INSERT OR IGNORE INTO representatives (name)
                    SELECT '${escapeSQL(name)}'
                    WHERE NOT EXISTS (SELECT 1 FROM representatives WHERE name = '${escapeSQL(name)}');`);
            }
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
                        ${dateIntroduction ? `'${dateIntroduction}'` : 'NULL'},
                        ${repSubquery},
                        ${data.representant ? `'${escapeSQL(data.representant)}'` : 'NULL'},
                        ${data.lastMajorEvent ? `'${escapeSQL(data.lastMajorEvent)}'` : 'NULL'},
                        ${lastMajorEventDate ? `'${lastMajorEventDate}'` : 'NULL'},
                        ${isClosed ? 1 : 0},
                        ${ISTANBUL_SQL_DATE},
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
                        last_checked_date = ${ISTANBUL_SQL_DATE},
                        not_found_count = 0,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE applications.application_title IS NOT excluded.application_title
                       OR applications.country IS NOT excluded.country
                       OR applications.date_introduction IS NOT excluded.date_introduction
                       OR applications.representative_id IS NOT excluded.representative_id
                       OR applications.representative_name IS NOT excluded.representative_name
                       OR applications.last_major_event IS NOT excluded.last_major_event
                       OR applications.last_major_event_date IS NOT excluded.last_major_event_date
                       OR applications.is_closed IS NOT excluded.is_closed
                       OR applications.last_checked_date IS NOT excluded.last_checked_date
                       OR COALESCE(applications.not_found_count, 0) <> 0;`);

                if (unchangedEvents.has(data.applicationNumber)) continue;

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
                    last_checked_date = ${ISTANBUL_SQL_DATE},
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

module.exports = { D1Adapter, ISTANBUL_SQL_DATE, getIstanbulBusinessDate };
