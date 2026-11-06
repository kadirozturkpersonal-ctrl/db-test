# D1 cost investigation - 2026-11-06

## Confirmed scope and limits

The October invoice charges $214.97 for 214,971,215,844 billable row
reads and $25 for row writes, plus the $5 November subscription. An invoice
does not identify the SQL or the database responsible for each row read.

The configured production D1 target returned its Free daily-row-read
quota error during the initial investigation. Account analytics explicitly returned `not authorized for that
account`; a blank `wrangler d1 insights` response is **not** evidence of no
usage. Historical attribution requires Account Analytics Read access and
the retained analytics window. The initial code investigation made no
production writes; the later explicitly authorized application is recorded
below.

The panel checkout has unrelated in-progress edits, including its D1 query
policy and monitor. This change is confined to the separate `db-test` repo
and does not replace or commit those panel edits.

During integration, upstream commit `91cb953` disabled both hosted scraping
jobs and kept local Windows tasks as the sole scanner. That decision and
its local telemetry / once-per-day snapshot refresh were preserved. The
GitHub cost-artifact configuration is passive while those jobs are disabled;
the local process reports are the active measurement path.

## Changes

- Cursor pagination replaces OFFSET in known/finalized/no-info skip lists.
  Results and finalized-stage selection remain unchanged.
- A bounded, indexed event lookup compares stored events to the SOP result.
  Identical event lists retain their IDs; changed/removed events still sync.
- Same-day identical application data does not run an UPDATE. A later day's
  successful check still updates `last_checked_date` and resets missing count.
- Existing representative names are checked before attempting an insert.
- Small packages use measured REST queries rather than bulk import followed
  by an uncertain shell fallback. Mutating requests are never automatically
  retried after an ambiguous network response.
- Every REST response contributes its actual `meta.rows_read`,
  `meta.rows_written`, and duration to a process report. Missing metadata is
  marked unknown, never treated as proven zero usage. SQL literals and
  result rows are excluded. Up to 200 query fingerprints are retained.
- A quota response opens a process/account circuit until UTC midnight.
  Pending historical packages keep their earliest unconfirmed checkpoint.
- Checkpoint commits use an isolated Git index so dirty runner files cannot
  break a rebase and repeatedly restart the same expensive range. A newer
  remote checkpoint is never overwritten. A checkpoint artifact is retained.

## Local measurements (not Cloudflare billing measurements)

Run with a **read-only** SQLite snapshot:

```powershell
python scripts/audit-d1-cost.py --snapshot C:\path\echr-db-export.sqlite
```

The tested July snapshot contains 136,796 applications, 284,220 events and
24,581 representatives. The source file is opened read-only. Trigger tests
run only on a copy in RAM.

| Probe | Before SQLite VM steps | After | Reduction |
| --- | ---: | ---: | ---: |
| Last 10,000 known applications | 714,000 | 80,026 | 88.8% |
| Freshness-only update for a large representative group | 3,248 | 44 | 98.6% |

The latter measurement requires the prepared trigger migration. In the
in-memory integration test, repeating an identical same-day SOP result
changes zero business rows and preserves event IDs. These comparisons
demonstrate improvements but do not prove how much of the October invoice
each old query caused, or guarantee a $5 monthly total.

## Actual usage reports

`D1_COST_REPORT_FILE` chooses a report prefix; `.PID` is inserted before the
extension so supervisor retries do not overwrite earlier attempts. Local
defaults go to ignored `local-data/d1-query-costs.PID.json`. The monthly
launcher uses `d1-monthly-query-costs.PID.json`. GitHub workflows preserve
these reports as `d1-query-costs-RUN_ID` / `d1-daily-query-costs-RUN_ID`
artifacts for 31 days, including failed runs. Sum reports across processes
for a full run; each file's totals cover only that process and this adapter.

Once D1 access recovers, inspect `queries` sorted by `rowsRead`, compare
before/after counts on a bounded workload, and check account analytics for
other writers/databases. Do not launch a full rescan just to benchmark.

## Migration definition and safety procedure

`db-old/migrations/20261106_d1_cost_reduction.sql` makes the expensive
representative-count trigger run only when a case changes representative,
and updates the counts for both its old and new representative. It also
ensures indexes for event/application lookups and dated no-info candidates.
It does not change case or event data. The former INSERT trigger is retained.

Before applying it: obtain explicit authorization for the shared production
D1 schema change, restore D1 access, export/verify a current backup, inspect
the live trigger/index definitions, then apply only if they match the
expected schema. The local snapshot is historical, not a current backup.
Verify a small authorized write workload and compare its returned row counts.
The new migration is deliberately **not** executed by scheduled workflows.

## Authorized production application - 2026-11-06

The user explicitly authorized a current backup, application of this schema
migration, and verification. Workers Paid restored D1 access first.

- Full SQL export completed at 16:07 UTC (19:07 Istanbul), 308,505,393 bytes.
- SHA-256: `ad071fbb30cdbf566aa852f17b4972ce43f71a1be4806878c6cba8f4f002d7e5`.
- The export was restored to a separate local SQLite file: integrity `ok`,
  zero foreign-key violations, 13 user tables. The first slow autocommit
  verification was stopped and its partial file retained; the verified file
  uses a single local restore transaction.
- Backup files and operation receipts are under the panel's ignored
  `local-data/backups/d1/20261106T160700Z/`, separate from Git/code sync.
- Pre-change Time Travel bookmark:
  `00002e9e-00000000-0000511b-d87a4ae2df3e357bbd253b08ca08dede`.
- Live counts and the old trigger matched the verified backup before writing.
- Migration applied and verified at 16:13 UTC (19:13 Istanbul). The covering
  index `idx_sop_no_info_status_date_number` is selected for the pending/date
  predicate, and the update trigger has its representative-change guard.
- A bounded no-op UPDATE read 2 rows and wrote 3 physical rows (the case and
  indexes); case fields and representative counters/timestamp stayed equal.
  It did not send notifications or run a scraper.
- All 13 table counts remained unchanged. Core counts: 311,176 applications,
  477,273 events, 46,588 representatives, 179,310 no-info candidates.
- Reassignment to another representative was checked only on an in-memory
  copy of the restored backup; both old and new counts were correct.

The initial count preflight used too many UNION terms for D1 and failed
before any mutation. It was replaced with one SELECT of scalar counts.
The successful local operation receipt is `migration-receipt.42548.json`.

The local panel still held its earlier quota circuit in memory after the
upgrade. Only the confirmed canonical Next.js server was restarted through
the hidden launcher. A fresh `/aihm-veritabani` response returned HTTP 200,
used the live Cloudflare D1 published source, and contained neither the quota
error nor the local SQLite fallback. The separate analysis worker was not
restarted.

References:
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/
