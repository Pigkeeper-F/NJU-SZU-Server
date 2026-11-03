#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Offline regression for the Wanfang native fulltext click path.

No network or real browser: a fake page/control verifies that the adapter
navigates only the official detail URL, checks article identity, clicks one
visible PDF/download control, and returns actual PDF bytes. It also verifies
that login/paywall text is not mistaken for a downloaded file.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

wan = importlib.import_module("literature_wanfang_fulltext")
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


PDF = b"%PDF-1.7\n" + b"x" * (60 * 1024) + b"\n%%EOF\n"
TITLE = "热应激对肉鸡生长性能的影响"


class Node:
    def __init__(self, page, label, visible=True):
        self.page, self.label, self.visible, self.disposed = page, label, visible, False

    def inner_text(self):
        return self.label

    def get_attribute(self, name):
        return self.label if name == "aria-label" else None

    def is_visible(self):
        return self.visible

    def click(self, **kwargs):
        self.page.fire("download", Download())

    def dispose(self):
        self.disposed = True


class Download:
    def save_as(self, path):
        Path(path).write_bytes(PDF)

    def failure(self):
        return None


class Page:
    def __init__(self):
        self.url = ""
        self.listeners = {}
        self.snapshot = {"citation_title": TITLE, "citation_doi": "10.3969/j.issn.1006-267x.2019.07.011",
                         "links": [], "materials": {"links": []}}
        self.controls = [Node(self, "PDF下载")]

    def goto(self, url, **kwargs):
        self.url = url

    def evaluate(self, script, arg=None):
        return self.snapshot

    def query_selector_all(self, selector):
        return list(self.controls)

    def on(self, event, callback):
        self.listeners.setdefault(event, []).append(callback)

    def fire(self, event, *args):
        for callback in self.listeners.get(event, []):
            callback(*args)

    def remove_listener(self, event, callback):
        if callback in self.listeners.get(event, []):
            self.listeners[event].remove(callback)

    def inner_text(self, selector):
        return "正常文章页，无付费提示"

    def is_closed(self):
        return False


class Fetcher:
    def __init__(self, page):
        self.page, self._blocked, self._request_url = page, None, ""

    def _get_page(self):
        return self.page

    def _pace(self, url):
        return None

    def _record_destination(self, url):
        return None

    def _reason(self, snapshot, status=0):
        return None

    def _attention(self, reason, url, *, snapshot=None, observed_url=None):
        return {"status": "attention", "reason": reason, "url": url}

    def _enable_cdp_downloads(self, page):
        return True

    def _cdp_download_snapshot(self):
        return set()

    def _take_cdp_download(self, before=None, out_path=None):
        return None

    def _read_download(self, download, out_path=None):
        return PDF

    def _wait_tick(self, page):
        return None


def main() -> None:
    ok(wan._detail_url({"result_url": "https://d.wanfangdata.com.cn/periodical/abc"})
       == "https://d.wanfangdata.com.cn/periodical/abc", "official periodical detail URL accepted")
    ok(wan._detail_url({"result_url": "https://example.com/x"}) == "", "non-Wanfang URL rejected")

    page = Page()
    result = wan.run_wanfang(Fetcher(page), {
        "result_url": "https://d.wanfangdata.com.cn/periodical/abc",
        "title": TITLE, "doi": "10.3969/j.issn.1006-267x.2019.07.011"}, {})
    ok(result.get("status") == "pdf_page", "visible PDF control returns pdf_page")
    ok(result.get("bytes") == PDF, "returns actual PDF bytes")
    ok(result.get("acquisition_method") == "wanfang_official_download", "records official download method")
    ok(page.controls[0].disposed, "clicked control is disposed")

    page2 = Page()
    page2.controls = []
    page2.inner_text = lambda selector: "请先登录后下载"
    result2 = wan.run_wanfang(Fetcher(page2), {
        "result_url": "https://d.wanfangdata.com.cn/periodical/abc", "title": TITLE}, {})
    ok(result2.get("status") == "attention" and result2.get("reason") == "access_required",
       "login/paywall text stops without fabricating a download")

    print("\n结果：" + str(PASS) + " 通过 / " + str(FAIL) + " 失败")
    if FAIL:
        print("LITERATURE_WANFANG_FULLTEXT_TESTS_FAIL")
        raise SystemExit(1)
    print("LITERATURE_WANFANG_FULLTEXT_TESTS_PASS")


if __name__ == "__main__":
    main()
