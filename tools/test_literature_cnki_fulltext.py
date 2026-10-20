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
        return self._opener

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
        for when, event, value in list(self.scheduled):
            if when <= self.context.clock.now:
                self.scheduled.remove((when, event, value))
                self.emit(event, value)

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


if __name__ == "__main__":
    unittest.main()
