"""CNKI single-paper click flow, with owned fake pages and offline real DOM."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

import literature_cnki_fulltext as mod
import literature_fulltext_browser as browser


TITLE = "PGE2在热应激肉鸡肠道免疫功能中的调控机制"
PDF = b"%PDF-1.7\n" + b"x" * (60 * 1024)
RECORD = {"source_key": "cnki", "source_candidate_id": "CNKI-1", "paper_id": "P-1", "title": TITLE,
          "links": [{"url": "https://bar.cnki.net/bar/download/order?token=never-replay"}]}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def snap(**extra):
    return dict({"text": "中国知网", "citation_title": "", "citation_doi": "", "links": []}, **extra)


def ui(*, title=TITLE, query=TITLE, count=1, controls=None, generating=False):
    return {"queries": [query], "rowSelector": mod.ROWS[0],
            "rows": [{"index": n, "visible": True, "anchors": [{"index": 0, "visible": True, "text": title}]} for n in range(count)],
            "titles": [title], "controls": controls or [], "generating": generating}


def control(text="PDF下载", index=0):
    return {"text": text, "index": index, "visible": True, "enabled": True}


class Download:
    def __init__(self, blob=PDF):
        self.blob = blob
        self.url = "https://kns.cnki.net/fixture-download"

    def save_as(self, path):
        Path(path).write_bytes(self.blob)


class CDP:
    def __init__(self, page):
        self.page = page

    def send(self, name):
        assert name == "Target.getTargetInfo"
        return {"targetInfo": {"targetId": self.page.target}}

    def detach(self):
        pass


class Locator:
    def __init__(self, page, selector, index=None, row=None):
        self.page, self.selector, self.index, self.row = page, selector, index, row

    def nth(self, index):
        return Locator(self.page, self.selector, index, self.row)

    def locator(self, selector):
        assert self.selector in mod.ROWS and selector == "a"
        return Locator(self.page, selector, row=self.index)

    def is_visible(self):
        return True

    def is_enabled(self):
        return True

    def inner_text(self):
        if self.selector == "a":
            return self.page.ui["rows"][self.row]["anchors"][self.index]["text"]
        return self.page.ui["controls"][self.index]["text"]

    def evaluate(self, script):
        if script == mod._CONTROL_LABEL_JS:
            return self.inner_text()
        return "A"

    def click(self, **options):
        assert options.get("no_wait_after") is True
        if self.selector == "a":
            self.page.title_clicks += 1
            self.page.on_title(self.page)
        else:
            self.page.download_clicks += 1
            self.page.on_download(self.page)


class Element:
    """Identity-bound node: unrelated DOM insertions cannot retarget it."""
    def __init__(self, page, data):
        self.page, self.data, self.disposed = page, data, False

    def is_visible(self):
        return self.data.get("visible", True)

    def is_enabled(self):
        return self.data.get("enabled", True)

    def evaluate(self, script):
        if script == mod._CONTROL_LABEL_JS:
            return self.data["text"]
        if script == mod._CONTROL_READY_JS:
            return any(item is self.data for item in self.page.ui["controls"]) and self.is_enabled()
        raise AssertionError(script)

    def click(self, **options):
        assert self.evaluate(mod._CONTROL_READY_JS)
        assert options.get("no_wait_after") is True
        self.page.download_clicks += 1
        self.page.on_download(self.page)

    def dispose(self):
        self.disposed = True


class Page:
    def __init__(self, context, target, opener=None):
        self.context, self.target, self._opener = context, target, opener
        self.url, self.closed = "about:blank", False
        self.gotos, self.title_clicks, self.download_clicks, self.fronts = [], 0, 0, 0
        self.listeners, self.scheduled = {}, []
        self.snap, self.ui = snap(), ui()
        self.main_frame = object()
        self.on_title, self.on_download = self.detail, self.begin_download
        self.lookup_delay = 0

    def is_closed(self):
        return self.closed

    def close(self, **options):
        assert self.target.startswith("owned-")
        self.closed = True

    def bring_to_front(self):
        self.fronts += 1

    def opener(self):
        return None if self._opener is not None and self._opener.closed else self._opener

    def on(self, event, callback):
        self.listeners.setdefault(event, []).append(callback)

    def remove_listener(self, event, callback):
        self.listeners[event].remove(callback)

    def emit(self, event, value):
        for callback in list(self.listeners.get(event, [])):
            callback(value)

    def goto(self, url, **options):
        assert url.startswith(mod.ENTRY + "?kw=")
        self.gotos.append(url)
        self.url = url
        self.snap, self.ui = snap(), copy.deepcopy(self.context.initial_ui)
        return type("Response", (), {"status": 200})()

    def locator(self, selector):
        return Locator(self, selector)

    def query_selector_all(self, selector):
        assert selector == mod.CONTROLS
        return [Element(self, item) for item in self.ui["controls"]]

    def evaluate(self, script):
        if "literature_cnki_fulltext_ui" in script:
            value = copy.deepcopy(self.ui)
            if self.context.clock.now < self.lookup_delay:
                value["rows"] = []
            return value
        assert "literature_fulltext_snapshot" in script
        return copy.deepcopy(self.snap)

    def wait_for_timeout(self, milliseconds):
        assert milliseconds == 200
        self.context.clock.sleep(milliseconds / 1000)
        # A Playwright wait pumps the context event loop, including events on
        # a still-pending popup while its opener remains the bound page.
        for page in self.context.pages:
            for when, event, value in list(page.scheduled):
                if when <= self.context.clock.now:
                    page.scheduled.remove((when, event, value))
                    page.emit(event, value)

    def detail(self, page):
        page.url = "https://kns.cnki.net/kcms2/article/abstract?paper=fixture"
        page.snap = snap(citation_title=TITLE)
        page.ui = ui(controls=[control()])

    def begin_download(self, page):
        page.scheduled.append((self.context.clock.now + 1, "download", Download()))


class Context:
    def __init__(self, clock):
        self.clock, self.pages, self.initial_ui = clock, [], ui()
        self.creates = 0
        self.next_setup = None
        self.listeners = {}
        self.pages.append(Page(self, "researcher-existing"))

    def new_page(self, opener=None):
        self.creates += 1
        page = Page(self, f"owned-{self.creates}", opener=opener)
        self.pages.append(page)
        if self.next_setup:
            self.next_setup(page)
            self.next_setup = None
        return page

    def new_cdp_session(self, page):
        return CDP(page)

    def on(self, event, callback):
        self.listeners.setdefault(event, []).append(callback)

    def remove_listener(self, event, callback):
        self.listeners[event].remove(callback)

    def emit(self, event, value):
        for callback in list(self.listeners.get(event, [])):
            callback(value)

    @contextmanager
    def runtime(self):
        yield self


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "中文任务"
        self.clock, self.messages = Clock(), []
        self.context = Context(self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def fetcher(self):
        return browser.FulltextBrowserFetcher({}, self.path, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep, on_progress=self.messages.append)

    def test_fixed_entry_clicks_real_title_then_pdf_once_and_never_replays_transfer(self):
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(result["bytes"], PDF)
        page = fetcher._page
        self.assertEqual(page.title_clicks, 1)
        self.assertEqual(page.download_clicks, 1)
        self.assertEqual(len(page.gotos), 1)
        self.assertEqual(parse_qs(urlsplit(page.gotos[0]).query)["kw"], [TITLE])
        self.assertNotIn("+", page.gotos[0])
        self.assertNotIn("never-replay", page.gotos[0])
        self.assertFalse(page.closed, "driver must save artifact/status before page closes")
        self.assertFalse(self.context.pages[0].gotos)
        self.assertFalse(self.context.pages[0].closed)
        binding = json.loads(fetcher.binding_path.read_text(encoding="utf-8"))
        self.assertEqual(binding["cnki_flow"]["step"], "download_clicked")
        self.assertEqual(binding["cnki_flow"]["target_id"], page.target)
        self.assertNotIn("token", json.dumps(binding))

    def test_lookup_waits_for_dynamic_rows_without_resubmission(self):
        self.context.next_setup = lambda p: setattr(p, "lookup_delay", self.clock.now + 3)
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(len(self.context.pages[-1].gotos), 1)
        self.assertGreaterEqual(self.clock.now, 1003)

    def test_ambiguous_wrong_query_and_similar_title_never_clicked(self):
        for name, settings in (("ambiguous", ui(count=2)), ("wrong-query", ui(query="热应激")), ("similar", ui(title=TITLE + "综述"))):
            with self.subTest(name=name):
                self.path = Path(self.tmp.name) / name
                self.context.initial_ui = settings
                result = mod.run_cnki(self.fetcher(), RECORD, {})
                self.assertEqual(result["status"], "attention")
                self.assertEqual(self.context.pages[-1].title_clicks, 0)
                self.assertEqual(self.context.pages[-1].download_clicks, 0)

    def test_detail_identity_conflict_never_downloads(self):
        def setup(page):
            def wrong(p):
                p.detail(p)
                p.snap["citation_title"] = "Other publication"
                p.ui["titles"] = ["Other publication"]
            page.on_title = wrong
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(self.context.pages[-1].download_clicks, 0)

    def test_generation_longer_than_navigation_deadline_downloads_once(self):
        def setup(page):
            def delayed(p):
                p.ui["generating"] = True
                p.scheduled.append((self.clock.now + 75, "download", Download()))
            page.on_download = delayed
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(self.context.pages[-1].download_clicks, 1)
        self.assertGreaterEqual(self.clock.now, 1075)

    def test_detail_captcha_pause_resume_reads_original_page_without_second_title_click(self):
        def setup(page):
            def challenge(p):
                p.detail(p)
                p.snap["verification"] = True
            page.on_title = challenge
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["reason"], "verification")
        page = first._page
        self.assertFalse(page.closed)
        page.snap["verification"] = False
        first.close()
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(page.title_clicks, 1)
        self.assertEqual(page.download_clicks, 1)
        self.assertEqual(len(page.gotos), 1)

    def test_after_download_click_resume_never_repeats_download(self):
        def setup(page):
            page.on_download = lambda p: p.snap.update(verification=True)
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["reason"], "verification")
        page = first._page
        page.snap["verification"] = False
        first.close()
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(page.download_clicks, 1)
        self.assertEqual(page.title_clicks, 1)

    def test_official_popup_handoff_only_owned_old_page_closes(self):
        def setup(page):
            def popup(p):
                child = self.context.new_page(opener=p)
                child.detail(child)
                p.emit("popup", child)
            page.on_title = popup
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(self.context.creates, 2)
        self.assertTrue(self.context.pages[1].closed)
        self.assertFalse(self.context.pages[0].closed)
        self.assertFalse(self.context.pages[2].closed)
        self.assertEqual(fetcher._binding["target_id"], self.context.pages[2].target)

    def test_unowned_popup_cannot_be_claimed(self):
        def setup(page):
            def popup(p):
                child = self.context.new_page(opener=self.context.pages[0])
                child.detail(child)
                p.emit("popup", child)
            page.on_title = popup
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(fetcher._page.target, "owned-1")
        self.assertFalse(self.context.pages[2].closed)

    def test_visible_source_error_stops_after_first_paper(self):
        def setup(page):
            def broken(p):
                p.detail(p)
                p.snap.update(page_error=True, source_application_error=True)
            page.on_title = broken
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["reason"], "page_error")
        self.assertIn("来源应用", result["message"])
        self.assertEqual(self.context.pages[-1].download_clicks, 0)

    def test_only_caj_or_purchase_does_not_click(self):
        for name, label in (("caj", "CAJ下载"), ("purchase", "购买PDF")):
            with self.subTest(label=label):
                self.path = Path(self.tmp.name) / name
                def setup(page):
                    def detail(p):
                        p.detail(p)
                        p.ui["controls"] = [control(label)]
                    page.on_title = detail
                self.context.next_setup = setup
                result = mod.run_cnki(self.fetcher(), RECORD, {})
                self.assertEqual(result["status"], "attention")
                self.assertEqual(self.context.pages[-1].download_clicks, 0)

    def test_non_pdf_download_never_success(self):
        def setup(page):
            page.on_download = lambda p: p.emit("download", Download(b"CAJ not a PDF"))
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertIn("PDF校验", result["message"])

    def test_unknown_file_origin_and_nonofficial_redirect_never_success(self):
        for name, redirect in (("unknown-file", False), ("redirect", True)):
            with self.subTest(name=name):
                self.path = Path(self.tmp.name) / name
                def setup(page):
                    def downloaded(p):
                        download = Download()
                        if redirect:
                            p.url = "https://unrelated.test/paper.pdf"
                        else:
                            download.url = "https://unrelated.test/paper.pdf"
                        p.emit("download", download)
                    page.on_download = downloaded
                self.context.next_setup = setup
                result = mod.run_cnki(self.fetcher(), RECORD, {})
                self.assertEqual(result["status"], "attention")
                self.assertNotIn("bytes", result)

    def test_pdf_subframe_ignored_main_frame_pdf_accepted(self):
        for name, main in (("child-frame", False), ("main-frame", True)):
            with self.subTest(name=name):
                self.path = Path(self.tmp.name) / name
                def setup(page):
                    def response(p):
                        request = type("Request", (), {"frame": p.main_frame if main else object(),
                            "is_navigation_request": lambda self: True})()
                        result = type("Response", (), {"url": "https://kns.cnki.net/paper.pdf", "status": 200,
                            "headers": {"content-type": "application/pdf"}, "request": request,
                            "body": lambda self: PDF})()
                        p.emit("response", result)
                    page.on_download = response
                self.context.next_setup = setup
                result = mod.run_cnki(self.fetcher(), RECORD, {})
                self.assertEqual(result["status"], "pdf_page" if main else "attention")

    def test_article_container_flag_alone_does_not_skip_real_pdf_download(self):
        def setup(page):
            def detail(p):
                p.detail(p)
                p.snap.update(container_verified=True, article_text="An abstract only. " * 200,
                              origin="dom_article_region", sections=[])
            page.on_title = detail
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(self.context.pages[-1].download_clicks, 1)

    def test_download_and_error_page_at_same_time_prioritizes_error(self):
        def setup(page):
            def downloaded(p):
                p.snap["verification"] = True
                p.emit("download", Download())
            page.on_download = downloaded
        self.context.next_setup = setup
        result = mod.run_cnki(self.fetcher(), RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["reason"], "verification")

    def test_unrelated_controls_inserted_during_pacing_do_not_retarget_download(self):
        fetcher = self.fetcher()
        original_pace = fetcher._pace
        inserted = []
        def pace(url):
            original_pace(url)
            if "article/abstract" in url and not inserted:
                inserted.append(True)
                fetcher._page.ui["controls"].insert(0, control("登录", 0))
                fetcher._page.ui["controls"][1]["index"] = 1
        fetcher._pace = pace
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(fetcher._page.download_clicks, 1)

    def test_new_second_pdf_during_pacing_still_pauses_without_click(self):
        fetcher = self.fetcher()
        original_pace = fetcher._pace
        def pace(url):
            original_pace(url)
            if "article/abstract" in url:
                fetcher._page.ui["controls"].append(control("PDF下载", 1))
        fetcher._pace = pace
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(fetcher._page.download_clicks, 0)

    def test_official_blob_popup_requires_actual_pdf_download_then_binds_for_cleanup(self):
        def setup(page):
            def downloaded(owner):
                child = self.context.new_page(opener=owner)
                child.url = "blob:https://kns.cnki.net/fixture-blob"
                owner.emit("popup", child)
                download = Download()
                download.url = child.url
                child.emit("download", download)
            page.on_download = downloaded
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(result["bytes"], PDF)
        self.assertEqual(fetcher._page.target, "owned-2")
        self.assertTrue(self.context.pages[1].closed)
        self.assertFalse(fetcher._page.closed, "driver closes only after saved status")
        witness = fetcher._binding["cnki_flow"]["pending_popup"]
        self.assertTrue(witness["opener_verified"])
        self.assertTrue(witness["adopted"])
        self.assertEqual(witness["action"], "download")
        self.assertNotIn("fixture-blob", json.dumps(fetcher._binding))

    def test_empty_attachment_popup_handoff_after_valid_download_does_not_orphan_it(self):
        def setup(page):
            def downloaded(owner):
                child = self.context.new_page(opener=owner)
                owner.emit("popup", child)
                child.emit("download", Download())
            page.on_download = downloaded
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(fetcher._page.url, "about:blank")
        self.assertEqual(fetcher._binding["target_id"], "owned-2")
        self.assertTrue(self.context.pages[1].closed)

    def test_blob_address_alone_never_counts_as_pdf(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "blob:https://kns.cnki.net/not-proven-pdf"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["diagnostic"], "origin")
        self.assertNotIn("bytes", result)
        self.assertEqual(fetcher._binding["target_id"], "owned-1")
        self.assertEqual(fetcher._binding["cnki_flow"]["pending_popup"]["target_id"], "owned-2")

    def test_initial_mainframe_pdf_response_before_popup_event_is_captured_once(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "blob:https://kns.cnki.net/early-pdf"
                child.main_frame = type("Frame", (), {"page": child})()
                request = type("Request", (), {"frame": child.main_frame,
                    "is_navigation_request": lambda self: True})()
                response = type("Response", (), {"url": child.url, "status": 200,
                    "headers": {"content-type": "application/pdf"}, "request": request,
                    "body": lambda self: PDF})()
                self.context.emit("response", response)
                # Must be idempotent with the earlier context response witness.
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(fetcher._page.target, "owned-2")
        self.assertNotEqual(fetcher._binding["cnki_flow"].get("diagnostic"), "extra")
        self.assertEqual(self.context.pages[1].download_clicks, 1)

    def test_recorded_pending_popup_survives_driver_restart_without_reclick(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "https://unverified.test/needs-human-review"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        result = mod.run_cnki(first, RECORD, {})
        self.assertEqual(result["diagnostic"], "origin")
        parent, child = self.context.pages[1], self.context.pages[2]
        self.assertEqual(first._binding["cnki_flow"]["pending_popup"]["target_id"], child.target)
        first.close()
        # Researcher completes normal website operation in that exact window.
        child.detail(child)
        child.ui["generating"] = True
        child.scheduled.append((self.clock.now + 1, "download", Download()))
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(second._binding["target_id"], child.target)
        self.assertEqual(parent.download_clicks, 1)
        self.assertEqual(parent.title_clicks, 1)
        self.assertFalse(child.gotos)
        self.assertEqual(child.download_clicks, 0)

    def test_legacy_unrecorded_popup_is_never_borrowed_on_resume(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                # Simulate an old process which never persisted a popup event.
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["status"], "attention")
        parent, child = self.context.pages[1], self.context.pages[2]
        self.assertNotIn("pending_popup", first._binding["cnki_flow"])
        first.close()
        second = self.fetcher()
        self.assertEqual(mod.run_cnki(second, RECORD, {})["status"], "attention")
        self.assertEqual(second._page, parent)
        self.assertEqual(parent.download_clicks, 1)
        self.assertEqual(child.download_clicks, 0)
        self.assertFalse(child.gotos)

    def test_pending_popup_with_wrong_live_opener_is_owner_diagnostic(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "https://unverified.test/pending"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["diagnostic"], "origin")
        first.close()
        self.context.pages[2]._opener = self.context.pages[0]
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["diagnostic"], "owner")
        self.assertEqual(second._binding["target_id"], "owned-1")

    def test_handoff_write_failure_does_not_switch_memory_or_disk_binding(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        original_write = fetcher._write_binding
        def write():
            if fetcher._binding.get("target_id") == "owned-2":
                raise OSError("fixture commit failure")
            original_write()
        fetcher._write_binding = write
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["diagnostic"], "handoff_error")
        self.assertEqual(fetcher._page.target, "owned-1")
        self.assertEqual(fetcher._binding["target_id"], "owned-1")
        self.assertEqual(json.loads(fetcher.binding_path.read_text(encoding="utf-8"))["target_id"], "owned-1")
        self.assertFalse(self.context.pages[1].closed)
        self.assertFalse(self.context.pages[2].closed)

    def test_failed_old_page_close_is_cleanup_not_failed_ownership(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                owner.emit("popup", child)
                child.emit("download", Download())
                def close(**options):
                    raise OSError("fixture close failure")
                owner.close = close
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(fetcher._page.target, "owned-2")
        self.assertEqual(fetcher._binding["cnki_flow"]["cleanup_target_id"], "owned-1")

    def test_two_pending_popups_are_extra_diagnostic_with_bounded_windows(self):
        def setup(page):
            def opened(owner):
                for _ in range(2):
                    child = self.context.new_page(opener=owner)
                    owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["diagnostic"], "extra")
        self.assertTrue(self.context.pages[3].closed)
        self.assertFalse(self.context.pages[2].closed)

    def test_explicit_single_paper_restart_ignores_old_clicked_step(self):
        def setup(page):
            page.on_download = lambda p: p.snap.update(verification=True)
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["reason"], "verification")
        original = first._page
        first.close()
        original.on_download = original.begin_download
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {"cnki_restart": True})
        self.assertEqual(result["status"], "pdf_page")
        self.assertIs(second._page, original)
        self.assertEqual(len(original.gotos), 2)
        self.assertEqual(original.title_clicks, 2)
        self.assertEqual(original.download_clicks, 2)

    def test_normal_new_official_detail_gets_one_additional_pdf_click(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.on_download = lambda p: p.emit("download", Download())
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        parent, child = self.context.pages[1], self.context.pages[2]
        self.assertEqual((parent.download_clicks, child.download_clicks), (1, 1))
        flow = fetcher._binding["cnki_flow"]
        self.assertEqual(flow["download_click_target_ids"], [parent.target, child.target])
        self.assertEqual(flow["download_click_target_id"], child.target)
        self.assertEqual(flow["download_click_count"], 2)

    def test_additional_detail_click_pause_resume_never_repeats_it(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.on_download = lambda p: p.snap.update(verification=True)
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["reason"], "verification")
        parent, child = self.context.pages[1], self.context.pages[2]
        self.assertEqual((parent.download_clicks, child.download_clicks), (1, 1))
        first.close()
        child.snap["verification"] = False
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual((parent.download_clicks, child.download_clicks), (1, 1))
        self.assertEqual(second._binding["cnki_flow"]["download_click_count"], 2)

    def test_third_detail_page_stops_at_two_click_limit(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.on_download = opened
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertIn("两次确认上限", result["message"])
        self.assertEqual([p.download_clicks for p in self.context.pages[1:]], [1, 1, 0])
        self.assertEqual(fetcher._binding["cnki_flow"]["download_click_count"], 2)
        self.assertEqual(sum(not p.closed for p in self.context.pages[1:]), 1)

    def test_new_detail_with_purchase_dialog_never_gets_additional_click(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.ui["purchase_required"] = True
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["reason"], "access_required")
        self.assertIn("不会确认购买", result["message"])
        self.assertEqual(self.context.pages[2].download_clicks, 0)

    def test_early_context_response_from_unrelated_page_is_ignored(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=self.context.pages[0])
                child.url = "https://kns.cnki.net/unrelated.pdf"
                child.main_frame = type("Frame", (), {"page": child})()
                request = type("Request", (), {"frame": child.main_frame,
                    "is_navigation_request": lambda self: True})()
                response = type("Response", (), {"url": child.url, "status": 200,
                    "headers": {"content-type": "application/pdf"}, "request": request,
                    "body": lambda self: PDF})()
                self.context.emit("response", response)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("bytes", result)
        self.assertNotIn("pending_popup", fetcher._binding["cnki_flow"])

    def test_restart_rejects_live_recorded_popup_without_losing_witness(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "https://unverified.test/keep-for-human"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["diagnostic"], "origin")
        witness = copy.deepcopy(first._binding["cnki_flow"]["pending_popup"])
        first.close()
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {"cnki_restart": True})
        self.assertEqual(result["status"], "attention")
        self.assertIn("已有任务下载窗口", result["message"])
        self.assertEqual(second._binding["cnki_flow"]["pending_popup"], witness)
        self.assertEqual(self.context.creates, 2)
        self.assertEqual(len(self.context.pages[1].gotos), 1)
        self.assertEqual(self.context.pages[1].download_clicks, 1)
        self.assertFalse(self.context.pages[2].closed)

    def test_restart_clears_only_conclusively_closed_popup_then_reuses_owner(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "https://unverified.test/old-window"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["diagnostic"], "origin")
        parent, child = self.context.pages[1], self.context.pages[2]
        child.close()
        parent.on_download = parent.begin_download
        first.close()
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {"cnki_restart": True})
        self.assertEqual(result["status"], "pdf_page")
        self.assertIs(second._page, parent)
        self.assertEqual(self.context.creates, 2)
        self.assertEqual(len(parent.gotos), 2)
        self.assertNotIn("pending_popup", second._binding["cnki_flow"])

    def test_restart_keeps_witness_when_target_absence_cannot_be_verified(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "https://unverified.test/old-window"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["diagnostic"], "origin")
        self.context.pages[2].close()
        witness = copy.deepcopy(first._binding["cnki_flow"]["pending_popup"])
        first.close()
        original_cdp = self.context.new_cdp_session
        def uncertain(page):
            if page.target == "researcher-existing":
                raise RuntimeError("Cannot inspect an open target")
            return original_cdp(page)
        self.context.new_cdp_session = uncertain
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {"cnki_restart": True})
        self.assertEqual(result["diagnostic"], "handoff_error")
        self.assertEqual(second._binding["cnki_flow"]["pending_popup"], witness)
        self.assertEqual(len(self.context.pages[1].gotos), 1)
        self.assertEqual(self.context.creates, 2)

    def test_restart_live_cleanup_rejected_missing_cleanup_can_reset(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                owner.emit("popup", child)
                child.emit("download", Download())
                owner.close = lambda **kwargs: (_ for _ in ()).throw(OSError("fixture close failure"))
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["status"], "pdf_page")
        parent, child = self.context.pages[1], self.context.pages[2]
        # A cleanup-only historical state is also protected, even without a
        # pending-popup record. No close or replacement target is guessed.
        first._binding["cnki_flow"].pop("pending_popup")
        first._write_binding()
        first.close()
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {"cnki_restart": True})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(second._binding["cnki_flow"]["cleanup_target_id"], parent.target)
        self.assertFalse(child.gotos)
        second.close()
        parent.closed = True
        third = self.fetcher()
        result = mod.run_cnki(third, RECORD, {"cnki_restart": True})
        self.assertEqual(result["status"], "pdf_page")
        self.assertIs(third._page, child)
        self.assertNotIn("cleanup_target_id", third._binding["cnki_flow"])
        self.assertEqual(len(child.gotos), 1)
        self.assertEqual(self.context.creates, 2)

    def _bound_blob_after_verified_file(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.url = "blob:https://kns.cnki.net/verified-window"
                owner.emit("popup", child)
                child.emit("download", Download())
            page.on_download = opened
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(mod.run_cnki(first, RECORD, {})["status"], "pdf_page")
        child = first._page
        first.close()
        return child

    def test_bound_official_blob_resume_accepts_new_actual_download_event(self):
        child = self._bound_blob_after_verified_file()
        child.scheduled.append((self.clock.now + 1, "download", Download()))
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        self.assertEqual(result["bytes"], PDF)
        self.assertIs(second._page, child)
        self.assertEqual(self.context.pages[1].download_clicks, 1)
        self.assertEqual(child.download_clicks, 0)
        self.assertFalse(child.gotos)

    def test_bound_blob_url_without_new_file_event_still_pauses(self):
        child = self._bound_blob_after_verified_file()
        second = self.fetcher()
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertEqual(result["diagnostic"], "origin")
        self.assertNotIn("bytes", result)
        self.assertEqual(child.download_clicks, 0)
        self.assertFalse(child.gotos)

    def test_bound_blob_without_witness_rejects_even_fresh_file_event(self):
        child = self._bound_blob_after_verified_file()
        second = self.fetcher()
        second._binding["cnki_flow"].pop("pending_popup")
        second._write_binding()
        original_on = child.on
        def fresh_event(event, callback):
            original_on(event, callback)
            if event == "download":
                callback(Download())
        child.on = fresh_event
        result = mod.run_cnki(second, RECORD, {})
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("bytes", result)
        self.assertEqual(child.download_clicks, 0)
        self.assertFalse(child.gotos)

    def test_pending_http_naturally_redirects_to_official_without_replay(self):
        def setup(page):
            def opened(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                child.url = "http://kns.cnki.net/temporary-entry?token=never-export"
                child.ui["generating"] = True
                child.on("natural-ready", lambda _: setattr(child, "url", "https://kns.cnki.net/kcms2/article/abstract?v=never-export"))
                child.scheduled.append((self.clock.now + 2, "natural-ready", None))
                child.scheduled.append((self.clock.now + 3, "download", Download()))
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        parent, child = self.context.pages[1], self.context.pages[2]
        self.assertEqual(parent.download_clicks, 1)
        self.assertEqual(child.download_clicks, 0)
        self.assertEqual(len(parent.gotos), 1)
        self.assertFalse(child.gotos)
        self.assertEqual(sum("下载窗口正在跳转" in value for value in self.messages), 1)
        self.assertNotIn("never-export", json.dumps(fetcher._binding))

    def test_pending_origin_deadline_independent_of_parent_generation_and_safe_summary(self):
        opened_at = []
        def setup(page):
            def opened(owner):
                opened_at.append(self.clock.now)
                owner.ui["generating"] = True
                child = self.context.new_page(opener=owner)
                child.url = "http://secret-user:secret-password@kns.cnki.net:8129/private-path?v=secret-token#secret-fragment"
                owner.emit("popup", child)
            page.on_download = opened
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = mod.run_cnki(fetcher, RECORD, {})
        self.assertEqual(result["diagnostic"], "origin")
        summary = result["origin_summary"]
        self.assertEqual((summary["protocol"], summary["hostname"], summary["category"]), ("http", "kns.cnki.net", "http_cnki"))
        self.assertEqual(fetcher._binding["cnki_flow"]["origin_summary"], summary)
        self.assertGreaterEqual(self.clock.now - opened_at[0], 60)
        self.assertLess(self.clock.now - opened_at[0], 61)
        self.assertEqual(sum("下载窗口正在跳转" in value for value in self.messages), 1)
        for secret in ("secret-user", "secret-password", "8129", "private-path", "secret-token", "secret-fragment"):
            self.assertNotIn(secret, json.dumps(result, ensure_ascii=False))
            self.assertNotIn(secret, json.dumps(fetcher._binding, ensure_ascii=False))
        self.assertEqual(self.context.pages[1].download_clicks, 1)
        self.assertFalse(self.context.pages[2].gotos)
        self.assertEqual(self.context.pages[2].download_clicks, 0)

    def test_official_popup_concrete_auth_or_page_error_precedes_origin_diagnostic(self):
        for name, problem, expected in (("auth", {"verification": True}, "verification"),
                                        ("source", {"page_error": True, "source_application_error": True}, "page_error")):
            with self.subTest(name=name):
                self.path = Path(self.tmp.name) / name
                def setup(page):
                    def opened(owner):
                        child = self.context.new_page(opener=owner)
                        child.detail(child)
                        child.snap.update(problem)
                        owner.emit("popup", child)
                    page.on_download = opened
                self.context.next_setup = setup
                result = mod.run_cnki(self.fetcher(), RECORD, {})
                self.assertEqual(result["reason"], expected)
                self.assertNotEqual(result.get("diagnostic"), "origin")
                self.assertNotIn("origin_summary", result)
                self.assertEqual(self.context.pages[-1].download_clicks, 0)


class OriginSummaryTests(unittest.TestCase):
    def test_fixed_categories_and_no_credentials_paths_queries_fragments_or_port_values(self):
        cases = [
            ("http://kns.cnki.net/secret-path?v=secret-token", "http", "kns.cnki.net", "http_cnki"),
            ("https://publisher.example/secret-path?v=secret-token", "https", "publisher.example", "https_other"),
            ("https://secret-user:secret-pass@kns.cnki.net:8791/secret-path?v=secret-token#secret-fragment", "https", "kns.cnki.net", "official_unsupported"),
            ("https://kns.cnki.net:not-a-port/secret-path?v=secret-token", "https", "kns.cnki.net", "official_unsupported"),
            ("https://kns.cnki.net:443/secret-path?v=secret-token", "https", "kns.cnki.net", "https_cnki"),
            ("about:blank#secret-token", "about", "", "about_variant"),
            ("about:srcdoc", "about", "", "about_variant"),
            ("chrome-extension://private-extension-id/secret-path?v=secret-token", "chrome-extension", "", "browser_internal"),
            ("chrome-error://chromewebdata/secret-path?v=secret-token", "chrome-error", "", "browser_internal"),
            ("blob:https://kns.cnki.net/secret-path?v=secret-token", "blob:https", "kns.cnki.net", "official_blob_pending"),
            ("blob:https://publisher.example/secret-path?v=secret-token", "blob:https", "publisher.example", "blob_other"),
            ("file:///C:/secret-path?v=secret-token", "other", "", "other"),
        ]
        for value, protocol, hostname, category in cases:
            with self.subTest(category=category, protocol=protocol):
                summary = mod._origin_summary(value)
                self.assertEqual((summary["protocol"], summary["hostname"], summary["category"]), (protocol, hostname, category))
                serialized = json.dumps(summary, ensure_ascii=False)
                for secret in ("secret-user", "secret-pass", "8791", "not-a-port", "secret-path", "secret-token", "secret-fragment", "private-extension-id"):
                    self.assertNotIn(secret, serialized)

    def test_summary_never_changes_allowed_official_origins(self):
        for value in ("http://kns.cnki.net/article", "https://publisher.example/article", "blob:https://kns.cnki.net/id",
                      "https://user:pass@kns.cnki.net/article", "https://kns.cnki.net:8791/article", "https://kns.cnki.net:not-a-port/article"):
            with self.subTest(value=value):
                mod._origin_summary(value)
                self.assertFalse(mod._official(value))
        self.assertTrue(mod._official("https://kns.cnki.net/kcms2/article/abstract?v=secret-token"))


class LocalDOMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        if not Path(cls.playwright.chromium.executable_path).exists():
            cls.playwright.stop()
            raise unittest.SkipTest("Chromium not installed for isolated offline DOM")
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--disable-background-networking"])
        cls.context = cls.browser.new_context()
        cls.context.route("**/*", lambda route: route.abort())
        cls.page = cls.context.new_page()

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def test_actual_dom_row_and_query_match_and_click_identity(self):
        self.page.set_content(f'<input id="txt_SearchText" value="{TITLE}"><table class="result-table-list"><tbody>'
            f'<tr><td class="name"><a href="#" onclick="document.body.dataset.clicked=\'yes\';return false">{TITLE}</a></td></tr>'
            '<tr style="display:none"><td><a href="#">hidden</a></td></tr></tbody></table>')
        data = self.page.evaluate(mod._CNKI_UI_JS)
        self.assertEqual(mod._exact_result(data, TITLE), [(0, 0)])
        locator = self.page.locator(data["rowSelector"]).nth(0).locator("a").nth(0)
        self.assertEqual(locator.inner_text(), TITLE)
        locator.click()
        self.assertEqual(self.page.locator("body").get_attribute("data-clicked"), "yes")

    def test_actual_dom_pdf_control_and_financial_caj_controls(self):
        self.page.set_content('<h1>' + TITLE + '</h1><a>购买PDF</a><a>CAJ下载</a><button style="display:none">PDF下载</button><button>PDF下载</button>')
        data = self.page.evaluate(mod._CNKI_UI_JS)
        selected, caj, ambiguous = mod._download_control(data)
        self.assertEqual(selected["index"], 3)
        self.assertTrue(caj)
        self.assertFalse(ambiguous)
        self.assertEqual(self.page.locator(mod.CONTROLS).nth(selected["index"]).inner_text(), "PDF下载")

    def test_actual_dom_visible_icon_button_accessible_download_label(self):
        self.page.set_content('<button aria-label="PDF下载"><span style="display:inline-block;width:20px;height:20px">↓</span></button>'
                              '<input type="button" value="下载全文">')
        selected, _, _ = mod._download_control(self.page.evaluate(mod._CNKI_UI_JS))
        self.assertEqual(selected["index"], 0)
        self.assertEqual(self.page.locator(mod.CONTROLS).nth(0).evaluate(mod._CONTROL_LABEL_JS), "PDF下载")

    def test_actual_dom_whitespace_fallback_and_dynamic_insertion_click_original_node(self):
        self.page.set_content('<a href="#" title="PDF下载" style="display:inline-block;width:30px;height:30px" '
            'onclick="document.body.dataset.downloaded=\'yes\';return false">\n   </a>')
        data = self.page.evaluate(mod._CNKI_UI_JS)
        self.assertEqual(data["controls"][0]["text"], "PDF下载")
        element, selected = mod._download_element(self.page)
        self.assertEqual(selected["text"], "PDF下载")
        self.assertEqual(element.evaluate(mod._CONTROL_LABEL_JS), "PDF下载")
        # Reproduce a navigation/ad widget that inserts an unrelated anchor
        # after the snapshot/handle selection, before the eventual click.
        self.page.evaluate("document.body.insertAdjacentHTML('afterbegin', '<a href=\"#\" onclick=\"document.body.dataset.wrong=1;return false\">登录</a>')")
        element.click(no_wait_after=True)
        self.assertEqual(self.page.locator("body").get_attribute("data-downloaded"), "yes")
        self.assertIsNone(self.page.locator("body").get_attribute("data-wrong"))
        element.dispose()

    def test_actual_dom_whitespace_input_and_image_fallback_labels_are_consistent(self):
        self.page.set_content('<a href="#" aria-label="  " title="PDF下载" style="display:inline-block;width:30px;height:30px">\n </a>'
                              '<button title="下载全文">\n </button><a href="#"><img alt="CAJ下载" style="width:20px;height:20px"></a>')
        data = self.page.evaluate(mod._CNKI_UI_JS)
        elements = self.page.query_selector_all(mod.CONTROLS)
        self.assertEqual([item["text"] for item in data["controls"]], ["PDF下载", "下载全文", "CAJ下载"])
        self.assertEqual([item.evaluate(mod._CONTROL_LABEL_JS) for item in elements], ["PDF下载", "下载全文", "CAJ下载"])
        for element in elements:
            element.dispose()

    def test_actual_dom_payment_confirmation_is_explicitly_flagged(self):
        self.page.set_content('<h1>' + TITLE + '</h1><div role="dialog">请购买全文，支付后下载<button>下载</button></div>')
        self.assertTrue(self.page.evaluate(mod._CNKI_UI_JS)["purchase_required"])
        self.page.set_content('<nav><a>充值</a><a>订阅</a></nav><h1>' + TITLE + '</h1><button>PDF下载</button>')
        self.assertFalse(self.page.evaluate(mod._CNKI_UI_JS)["purchase_required"])


if __name__ == "__main__":
    unittest.main()
