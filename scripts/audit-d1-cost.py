"""Read-only snapshot audit; measurements are local SQLite VM steps, NOT D1 bills."""
import argparse
import json
import pathlib
import sqlite3


def measure(db, sql, params=()):
    calls = 0

    def tick():
        nonlocal calls
        calls += 1
        return 0

    db.set_progress_handler(tick, 1)
    try:
        rows = db.execute(sql, params).fetchall()
    finally:
        db.set_progress_handler(None, 0)
    return {"vm_steps": calls, "returned_rows": len(rows)}


def audit(snapshot):
    source = sqlite3.connect(pathlib.Path(snapshot).resolve().as_uri() + "?mode=ro", uri=True)
    counts = {name: source.execute("SELECT COUNT(*) FROM " + name).fetchone()[0]
              for name in ("applications", "events", "representatives")}
    offset = max(0, counts["applications"] - 10000)
    cursor_row = source.execute("SELECT id FROM applications ORDER BY id LIMIT 1 OFFSET ?", (max(0, offset - 1),)).fetchone()
    after = cursor_row[0] if offset else 0
    old = measure(source, "SELECT application_number FROM applications WHERE application_number IS NOT NULL AND TRIM(application_number) <> '' ORDER BY id LIMIT 10000 OFFSET ?", (offset,))
    new = measure(source, "SELECT id,application_number FROM applications WHERE id > ? AND application_number IS NOT NULL AND TRIM(application_number) <> '' ORDER BY id LIMIT 10000", (after,))

    # Copy only to RAM. All writes and trigger replacement below are isolated.
    local = sqlite3.connect(":memory:")
    source.backup(local)
    example = local.execute("SELECT MIN(id) FROM applications WHERE representative_id = (SELECT representative_id FROM applications WHERE representative_id IS NOT NULL GROUP BY representative_id ORDER BY COUNT(*) DESC LIMIT 1)").fetchone()[0]
    update = "UPDATE applications SET last_checked_date = '2099-01-01' WHERE id = ?"
    local.execute("SAVEPOINT cost_probe")
    before = local.total_changes
    old_trigger = measure(local, update, (example,))
    old_trigger["changed_rows_including_triggers"] = local.total_changes - before
    local.execute("ROLLBACK TO cost_probe")
    local.execute("RELEASE cost_probe")
    # Snapshot predates the auxiliary no-info table. The trigger itself needs
    # only the existing applications and representatives tables.
    migration = (pathlib.Path(__file__).parents[1] / "db-old/migrations/20261106_d1_cost_reduction.sql").read_text()
    trigger_sql = migration[migration.index("DROP TRIGGER"):]
    local.executescript(trigger_sql)
    before = local.total_changes
    new_trigger = measure(local, update, (example,))
    new_trigger["changed_rows_including_triggers"] = local.total_changes - before
    source.close()
    local.close()
    return {"scope": "local_snapshot_only", "counts": counts,
            "late_page": {"offset": offset, "before": old, "after": new},
            "daily_check_trigger": {"before": old_trigger, "after": new_trigger}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.snapshot), indent=2))
