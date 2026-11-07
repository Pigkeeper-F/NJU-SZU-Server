#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Offline regression for native Chrome downloads on a CDP-attached page.

The researcher browser is connected over CDP; some downloads never emit a
Playwright Download object. The fetcher now watches a page-scoped download
directory and accepts only a completed, PDF-validated file. This test exercises
that fallback without a browser or network.
"""
from __future__ import annotations

import importlib
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

_browser = importlib.import_module("literature_fulltext_browser")
PASS = 0
FAIL = 0


def ok(condition: object, label: str) -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  OK   " + label)
    else:
        FAIL += 1
        print("  FAIL " + label)


def pdf_bytes(size: int = _browser.MIN_PDF_BYTES + 1024) -> bytes:
    head = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    tail = b"\n%%EOF\n"
    return head + b"0" * max(0, size - len(head) - len(tail)) + tail


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="lit-cdp-download-"))
    fetcher = _browser.FulltextBrowserFetcher(job_dir=root)
    directory = fetcher._cdp_download_directory()
    ok(directory == root / "fulltext" / ".downloads" / "cdp", "download directory is task-scoped")
    before = fetcher._cdp_download_snapshot()
    ok(before == set(), "empty before click")

    (directory / "partial.crdownload").write_bytes(pdf_bytes())
    ok(fetcher._take_cdp_download(before) is None, "in-progress .crdownload is ignored")

    (directory / "error.html").write_bytes(b"<html>download error</html>" + b"x" * (_browser.MIN_PDF_BYTES + 10))
    ok(fetcher._take_cdp_download(before) is None, "HTML shell is rejected")

    truncated = directory / "truncated.pdf"
    truncated.write_bytes(pdf_bytes()[:-len(b"\n%%EOF\n")])
    ok(fetcher._take_cdp_download(before) is None, "PDF without %%EOF is rejected")
    truncated.unlink()

    blob = pdf_bytes()
    target = directory / "download.pdf"
    target.write_bytes(blob)
    saved = root / "fulltext" / "paper.pdf"
    got = fetcher._take_cdp_download(before, saved)
    ok(got == blob, "completed PDF is accepted")
    ok(saved.is_file() and saved.read_bytes() == blob, "accepted file is saved to the task path")

    after = fetcher._cdp_download_snapshot()
    ok("download.pdf" in after, "snapshot includes the completed file")
    ok(fetcher._take_cdp_download(after) is None, "already consumed files are not reused")

    # CNKI's WebFastLoad appends <FileProperty> after %%EOF; the file is still
    # complete and must be accepted.
    suffixed = pdf_bytes() + b"WebFastLoad<FileProperty><Doi>1</Doi></FileProperty>"
    (directory / "cnki-suffixed.pdf").write_bytes(suffixed)
    got = fetcher._take_cdp_download(after)
    ok(got == suffixed, "trailing CNKI metadata after %%EOF is accepted")

    print("\n结果：" + str(PASS) + " 通过 / " + str(FAIL) + " 失败")
    if FAIL:
        print("LITERATURE_CDP_DOWNLOAD_TESTS_FAIL")
        raise SystemExit(1)
    print("LITERATURE_CDP_DOWNLOAD_TESTS_PASS")


if __name__ == "__main__":
    main()
