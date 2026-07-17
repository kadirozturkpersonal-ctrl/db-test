const ACTIVE_KEY = 'current-year';
const OVERLAP_SIZE = 500;
const MAX_CONSECUTIVE_EMPTY = 500;

class CurrentScanQueue {
    constructor(d1) {
        this.d1 = d1;
        this.ready = false;
    }

    async ensureSchema() {
        if (this.ready) return;
        await this.d1.querySQL(`
            CREATE TABLE IF NOT EXISTS echr_current_scan_requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                active_key TEXT UNIQUE,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'summarized', 'failed')),
                target_year INTEGER,
                observed_max_number INTEGER,
                start_number INTEGER,
                current_number INTEGER,
                consecutive_empty INTEGER NOT NULL DEFAULT 0,
                found_count INTEGER NOT NULL DEFAULT 0,
                checked_count INTEGER NOT NULL DEFAULT 0,
                technical_error_count INTEGER NOT NULL DEFAULT 0,
                error_message TEXT,
                requested_at TEXT NOT NULL,
                claimed_at TEXT,
                completed_at TEXT,
                summary_started_at TEXT,
                summary_refreshed_at TEXT,
                updated_at TEXT NOT NULL
            )
        `);
        await this.d1.querySQL(`
            CREATE INDEX IF NOT EXISTS idx_echr_current_scan_status_updated
            ON echr_current_scan_requests(status, updated_at DESC)
        `);
        this.ready = true;
    }

    async loadActive() {
        await this.ensureSchema();
        const rows = await this.d1.querySQL(`
            SELECT * FROM echr_current_scan_requests
            WHERE active_key = '${ACTIVE_KEY}'
              AND status IN ('pending', 'running')
            ORDER BY id ASC
            LIMIT 1
        `);
        return rows[0] || null;
    }

    async claimOrResume() {
        const request = await this.loadActive();
        if (!request) return null;
        if (request.status === 'running') return normalizeRequest(request);

        const targetYear = new Date().getFullYear();
        const suffix = String(targetYear).slice(-2).padStart(2, '0');
        const rows = await this.d1.querySQL(`
            SELECT COALESCE(MAX(
                CASE
                    WHEN INSTR(application_number, '/') > 1
                    THEN CAST(SUBSTR(application_number, 1, INSTR(application_number, '/') - 1) AS INTEGER)
                    ELSE 0
                END
            ), 0) AS max_number
            FROM applications
            WHERE TRIM(application_number) LIKE '%/${suffix}'
        `);
        const observedMax = Math.max(0, Number(rows[0]?.max_number || 0));
        const startNumber = calculatePriorityStart(observedMax, OVERLAP_SIZE);
        const now = new Date().toISOString();
        await this.d1.querySQL(`
            UPDATE echr_current_scan_requests
            SET status = 'running', target_year = ?, observed_max_number = ?,
                start_number = ?, current_number = ?, consecutive_empty = 0,
                error_message = NULL, claimed_at = COALESCE(claimed_at, ?), updated_at = ?
            WHERE id = ? AND status = 'pending'
        `, [targetYear, observedMax, startNumber, startNumber, now, now, request.id]);
        return normalizeRequest({
            ...request,
            status: 'running',
            target_year: targetYear,
            observed_max_number: observedMax,
            start_number: startNumber,
            current_number: startNumber,
            consecutive_empty: 0,
            claimed_at: request.claimed_at || now,
            updated_at: now
        });
    }

    async saveProgress(request, progress) {
        const now = new Date().toISOString();
        await this.d1.querySQL(`
            UPDATE echr_current_scan_requests
            SET current_number = ?, consecutive_empty = ?, found_count = ?,
                checked_count = ?, technical_error_count = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [
            progress.currentNumber,
            progress.consecutiveEmpty,
            progress.foundCount,
            progress.checkedCount,
            progress.technicalErrorCount,
            progress.errorMessage || null,
            now,
            request.id
        ]);
    }

    async complete(request, progress) {
        const now = new Date().toISOString();
        await this.d1.querySQL(`
            UPDATE echr_current_scan_requests
            SET active_key = NULL, status = 'completed', current_number = ?,
                consecutive_empty = ?, found_count = ?, checked_count = ?,
                technical_error_count = ?, error_message = NULL,
                completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running'
        `, [
            progress.currentNumber,
            progress.consecutiveEmpty,
            progress.foundCount,
            progress.checkedCount,
            progress.technicalErrorCount,
            now,
            now,
            request.id
        ]);
    }

    async fail(request, error) {
        const now = new Date().toISOString();
        const message = String(error?.message || error || 'Unknown priority scan error').slice(0, 2000);
        await this.d1.querySQL(`
            UPDATE echr_current_scan_requests
            SET active_key = NULL, status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('pending', 'running')
        `, [message, now, now, request.id]);
    }
}

function calculatePriorityStart(observedMax, overlap = OVERLAP_SIZE) {
    return Math.max(1, Math.max(0, Number(observedMax) || 0) - Math.max(0, Number(overlap) || 0));
}

function shouldCompletePriorityScan(currentNumber, observedMax, consecutiveEmpty, limit = MAX_CONSECUTIVE_EMPTY) {
    return Number(currentNumber) > Number(observedMax)
        && Number(consecutiveEmpty) >= Number(limit);
}

function normalizeRequest(row) {
    return {
        ...row,
        id: Number(row.id),
        target_year: Number(row.target_year),
        observed_max_number: Number(row.observed_max_number || 0),
        start_number: Math.max(1, Number(row.start_number || 1)),
        current_number: Math.max(1, Number(row.current_number || row.start_number || 1)),
        consecutive_empty: Math.max(0, Number(row.consecutive_empty || 0)),
        found_count: Math.max(0, Number(row.found_count || 0)),
        checked_count: Math.max(0, Number(row.checked_count || 0)),
        technical_error_count: Math.max(0, Number(row.technical_error_count || 0))
    };
}

module.exports = {
    CurrentScanQueue,
    MAX_CONSECUTIVE_EMPTY,
    OVERLAP_SIZE,
    calculatePriorityStart,
    shouldCompletePriorityScan
};
