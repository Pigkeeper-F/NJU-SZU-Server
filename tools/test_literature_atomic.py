"""Atomic checkpoint replacement retries, with no services or user data."""
from __future__ import annotations

import errno
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

common = importlib.import_module("literature-common")


class AtomicReplacementTest(unittest.TestCase):
    def test_transient_permission_error_retries_same_file_then_replaces_atomically(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "discovery-state.json"
            target.write_text('{"pending_source":"web-of-science"}\n', encoding="utf-8")
            old = target.read_bytes()
            replace, calls = common.os.replace, []

            def replace_once_locked(source, destination):
                calls.append((source, destination))
                self.assertEqual(target.read_bytes(), old)
                self.assertEqual(json.loads(Path(source).read_text(encoding="utf-8")), {"pending_source": "cnki"})
                if len(calls) == 1:
                    raise PermissionError(errno.EACCES, "checkpoint temporarily busy")
                return replace(source, destination)

            with patch.object(common.os, "replace", side_effect=replace_once_locked), patch.object(common.time, "sleep") as sleep:
                common.atomic_write_json(target, {"pending_source": "cnki"})
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0], calls[1], "Retry must reuse the fully written temporary file")
            sleep.assert_called_once_with(0.05)
            self.assertEqual(common.load_json(target), {"pending_source": "cnki"})
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_permanent_permission_error_preserves_old_checkpoint_and_cleans_temp(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "discovery-state.json"
            target.write_bytes(b'{"count":30}\n')
            failure = PermissionError(errno.EACCES, "permanent denial")
            with patch.object(common.os, "replace", side_effect=failure) as replace, patch.object(common.time, "sleep") as sleep:
                with self.assertRaises(PermissionError) as raised:
                    common.atomic_write_json(target, {"count": 40})
            self.assertIs(raised.exception, failure)
            self.assertEqual(replace.call_count, 6)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.05, 0.1, 0.2, 0.4, 0.8])
            self.assertEqual(target.read_bytes(), b'{"count":30}\n')
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_windows_sharing_and_lock_errors_are_retried(self):
        for winerror in (32, 33):
            with self.subTest(winerror=winerror), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / "candidates.json"
                failure = OSError("Windows sharing conflict")
                failure.winerror = winerror
                replace = common.os.replace
                count = 0

                def locked_once(source, destination):
                    nonlocal count
                    count += 1
                    if count == 1:
                        raise failure
                    return replace(source, destination)

                with patch.object(common.os, "replace", side_effect=locked_once), patch.object(common.time, "sleep") as sleep:
                    common.atomic_write_json(target, {"count": 40})
                self.assertEqual(count, 2)
                sleep.assert_called_once_with(0.05)
                self.assertEqual(common.load_json(target), {"count": 40})

    def test_other_io_error_is_not_retried_or_written_over_old_target(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "candidates.csv"
            target.write_bytes(b"original\n")
            failure = OSError(errno.ENOSPC, "disk full")
            with patch.object(common.os, "replace", side_effect=failure) as replace, patch.object(common.time, "sleep") as sleep:
                with self.assertRaises(OSError) as raised:
                    common.atomic_write_text(target, "new content\n", encoding="utf-8-sig")
            self.assertIs(raised.exception, failure)
            replace.assert_called_once()
            sleep.assert_not_called()
            self.assertEqual(target.read_bytes(), b"original\n")
            self.assertEqual(list(target.parent.iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
