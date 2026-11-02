"""Isolated Chromium DOM/download regression; every request is fulfilled locally.

No live paper, user's browser/profile, task or downloaded article is accessed.
Run separately from fast fake-page unit fixtures (requires Playwright Chromium).
"""
from contextlib import contextmanager
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from playwright.sync_api import ElementHandle, TimeoutError as PlaywrightTimeoutError, sync_playwright

import literature_fulltext_browser as mod
from test_literature_fulltext_browser import Clock, PDF


DOI = "10.1080/10495398.2021.1972005"
TITLE = "Physiological dynamics in broiler chickens under heat stress and possible mitigation strategies."
READER = "https://publisher.test/doi/epdf/" + DOI
ABSTRACT = "https://publisher.test/doi/abs/" + DOI
TARGET = "https://publisher.test/doi/pdf/" + DOI + "?download=true"
RECORD = {"paper_id": "FIXTURE-005", "doi": DOI, "title": TITLE}


def reader(*, popup=False, identity=DOI):
    return f"""<!DOCTYPE html><meta name="citation_doi" content="{identity}">
    <meta name="citation_title" content="{TITLE}"><h1>{TITLE}</h1>
    <div role="progressbar" aria-label="Reading progress is 10%"></div>
    <a href="#fulltext">Skip to content</a>
    {''.join('<a href="/navigation/%d">Full text reference</a>' % n for n in range(12))}
    <button id="pdf-menu" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1;document.getElementById('formats').hidden=false">PDF</button>
    <div id="formats" hidden><a id="actual-pdf" {'target="_blank"' if popup else ''}
      href="{TARGET}" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">PDF • 1.3 MB</a>
      <a href="/doi/epub/{DOI}">EPUB • 766.5 KB</a></div>"""


class ReaderDomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.context = self.browser.new_context(accept_downloads=True)
        self.requests = []
        self.content = reader()
        self.answer = "download"
        self.download_referrer = READER
        self.context.route("**/*", self.route)

        @contextmanager
        def runtime():
            yield self.context
        self.fetcher = mod.FulltextBrowserFetcher({}, self.tmp.name, runtime_factory=runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        self.fetcher.ensure_ready()
        self.page = self.fetcher._page
        self.fetcher._pace = lambda _: None
        def tick(page):
            page.wait_for_timeout(20)
            self.clock.sleep(.2)
        self.fetcher._wait_tick = tick
        self.out = Path(self.tmp.name) / "main.pdf"

    def tearDown(self):
        self.fetcher.close()
        self.context.close()
        self.tmp.cleanup()

    def route(self, route):
        req = route.request
        self.requests.append((req.url, req.headers))
        if req.url == READER:
            route.fulfill(content_type="text/html", body=self.content)
        elif req.url == ABSTRACT:
            route.fulfill(content_type="text/html", body=f'''<!DOCTYPE html>
                <meta name="citation_title" content="{TITLE}"><h1>{TITLE}</h1>
                <p>Access provided by Nanjing University. Full access.</p>
                <div class="abstract">{'Article abstract text. ' * 12}</div>
                <a id="view-pdf" href="{READER}" target="_blank"
                  onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">View PDF</a>
                <a id="detail-download" href="{TARGET}"
                  onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Download PDF</a>''')
        elif req.url == TARGET and self.answer == "download":
            # This fixture would reject direct goto/HTTP replay: the same-paper
            # reader click is required for its real navigation referrer.
            if req.headers.get("referer") != self.download_referrer:
                route.fulfill(status=403, content_type="text/html", body="not entitled")
            else:
                route.fulfill(content_type="application/pdf", headers={"content-disposition": 'attachment; filename="main.pdf"'}, body=PDF)
        elif req.url == TARGET and self.answer == "login":
            route.fulfill(content_type="text/html", body='<h1>Please sign in</h1><input type="password">')
        elif req.url == TARGET and self.answer == "pending":
            route.fulfill(content_type="text/html", body='<main aria-busy="true">Generating your PDF</main>')
        else:
            route.abort()  # No real-network fallback is allowed in this suite.

    def open_reader(self):
        result = self.fetcher.fetch_page(READER, {"record": RECORD})
        self.assertEqual(result["status"], "ok")
        proof = self.page.evaluate(mod._SNAPSHOT_JS)
        self.assertTrue(proof["reader_ready"])
        self.assertFalse(proof["download_pending"])
        self.assertEqual(proof["links"][0]["url"], TARGET)

    def open_sciencedirect(self, *, advertisement=True, auth=False):
        source = "https://www.sciencedirect.com/science/article/pii/LOCALFIXTURE"
        target = source + "/pdf"
        modal = '''<div class="js-react-modal"><div class="modal-content"
            style="position:fixed;inset:0;background:white;z-index:99999">
            <p>ADVERTISEMENT</p><h2>Other users also viewed these articles</h2>
            <label><input id="remember-ad" type="checkbox">Don't show again</label>
            <button id="close-ad" aria-label="close window" onclick="this.parentElement.style.display='none';window.closedAds=(window.closedAds||0)+1">×</button>
            <button onclick="window.badDownload=true">Download (6) PDFs</button>
            </div></div>''' if advertisement else ""
        html = f'''<!DOCTYPE html><meta name="citation_doi" content="{DOI}">
            <meta name="citation_title" content="{TITLE}"><h1>{TITLE}</h1>
            <a id="main-pdf" href="{target}" onclick="window.mainClicks=(window.mainClicks||0)+1">View PDF</a>
            {modal}{'<input type="password">' if auth else ''}'''
        self.context.route("https://www.sciencedirect.com/**", lambda route: route.fulfill(
            content_type="application/pdf", body=PDF, headers={"content-disposition": 'attachment; filename="main.pdf"'})
            if route.request.url == target else route.fulfill(content_type="text/html", body=html))
        self.page.goto(source)
        return source, target

    def test_sciencedirect_recommendation_closes_only_close_control_and_saves_main_pdf(self):
        _, target = self.open_sciencedirect()
        result = self.fetcher.fetch_pdf(target, self.out, {"record": RECORD})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(self.out.read_bytes(), PDF)
        self.assertEqual(self.page.evaluate("() => [window.closedAds, window.mainClicks, !!window.badDownload]"), [1, 1, False])
        self.assertFalse(self.page.locator("#remember-ad").is_checked())
        self.assertFalse(self.fetcher._binding.get("pdf_click_pending"))

    def test_click_timeout_before_dispatch_is_durable_and_explicitly_retryable(self):
        _, target = self.open_sciencedirect(advertisement=False)
        with patch.object(ElementHandle, "click", side_effect=PlaywrightTimeoutError("offline intercepted click")):
            first = self.fetcher.fetch_pdf(target, self.out, {"record": RECORD})
        self.assertEqual(first["reason"], "page_not_ready")
        self.assertEqual(self.fetcher._binding["pdf_click_state"]["phase"], "failed_before_dispatch")
        self.assertIsNone(self.page.evaluate("() => window.mainClicks"))
        self.fetcher._blocked = None
        saved = self.fetcher.fetch_pdf(target, self.out, {"record": RECORD, "refresh_expired_pdf": True})
        self.assertEqual(saved["status"], "saved")
        self.assertEqual(self.page.evaluate("() => window.mainClicks"), 1)
        self.assertEqual(self.fetcher._binding["pdf_parent_fallback"]["explicit_retry"]["evidence"], "failed_before_dispatch")

    def test_recommendation_modal_with_auth_is_left_for_human(self):
        self.open_sciencedirect(auth=True)
        self.fetcher._dismiss_sciencedirect_recommendations(self.page, RECORD)
        self.assertIsNone(self.page.evaluate("() => window.closedAds"))
        self.assertTrue(self.page.locator(".modal-content").is_visible())

    def test_closed_reader_menu_downloads_exact_pdf_using_actual_click(self):
        self.open_reader()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(result["acquisition_method"], "observed_pdf_click")
        self.assertEqual(self.out.read_bytes(), PDF)
        self.assertEqual(self.page.locator('#pdf-menu').get_attribute('data-clicks'), "1")
        self.assertEqual(self.page.locator('#actual-pdf').get_attribute('data-clicks'), "1")
        self.assertEqual([url for url, _ in self.requests], [READER, TARGET])
        self.assertFalse(self.page.is_closed())
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(self.page.is_closed())

    def test_direct_download_popup_captures_file_and_keeps_reader_until_save(self):
        self.content = reader(popup=True)
        self.open_reader()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(self.out.read_bytes(), PDF)
        self.assertFalse(self.page.is_closed())
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(self.page.is_closed())

    def test_abstract_view_pdf_opens_reader_then_downloads_its_actual_pdf_menu(self):
        result = self.fetcher.fetch_page(ABSTRACT, {"record": RECORD})
        self.assertEqual(result["status"], "ok")
        result = self.fetcher.fetch_pdf(READER, self.out, {"record": RECORD})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(result["acquisition_method"], "observed_pdf_click")
        self.assertEqual(self.out.read_bytes(), PDF)
        self.assertEqual([url for url, _ in self.requests], [ABSTRACT, READER, TARGET])
        self.assertEqual(self.page.locator('#view-pdf').get_attribute('data-clicks'), "1")
        child = self.fetcher._page
        self.assertIsNot(child, self.page)
        self.assertEqual(child.locator('#pdf-menu').get_attribute('data-clicks'), "1")
        self.assertEqual(child.locator('#actual-pdf').get_attribute('data-clicks'), "1")
        self.assertFalse(self.page.is_closed())
        self.assertFalse(child.is_closed())
        self.assertNotIn("pdf_click_pending", self.fetcher._binding)
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(self.page.is_closed())
        self.assertTrue(child.is_closed())

    def test_login_result_never_replays_download_or_closes_permission_page(self):
        self.answer = "login"
        self.open_reader()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["reason"], "login")
        self.assertEqual([url for url, _ in self.requests], [READER, TARGET])
        self.assertFalse(self.out.exists())
        self.assertFalse(self.fetcher.complete_paper(skipped=True)["closed"])
        self.assertFalse(self.page.is_closed())

    def test_generating_popup_keeps_both_owned_pages_without_retrying_click(self):
        self.content = reader(popup=True)
        self.answer = "pending"
        self.open_reader()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertEqual([url for url, _ in self.requests], [READER, TARGET])
        self.assertEqual(len(self.context.pages), 2)
        self.assertFalse(self.fetcher.complete_paper(skipped=True)["closed"])
        self.assertFalse(self.out.exists())

    def test_other_paper_identity_never_activates_observed_control(self):
        self.open_reader()
        self.assertIsNone(self.fetcher._click_current_pdf(TARGET, self.out, {"record": dict(RECORD, doi="10.1080/other")}))
        self.assertIsNone(self.page.locator('#pdf-menu').get_attribute('data-clicks'))
        self.assertEqual([url for url, _ in self.requests], [READER])

    def test_missing_pdf_keeps_ready_reader_before_other_material_gateways(self):
        self.open_reader()
        record = dict(RECORD, source_url="https://publisher.test/unrelated-gateway",
                      fulltext_links=[{"url": READER}])
        result = self.fetcher.inspect_materials(record, {"replenish_materials": True, "main_pdf_first": True})
        self.assertTrue(result["main_pdf_ready"])
        self.assertEqual(result["main_pdf_links"][0]["url"], TARGET)
        self.assertEqual([url for url, _ in self.requests], [READER])
        self.assertEqual(self.page.url, READER)
        self.assertFalse(self.out.exists())

    def test_pending_click_record_survives_restart_without_activating_again(self):
        self.content = reader(popup=True)
        self.answer = "pending"
        self.open_reader()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["reason"], "page_not_ready")
        self.fetcher.close()
        @contextmanager
        def runtime():
            yield self.context
        restarted = mod.FulltextBrowserFetcher({}, self.tmp.name, runtime_factory=runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        try:
            self.assertEqual(restarted._binding["pending_url_hash"], mod._url_hash(TARGET))
            restarted._wait_tick = self.fetcher._wait_tick
            result = restarted.fetch_pdf(TARGET, self.out, {"record": RECORD})
            self.assertEqual(result["reason"], "page_not_ready")
            self.assertEqual([url for url, _ in self.requests], [READER, TARGET])
            self.assertEqual(self.page.locator('#actual-pdf').get_attribute('data-clicks'), "1")
            self.assertFalse(restarted.complete_paper(skipped=True)["closed"])
            restarted._find_bound_page().close()
            missing = restarted.fetch_pdf(TARGET, self.out, {"record": RECORD})
            self.assertEqual(missing["reason"], "page_not_ready")
            self.assertEqual([url for url, _ in self.requests], [READER, TARGET])
        finally:
            restarted.close()

    def test_missing_pending_original_is_not_replaced_even_before_first_visit(self):
        self.fetcher._binding.update(pdf_click_pending=True, pending_url_hash=mod._url_hash(TARGET))
        self.fetcher._write_binding()
        self.page.close()
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertEqual(self.fetcher._binding["pending_url_hash"], mod._url_hash(TARGET))
        self.assertEqual(self.requests, [])
        self.assertFalse(self.out.exists())
        self.assertEqual(len(self.context.pages), 0)

    def stalled_owned_reader(self):
        self.page.goto(ABSTRACT)
        with self.page.expect_popup() as popup:
            self.page.locator('#view-pdf').click()
        child = popup.value
        child.set_content('<p>Reader environment loaded. Loading publication</p>')
        parent_id = mod.literature_browser._target_id(self.context, self.page)
        child_id = mod.literature_browser._target_id(self.context, child)
        self.fetcher._binding.update(target_id=child_id, pdf_cleanup_target_ids=[parent_id],
            pending_url_hash=mod._url_hash(READER), pdf_click_pending=True, attention_reason="page_not_ready")
        self.fetcher._write_binding()
        self.fetcher._page = child
        return child, parent_id, child_id

    def test_inert_reader_reuses_owned_same_paper_parent_final_pdf_without_reopening(self):
        child, parent_id, child_id = self.stalled_owned_reader()
        original = dict(self.fetcher._binding)
        inspected = self.fetcher.inspect_materials(dict(RECORD, source_url=ABSTRACT),
            {"replenish_materials": True, "main_pdf_first": True})
        self.assertTrue(inspected["main_pdf_ready"])
        self.assertEqual([link["url"] for link in inspected["main_pdf_links"]], [TARGET])
        self.assertEqual(self.fetcher._binding["target_id"], parent_id)
        self.assertEqual(self.fetcher._binding["pending_url_hash"], original["pending_url_hash"])
        self.assertEqual(self.fetcher._binding["pdf_parent_fallback"]["target_id"], child_id)
        self.assertIn(child_id, self.fetcher._binding["pdf_cleanup_target_ids"])
        self.assertFalse(self.fetcher.complete_paper()["closed"])
        self.download_referrer = ABSTRACT
        result = self.fetcher.fetch_pdf(TARGET, self.out, {"record": RECORD})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(self.out.read_bytes(), PDF)
        self.assertEqual([url for url, _ in self.requests], [ABSTRACT, READER, TARGET])
        self.assertEqual(self.page.locator('#view-pdf').get_attribute('data-clicks'), "1")
        self.assertEqual(self.page.locator('#detail-download').get_attribute('data-clicks'), "1")
        self.assertEqual(self.fetcher._binding["pdf_parent_fallback"]["pending_url_hash"], original["pending_url_hash"])
        self.assertFalse(child.is_closed())
        self.assertFalse(self.page.is_closed())
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(child.is_closed())
        self.assertTrue(self.page.is_closed())
        self.assertNotIn("pdf_parent_fallback", self.fetcher._binding)

    def test_owned_parent_fallback_never_hides_child_auth_or_active_loading(self):
        child, _, child_id = self.stalled_owned_reader()
        for html in ('<input type="password">', '<main aria-busy="true">Loading publication</main>'):
            with self.subTest(html=html):
                child.set_content(html)
                self.assertIsNone(self.fetcher._owned_parent_pdf(RECORD))
                self.assertEqual(self.fetcher._binding["target_id"], child_id)
                self.assertNotIn("pdf_parent_fallback", self.fetcher._binding)
                self.assertFalse(child.is_closed())
                self.assertEqual([url for url, _ in self.requests], [ABSTRACT, READER])


if __name__ == "__main__":
    unittest.main()
