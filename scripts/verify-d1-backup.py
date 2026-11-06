"""Restore a D1 SQL export locally and verify integrity without a remote write."""
import argparse
import hashlib
import json
import pathlib
import sqlite3


def verify(sql_file, sqlite_file):
    source = pathlib.Path(sql_file).resolve()
    destination = pathlib.Path(sqlite_file).resolve()
    if destination.exists():
        raise ValueError("Verification database already exists; refusing to overwrite it")
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    db = sqlite3.connect(destination)
    try:
        # D1 exports do not wrap their INSERT statements in a transaction.
        # A single local transaction avoids one durable disk flush per row.
        db.executescript("BEGIN;\n" + source.read_text(encoding="utf-8-sig") + "\nCOMMIT;")
        integrity = [row[0] for row in db.execute("PRAGMA integrity_check")]
        foreign_keys = list(db.execute("PRAGMA foreign_key_check"))
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")]
        counts = {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
        triggers = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")]
        result = {"sql_file": str(source), "sqlite_file": str(destination), "sql_bytes": source.stat().st_size,
                  "sha256": digest.hexdigest(), "integrity": integrity,
                  "foreign_key_violations": len(foreign_keys), "table_counts": counts, "triggers": triggers}
        print(json.dumps(result, indent=2), flush=True)
        if integrity != ["ok"] or foreign_keys:
            raise ValueError("Backup integrity/foreign-key verification failed")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sql", required=True)
    parser.add_argument("--sqlite", required=True)
    args = parser.parse_args()
    verify(args.sql, args.sqlite)
