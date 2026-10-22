"""Atomic status-write regressions; only temporary files and injected OS errors."""
from __future__ import annotations

import errno
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf


def windows_error(code):
    error = PermissionError(errno.EACCES, "Synthetic Windows file sharing error")
    error.winerror = code
    return error


class AtomicWriteTests(unittest.TestCase):
    def test_transient_windows_errors_retry_then_replace_old_target_atomically(self):
        for code in (5, 32, 33):
            with self.subTest(winerror=code), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "status.json"
                target.write_bytes(b"old status")
                original_replace = lf.os.replace
                calls = []

                def replace(source, destination):
                    self.assertEqual(target.read_bytes(), b"old status")
                    self.assertEqual(Path(source).read_bytes(), b"new status")
                    calls.append((source, destination))
                    if len(calls) <= 2:
                        raise windows_error(code)
                    original_replace(source, destination)

                with patch.object(lf.os, "replace", side_effect=replace), patch.object(lf.time, "sleep") as sleep:
                    lf.atomic_write_bytes(target, b"new status")
                self.assertEqual(len(calls), 3)
                self.assertEqual(sleep.call_count, 2)
                self.assertEqual(target.read_bytes(), b"new status")
                self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_permanent_windows_denial_preserves_target_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "status.json"
            target.write_bytes(b"untouched old status")
            error = windows_error(5)
            with patch.object(lf.os, "replace", side_effect=error) as replace, patch.object(lf.time, "sleep") as sleep:
                with self.assertRaises(PermissionError) as caught:
                    lf.atomic_write_json(target, {"new": True})
            self.assertIs(caught.exception, error, "permanent permission failure must propagate")
            self.assertEqual(replace.call_count, 9)
            self.assertEqual(sleep.call_count, 8)
            self.assertAlmostEqual(sum(call.args[0] for call in sleep.call_args_list), 1.5)
            self.assertEqual(target.read_bytes(), b"untouched old status")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_nonsharing_errors_fail_immediately_and_preserve_target(self):
        errors = (PermissionError(errno.EACCES, "No Windows sharing code"),
                  windows_error(2), OSError(errno.ENOSPC, "Synthetic disk full"))
        for error in errors:
            with self.subTest(error=str(error)), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "status.json"
                target.write_bytes(b"old status")
                with patch.object(lf.os, "replace", side_effect=error) as replace, patch.object(lf.time, "sleep") as sleep:
                    with self.assertRaises(OSError) as caught:
                        lf.atomic_write_bytes(target, b"new status")
                self.assertIs(caught.exception, error)
                self.assertEqual(replace.call_count, 1)
                sleep.assert_not_called()
                self.assertEqual(target.read_bytes(), b"old status")
                self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_real_bytes_json_and_text_roundtrip_without_temp_files(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / "nested"
            binary, document, text = folder / "paper.pdf", folder / "status.json", folder / "body.txt"
            blob = b"%PDF-1.4\n\x00\x01binary\xff"
            lf.atomic_write_bytes(binary, blob)
            lf.atomic_write_json(document, {"status": "待补充", "count": 3})
            lf.atomic_write_text(text, "已存正文\n")
            self.assertEqual(binary.read_bytes(), blob)
            self.assertEqual(json.loads(document.read_text(encoding="utf-8")), {"status": "待补充", "count": 3})
            self.assertEqual(text.read_text(encoding="utf-8"), "已存正文\n")
            lf.atomic_write_json(document, {"status": "完整", "count": 4})
            self.assertEqual(json.loads(document.read_text(encoding="utf-8")), {"status": "完整", "count": 4})
            self.assertEqual(set(folder.iterdir()), {binary, document, text})


if __name__ == "__main__":
    unittest.main()
