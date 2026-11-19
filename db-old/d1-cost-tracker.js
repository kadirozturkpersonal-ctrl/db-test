const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Keep SQL values, applicant names, credentials, and result rows out of telemetry.
function queryShape(sql) {
    return String(sql).replace(/'(?:''|[^'])*'/g, '?').replace(/\b\d+(?:\.\d+)?\b/g, '?').replace(/\s+/g, ' ').trim();
}

function splitStatements(sql) {
    const statements = [];
    let start = 0;
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const char = sql[i];
        if (quote) {
            if (char === quote) {
                if (sql[i + 1] === quote) i++;
                else quote = null;
            }
        } else if (char === "'" || char === '"' || char === '`') quote = char;
        else if (char === ';') { statements.push(sql.slice(start, i)); start = i + 1; }
    }
    statements.push(sql.slice(start));
    return statements.map(value => value.trim()).filter(Boolean);
}

class D1CostTracker {
    constructor() { this.startedAt = new Date().toISOString(); this.queries = new Map(); this.requests = 0; }
    record(sql, results = []) {
        this.requests++;
        if (!results.length) { this.recordStatement(sql, {}); return; }
        const statements = splitStatements(sql);
        for (let index = 0; index < results.length; index++) {
            this.recordStatement(statements.length === results.length ? statements[index] : sql, results[index]);
        }
    }
    recordStatement(sql, result) {
        const shape = queryShape(sql);
        const fingerprint = crypto.createHash('sha256').update(shape).digest('hex').slice(0, 16);
        const key = this.queries.has(fingerprint) || this.queries.size < 200 ? fingerprint : 'other';
        const item = this.queries.get(key) || { fingerprint: key, shape: key === 'other' ? '(other queries)' : shape.slice(0, 500), statements: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0, missingMeta: 0 };
        item.statements++;
        if (!result.meta || !Number.isFinite(Number(result.meta.rows_read)) || !Number.isFinite(Number(result.meta.rows_written))) item.missingMeta++;
        if (result.meta) {
            item.rowsRead += Number(result.meta.rows_read) || 0;
            item.rowsWritten += Number(result.meta.rows_written) || 0;
            item.durationMs += Number(result.meta.duration) || 0;
        }
        this.queries.set(key, item);
    }
    snapshot() {
        const queries = [...this.queries.values()].sort((a, b) => b.rowsRead - a.rowsRead);
        const totals = { statements: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0, missingMeta: 0 };
        for (const query of queries) for (const key of Object.keys(totals)) totals[key] += query[key];
        return { startedAt: this.startedAt, updatedAt: new Date().toISOString(), totals: { requests: this.requests, ...totals }, queries };
    }
    save(file = process.env.D1_COST_REPORT_FILE) {
        if (!file) return;
        // Retries run in a new process. Preserve each attempt instead of
        // overwriting the previous process's measured usage.
        const parsed = path.parse(path.resolve(file));
        const destination = path.join(parsed.dir, `${parsed.name}.${process.pid}${parsed.ext || '.json'}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(this.snapshot(), null, 2) + '\n');
        fs.renameSync(temp, destination);
    }
}

module.exports = { D1CostTracker, queryShape, splitStatements };
