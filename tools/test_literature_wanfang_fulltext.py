#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Offline regression for the Wanfang native fulltext click path.

No network or real browser: fake pages/controls verify that the adapter
navigates only the official detail URL, checks article identity, never clicks a
payment/purchase control, records the click before it happens, refuses a second
run after an interrupted click, and returns actual PDF bytes.
"""
from __future__ import annotations

import importlib
import json
import sys
import tempfile
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

wan = importlib.import_module("literature_wanfang_fulltext")
lf = importlib.import_module("literature_fulltext")
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
DOI = "10.3969/j.issn.1006-267x.2019.07.011"
DETAIL = "https://d.wanfangdata.com.cn/periodical/abc"


class Node:
    def __init__(self, page, label, visible=True):
        self.page, self.label, self.visible, self.disposed = page, label, visible, False
        self.clicks = 0

    def inner_text(self):
        return self.label

    def get_attribute(self, name):
        return self.label if name == "aria-label" else None

    def is_visible(self):
        return self.visible

    def click(self, **kwargs):
        self.clicks += 1
        self.page.clicked += 1
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
        self.clicked = 0
        self.snapshot = {"citation_title": TITLE, "citation_doi": DOI,
                         "links": [], "materials": {"links": []}}
        self.controls = [Node(self, "PDF下载")]
        self.body = "文章页正文。"

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
        return self.body

    def is_closed(self):
        return False


class Fetcher:
    def __init__(self, page, *, binding=None, materials=None):
        self.page, self._blocked, self._request_url = page, None, ""
        self._binding = dict(binding or {})
        self._materials = materials
        self.materials_calls = 0

    def _get_page(self):
        return self.page

    def _write_binding(self):
        return None

    def _clock(self):
        return time.monotonic()

    def _progress(self, message):
        return None

    def _clear_pending(self):
        return None

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

    def _observe_materials(self, record, snapshot, url, opts=None):
        self.materials_calls += 1
        return (self._materials or {"status": "none_declared", "reason": "",
                                    "source_url": url, "links": []}), None


def record():
    return {"result_url": DETAIL, "title": TITLE, "doi": DOI, "paper_id": "WF-001"}


def seeded(step, click_targets, rec=None):
    rec = rec or record()
    paper_hash = wan._paper_hash(rec)
    return {"wanfang_flows": {paper_hash: {
        "paper_hash": paper_hash,
        "title_hash": wan._title_hash(rec.get("title") or TITLE),
        "target_id": "", "step": step, "click_target_ids": list(click_targets),
        "updated_at": 1.0}}}


def main() -> None:
    ok(wan._detail_url({"result_url": DETAIL}) == DETAIL, "official periodical detail URL accepted")
    ok(wan._detail_url({"result_url": "https://example.com/x"}) == "", "non-Wanfang URL rejected")
    ok(wan._detail_url({"result_url": "http://d.wanfangdata.com.cn/periodical/abc"}) == "",
       "plain-http detail URL rejected")

    class TitlePage:
        def title(self):
            return "热应激对肉鸡生长性能的影响-期刊-万方数据知识服务平台"
    snap = wan._page_identity({}, TitlePage(), {"title": TITLE})
    ok(snap.get("citation_title") == TITLE, "visible Wanfang title used when citation meta is absent")

    page = Page()
    fetcher = Fetcher(page)
    result = wan.run_wanfang(fetcher, record(), {})
    ok(result.get("status") == "pdf_page", "visible PDF control returns pdf_page")
    ok(result.get("bytes") == PDF, "returns actual PDF bytes")
    ok(result.get("acquisition_method") == "wanfang_official_download", "records official download method")
    ok(page.controls[0].disposed, "clicked control is disposed")
    ok(page.clicked == 1, "exactly one download click")
    flow = fetcher._binding.get("wanfang_flow") or {}
    ok(flow.get("step") == "download_clicked" and flow.get("click_target_ids"),
       "click is recorded in the durable flow before the file arrives")

    page2 = Page()
    page2.controls = []
    page2.body = "请先登录后下载"
    result2 = wan.run_wanfang(Fetcher(page2), record(), {})
    ok(result2.get("status") == "attention" and result2.get("reason") == "access_required",
       "login/paywall text stops without fabricating a download")

    page3 = Page()
    page3.controls = [Node(page3, "购买全文")]
    result3 = wan.run_wanfang(Fetcher(page3), record(), {})
    ok(result3.get("status") == "attention" and result3.get("reason") == "access_required",
       "purchase control is never a download candidate")
    ok(page3.clicked == 0, "payment control is not clicked")

    page4 = Page()
    page4.controls = [Node(page4, "PDF下载"), Node(page4, "PDF全文下载")]
    result4 = wan.run_wanfang(Fetcher(page4), record(), {})
    ok(result4.get("status") == "attention" and result4.get("reason") == "page_error",
       "multiple download controls pause instead of guessing")
    ok(page4.clicked == 0, "ambiguous controls are not clicked")

    page5 = Page()
    result5 = wan.run_wanfang(Fetcher(page5), record(), {"metadata_only": True})
    ok(result5.get("status") == "ok" and result5.get("metadata_only") is True,
       "metadata_only returns the verified detail page without downloading")
    ok(page5.clicked == 0, "metadata_only does not click download")

    page6 = Page()
    result6 = wan.run_wanfang(Fetcher(page6, binding=seeded("download_clicked", ["t1"])), record(), {})
    ok(result6.get("status") == "attention" and "尚未取得完整" in str(result6.get("message")),
       "interrupted click resumes as attention, not a silent re-download")
    ok(page6.clicked == 0, "interrupted click is not replayed without an explicit restart")

    page7 = Page()
    result7 = wan.run_wanfang(Fetcher(page7, binding=seeded("detail", ["t1", "t2"])), record(), {})
    ok(result7.get("status") == "attention" and result7.get("reason") == "page_error",
       "two-click ceiling stops further clicks")
    ok(page7.clicked == 0, "click ceiling is enforced before the click")

    # The live run exposed this: another paper's later attempt must not erase
    # this paper's recorded click, or a retry would click the publisher twice.
    page9 = Page()
    binding9 = seeded("download_clicked", ["t1"])
    other = {**record(), "paper_id": "WF-999"}
    other_hash = wan._paper_hash(other)
    binding9["wanfang_flows"][other_hash] = {
        "paper_hash": other_hash, "title_hash": wan._title_hash(TITLE),
        "target_id": "", "step": "download_clicked", "click_target_ids": ["t9"],
        "updated_at": 2.0}
    result9 = wan.run_wanfang(Fetcher(page9, binding=binding9), record(), {})
    ok(result9.get("status") == "attention" and page9.clicked == 0,
       "a later paper's trace does not erase this paper's click ceiling")

    page8 = Page()
    fetcher8 = Fetcher(page8, materials={"status": "checked", "reason": "",
                                         "source_url": DETAIL, "links": [{"url": DETAIL + "/1"}]})
    result8 = wan.run_wanfang(fetcher8, record(), {})
    ok(fetcher8.materials_calls == 1, "detail page materials are observed once")
    ok((result8.get("material_discovery") or {}).get("status") == "checked",
       "observed material discovery is returned with the file")

    job = Path(tempfile.mkdtemp(prefix="wanfang-settle-"))
    item = lf._item_skeleton(record())
    settled = lf._settle_platform_result(
        {"status": "pdf_page", "bytes": PDF, "url": DETAIL,
         "acquisition_method": "wanfang_official_download"},
        record(), job, item, source_key="wanfang")
    ok(settled.get("status") == "fetched_pdf", "Wanfang bytes pass the shared PDF gate")
    ok(settled.get("acquisition_method") == "wanfang_official_download",
       "settlement keeps the Wanfang acquisition method")
    ok((settled.get("pdf_evidence") or {}).get("identity_method") == "wanfang_normal_navigation",
       "Wanfang evidence is not labelled as CNKI navigation")

    try:
        lf._settle_platform_result({"status": "fetch_error", "url": DETAIL},
                                   record(), job, lf._item_skeleton(record()), source_key="wanfang")
        message = ""
    except lf.FulltextPause as error:
        message = error.message
    ok("万方" in message and "知网" not in message, "Wanfang failure message names Wanfang, not CNKI")

    # 不同学校的用户必须自己选机构：登录墙只打开数据库自己的机构入口，
    # 代码里不得出现任何学校的 entityID。
    class InstitutionContext:
        def __init__(self):
            self.pages = []

        def new_page(self):
            page = Page()
            self.pages.append(page)
            return page

    class LoginFetcher(Fetcher):
        def _reason(self, snapshot, status=0):
            return "login"

    entry_context = InstitutionContext()
    login_fetcher = LoginFetcher(Page())
    login_fetcher._context = entry_context
    login_result = wan.run_wanfang(login_fetcher, record(), {})
    ok(login_result.get("reason") == "login", "login wall is reported as login, not as a paywall")
    ok(len(entry_context.pages) == 1 and entry_context.pages[0].url == wan.INSTITUTION_ENTRY,
       "login wall opens the database institution picker")
    ok("entityID" not in wan.INSTITUTION_ENTRY and "szu" not in wan.INSTITUTION_ENTRY.lower(),
       "institution entry hardcodes no school identity")
    ok("学校" in str(login_result.get("message")), "message asks the researcher to choose their school")

    second = wan.run_wanfang(login_fetcher, {**record(), "paper_id": "WF-002"}, {})
    ok(second.get("reason") == "login", "a second paper reports the same login wall")
    ok(len(entry_context.pages) == 1, "institution picker is opened once per session")

    no_context = Fetcher(Page())
    no_context._reason = lambda snapshot, status=0: "login"
    fallback = wan.run_wanfang(no_context, record(), {})
    ok(fallback.get("reason") == "login" and "学校" in str(fallback.get("message")),
       "a browser without a context still tells the researcher to choose a school")

    # 匿名访问万方先出现的是滑块验证而不是登录表单：这条墙同样要给机构入口，
    # 否则新用户永远走不到“选择自己学校”。
    class VerifyFetcher(Fetcher):
        def _reason(self, snapshot, status=0):
            return "verification"

    verify_context = InstitutionContext()
    verify_fetcher = VerifyFetcher(Page())
    verify_fetcher._context = verify_context
    verify_result = wan.run_wanfang(verify_fetcher, record(), {})
    ok(verify_result.get("reason") == "verification", "anonymous verification is reported as verification")
    ok(len(verify_context.pages) == 1 and verify_context.pages[0].url == wan.INSTITUTION_ENTRY,
       "anonymous verification also opens the institution picker")
    ok("学校" in str(verify_result.get("message")) or "机构" in str(verify_result.get("message")),
       "verification message mentions the institution route")

    # 付费墙同样先给机构入口：多数情况是“学校订了但没登录”，不是真的没权限。
    class PayFetcher(Fetcher):
        def _reason(self, snapshot, status=0):
            return "access_required"

    pay_context = InstitutionContext()
    pay_fetcher = PayFetcher(Page())
    pay_fetcher._context = pay_context
    pay_result = wan.run_wanfang(pay_fetcher, record(), {})
    ok(pay_result.get("reason") == "access_required", "paywall is reported as access_required")
    ok(len(pay_context.pages) == 1 and pay_context.pages[0].url == wan.INSTITUTION_ENTRY,
       "paywall also opens the institution picker")
    ok("学校" in str(pay_result.get("message")), "paywall message asks the researcher to choose their school")

    # 单篇材料页错误（page_not_ready/page_error）不得阻断下一篇；只有站点级
    # 登录/验证/权限/限流才允许整站阻断。
    paper_blocked = Fetcher(Page())
    paper_blocked._blocked = {"status": "attention", "reason": "page_not_ready", "url": ""}
    paper_result = wan.run_wanfang(paper_blocked, record(), {})
    ok(paper_result.get("status") == "pdf_page", "paper-level block does not poison the next paper")

    wall_blocked = Fetcher(Page())
    wall_blocked._blocked = {"status": "attention", "reason": "login", "url": ""}
    wall_result = wan.run_wanfang(wall_blocked, record(), {})
    ok(wall_result.get("reason") == "login", "site-level login wall still blocks the next paper")

    # 材料扫描预算：默认 30 秒、可调、上限 120 秒、非法值回退。
    ok(wan._material_budget({}) == 30.0, "材料扫描默认 30 秒预算")
    ok(wan._material_budget({"material_timeout_sec": 5}) == 5.0, "材料预算可调低")
    ok(wan._material_budget({"material_timeout_sec": 999}) == 120.0, "材料预算上限 120 秒")
    ok(wan._material_budget({"material_timeout_sec": -1}) == 30.0, "非法材料预算回退默认值")

    print("\n结果：" + str(PASS) + " 通过 / " + str(FAIL) + " 失败")
    if FAIL:
        print("LITERATURE_WANFANG_FULLTEXT_TESTS_FAIL")
        raise SystemExit(1)
    print("LITERATURE_WANFANG_FULLTEXT_TESTS_PASS")


if __name__ == "__main__":
    main()
