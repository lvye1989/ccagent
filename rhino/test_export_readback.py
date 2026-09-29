"""Offline checks for the Rhino runner's exported .3dm read-back gate.

The runner itself loads inside Rhino; these tests execute its real verifier
with a small File3dm.Read stand-in so no live Rhino document is changed.
"""

import ast
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest


RUNNER = Path(__file__).with_name("ccagent_rhino_runner.py")


def load_verifier(read):
    tree = ast.parse(RUNNER.read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
                 and node.name in ("_text", "_verify_3dm_export")]
    namespace = {"os": os, "Rhino": SimpleNamespace(
        FileIO=SimpleNamespace(File3dm=SimpleNamespace(Read=read)))}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(RUNNER), "exec"), namespace)
    return namespace["_verify_3dm_export"]


def saved_model(units="Meters", guids=()):
    return SimpleNamespace(Settings=SimpleNamespace(ModelUnitSystem=units),
                           Objects=[SimpleNamespace(Id=guid) for guid in guids])


class ExportReadbackTests(unittest.TestCase):
    def setUp(self):
        self.folder = TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = os.path.join(self.folder.name, "model.3dm")
        with open(self.path, "wb") as stream:
            stream.write(b"3dm-test-content")

    def test_verified_export_reports_file_count_units_and_guids(self):
        verify = load_verifier(lambda path: saved_model(guids=("ABC", "DEF")))
        report = verify(self.path, "Meters", ["abc", "def"], ["ABC", "DEF"])
        self.assertTrue(report["read_back"])
        self.assertGreater(report["file_size_bytes"], 0)
        self.assertEqual(report["read_back_object_count"], 2)
        self.assertEqual(report["units"], "Meters")
        self.assertEqual(report["verified_object_guid_count"], 2)
        self.assertTrue(report["source_guids_preserved"])

    def test_remapped_source_guid_is_reported_but_written_guid_is_verified(self):
        verify = load_verifier(lambda path: saved_model(guids=("NEW",)))
        report = verify(self.path, "Meters", ["NEW"], ["OLD"])
        self.assertFalse(report["source_guids_preserved"])
        self.assertEqual(report["verified_object_guid_count"], 1)

    def test_missing_or_empty_file_fails_before_read(self):
        verify = load_verifier(lambda path: self.fail("Read should not run"))
        os.remove(self.path)
        with self.assertRaisesRegex(RuntimeError, "does not exist"):
            verify(self.path, "Meters", [], [])
        with open(self.path, "wb"):
            pass
        with self.assertRaisesRegex(RuntimeError, "is empty"):
            verify(self.path, "Meters", [], [])

    def test_read_failure_and_mismatches_fail(self):
        cases = (
            (lambda path: None, [], "Could not reopen"),
            (lambda path: saved_model(guids=()), ["ABC"], "object count mismatch"),
            (lambda path: saved_model("Feet", ("ABC",)), ["ABC"], "units mismatch"),
            (lambda path: saved_model(guids=("OTHER",)), ["ABC"], "missing object GUIDs"),
        )
        for read, expected, message in cases:
            with self.subTest(message=message):
                verify = load_verifier(read)
                with self.assertRaisesRegex(RuntimeError, message):
                    verify(self.path, "Meters", expected, expected)

    def test_read_exception_is_reported_as_export_failure(self):
        def failed_read(path):
            raise IOError("archive is corrupt")

        verify = load_verifier(failed_read)
        with self.assertRaisesRegex(RuntimeError, "Could not reopen exported 3dm file: archive is corrupt"):
            verify(self.path, "Meters", ["ABC"], ["ABC"])


if __name__ == "__main__":
    unittest.main()
