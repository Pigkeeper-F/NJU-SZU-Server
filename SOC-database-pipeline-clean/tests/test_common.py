from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".codex" / "skills" / "soc-paper-fetch" / "scripts"))

import common


class CommonJsonOutputTest(unittest.TestCase):
    def test_print_json_handles_scholar_nonbreaking_space_on_gbk_stdout(self) -> None:
        original_stdout = common.sys.stdout
        fake_stdout = io.TextIOWrapper(io.BytesIO(), encoding="gbk")
        try:
            common.sys.stdout = fake_stdout

            common.print_json({"title": "SOC\u00a0field experiment"})

            fake_stdout.flush()
        finally:
            common.sys.stdout = original_stdout


if __name__ == "__main__":
    unittest.main()
