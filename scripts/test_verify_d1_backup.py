import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("backup_verifier", pathlib.Path(__file__).with_name("verify-d1-backup.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class BackupVerificationTests(unittest.TestCase):
    def test_restores_export_and_checks_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "backup.sql"
            destination = pathlib.Path(directory) / "restored.sqlite"
            source.write_text("PRAGMA defer_foreign_keys=TRUE; CREATE TABLE cases(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO cases VALUES(1,'Sample');", encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                verifier.verify(source, destination)
            result = json.loads(output.getvalue())
            self.assertEqual(result["integrity"], ["ok"])
            self.assertEqual(result["table_counts"], {"cases": 1})
            self.assertEqual(result["foreign_key_violations"], 0)
            self.assertEqual(len(result["sha256"]), 64)

    def test_refuses_to_overwrite_existing_verification_database(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "backup.sql"
            destination = pathlib.Path(directory) / "existing.sqlite"
            source.write_text("CREATE TABLE cases(id INTEGER);", encoding="utf-8")
            destination.write_bytes(b"preserve existing file")
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                verifier.verify(source, destination)
            self.assertEqual(destination.read_bytes(), b"preserve existing file")

    def test_rejects_export_with_foreign_key_violations(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "backup.sql"
            source.write_text("CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(99);", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "verification failed"):
                    verifier.verify(source, pathlib.Path(directory) / "invalid.sqlite")


if __name__ == "__main__":
    unittest.main()
