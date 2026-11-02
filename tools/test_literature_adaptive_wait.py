"""Slow-page/reader fixtures only; no real database or downloaded paper access."""
import copy
from contextlib import contextmanager
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest

import literature_fulltext_browser as browser
import literature_cnki_fulltext as cnki
import test_literature_fulltext_browser as generic
import test_literature_materials_browser as material
import test_literature_cnki_fulltext as chinese


def loading(**changes):
    return generic.snapshot(text="Loading", citation_title="", citation_doi="", article_text="",
        headings=[], ready_state="complete", loading_pending=True, **changes)


def ready():
    return generic.snapshot(text="Article body " * 100, article_text="Actual body " * 100,
                            ready_state="complete", container_verified=True, loading_pending=False)


class AdaptivePages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = generic.Clock()
        self.context = generic.Context()
        self.fetcher = browser.FulltextBrowserFetcher({}, self.tmp.name, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        self.fetcher.ensure_ready()
        self.page = self.fetcher._page
        self.page.url = "https://publisher.test/article/1"
        self.initial = self.clock.now

    def tearDown(self):
        self.fetcher.close()
        self.tmp.cleanup()

    def test_short_spa_shell_waits_for_delayed_article_not_navigation_links(self):
        def current(script):
            if self.clock.now - self.initial < 12:
                return loading(links=[{"text": "Skip to content", "url": self.page.url + "#fulltext"}])
            return ready()
        self.page.evaluate = current
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(self.clock.now - self.initial, 15)
        self.assertFalse(self.page.closed)

    def test_permanent_spinner_has_bounded_wait_and_cannot_be_closed_as_skip(self):
        self.page.evaluate = lambda _: loading()
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertGreaterEqual(self.clock.now - self.initial, 120)
        self.assertLess(self.clock.now - self.initial, 121)
        self.assertFalse(self.fetcher.complete_paper(skipped=True)["closed"])
        self.assertFalse(self.page.closed)

    def test_real_progress_extends_wait_past_old_three_minute_limit(self):
        self.page.evaluate = lambda _: (loading(file_progress=[int((self.clock.now - self.initial) // 45)])
            if self.clock.now - self.initial < 235 else ready())
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(self.clock.now - self.initial, 238)

    def test_continuous_progress_has_total_activity_bound(self):
        self.page.evaluate = lambda _: loading(file_progress=[int(self.clock.now - self.initial)])
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertGreaterEqual(self.clock.now - self.initial, 600)
        self.assertLess(self.clock.now - self.initial, 601)
        self.assertFalse(self.page.closed)

    def test_auth_is_immediate_and_human_wait_has_no_countdown(self):
        self.page.evaluate = lambda _: loading(login=True)
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["reason"], "login")
        self.assertEqual(self.clock.now, self.initial)
        self.clock.sleep(10000)
        self.assertFalse(self.fetcher.complete_paper(skipped=True)["closed"])
        self.assertFalse(self.page.closed)

    def test_true_404_is_not_a_pending_loading_page(self):
        self.page.steps = [{"response": generic.Response(404), "snapshot": loading(page_error=True)}]
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["reason"], "page_error")
        self.assertEqual(self.clock.now, self.initial)

    def test_ready_doi_pdf_reader_does_not_claim_no_supplements(self):
        snapshot = generic.snapshot(ready_state="complete", reader_ready=True, citation_title="",
            materials={"links": [], "complete": True, "region_found": False, "none_declared": False})
        self.assertTrue(browser._snapshot_usable(snapshot))
        discovery = self.fetcher._discovery({"paper_id": "P-1", "doi": "10.1/test"}, snapshot, self.page.url)
        self.assertEqual(discovery["status"], "unknown")
        self.assertEqual(discovery["reason"], "only_main_pdf_page_available")

    def test_ready_jstage_observed_pdf_controls_are_not_false_loading_timeouts(self):
        for label_key, label, url in (("text", "PDF", "https://www.jstage.jst.go.jp/article/paper/_pdf"),
                                      ("label", "Download PDF", "https://www.jstage.jst.go.jp/article/paper/_pdf/-char/en")):
            with self.subTest(label=label):
                snapshot = generic.snapshot(ready_state="complete", citation_doi="", article_text="", headings=[],
                    container_verified=False, bibliographic_ready=False, links=[{label_key: label, "url": url}])
                self.assertTrue(browser._snapshot_usable(snapshot))
                self.page.steps = [{"snapshot": snapshot}]
                initial = self.clock.now
                result = self.fetcher.fetch_page(self.page.url, {})
                self.assertEqual(result["status"], "ok")
                self.assertFalse(result["html_evidence"]["container_verified"])
                self.assertLess(self.clock.now - initial, 12)

    def test_interactive_identified_pdf_page_waits_for_stability_then_is_ready(self):
        snapshot = generic.snapshot(ready_state="interactive", article_text="", headings=[],
            container_verified=False, loading_pending=False, download_pending=False,
            links=[{"text": "Download PDF", "url": "https://link.springer.com/content/pdf/10.1/test.pdf"}])
        self.assertTrue(browser._snapshot_usable(snapshot))
        self.page.steps = [{"snapshot": snapshot}]
        result = self.fetcher.fetch_page(self.page.url, {})
        self.assertEqual(result["status"], "ok")
        self.assertGreaterEqual(self.clock.now - self.initial, 3)
        self.assertLess(self.clock.now - self.initial, 4)
        self.assertFalse(result["html_evidence"]["container_verified"])
        self.assertFalse(self.page.closed)

    def test_interactive_pdf_page_explicit_loading_flags_still_preserve_page(self):
        for flag in ("loading_pending", "download_pending"):
            with self.subTest(flag=flag):
                snapshot = generic.snapshot(ready_state="interactive", article_text="", headings=[],
                    links=[{"text": "Download PDF", "url": "https://link.springer.com/content/pdf/10.1/test.pdf"}],
                    **{flag: True})
                self.assertTrue(browser._page_loading(snapshot))
                self.assertFalse(browser._snapshot_usable(snapshot))
                self.page.evaluate = lambda _, value=snapshot: copy.deepcopy(value)
                self.assertFalse(self.fetcher._close_task_binding(self.fetcher._binding)["closed"])
                self.assertFalse(self.page.closed)

    def test_native_pdf_recovery_waits_active_generation_before_browser_download(self):
        target = "https://publisher.test/doi/pdf/10.1/test"
        self.page.url = target
        self.fetcher._request_url = target
        requested, clicked = [], []
        class API:
            def get(_, url, **options):
                requested.append((url, self.clock.now, options))
                return generic.Response(headers={"content-type": "application/pdf"}, body=generic.PDF)
        self.context.request = API()
        def snapshot(script, options=None):
            if script == "() => document.contentType":
                return "application/pdf"
            return generic.snapshot(ready_state="complete", download_pending=self.clock.now - self.initial < 4,
                file_progress=[int(self.clock.now - self.initial)], article_text="", headings=[], links=[])
        self.page.evaluate = snapshot
        @contextmanager
        def expect_download(**options):
            yield SimpleNamespace(value=SimpleNamespace(save_as=lambda path: Path(path).write_bytes(generic.PDF)))
        self.page.expect_download = expect_download
        self.page.locator = lambda selector: SimpleNamespace(click=lambda **options: clicked.append(self.clock.now))
        response = generic.Response(headers={"content-type": "application/pdf"}, body=b"<html>native PDF shell</html>")
        response.url = target
        result = self.fetcher._wait_inline_pdf(self.page, response, Path(self.tmp.name) / "native.pdf",
            "https://publisher.test/article/1", [])
        self.assertEqual(result["status"], "saved")
        self.assertEqual(requested, [])
        self.assertEqual(len(clicked), 1)
        self.assertGreaterEqual(clicked[0] - self.initial, 4)
        self.assertFalse(self.page.closed)

    def test_fresh_blank_target_does_not_block_article_inspection_navigation(self):
        self.page.url = "about:blank"
        snapshot = ready()
        snapshot["materials"] = {"links": [], "complete": True, "region_found": False, "none_declared": True}
        self.page.steps = [{"snapshot": snapshot}]
        record = {"paper_id": "P-1", "title": "Heat stress in broilers", "doi": "10.1/test",
                  "source_url": "https://publisher.test/article/1"}
        discovery = self.fetcher.capture_material_discovery(record)
        self.assertEqual(discovery["reason"], "article_page_not_opened")
        self.assertEqual(self.clock.now, self.initial)
        self.assertIsNone(self.fetcher._blocked)
        result = self.fetcher.inspect_materials(record, {"replenish_materials": True})
        self.assertEqual(result["status"], "ok")
        self.assertEqual([url for url, _ in self.page.gotos], [record["source_url"]])
        self.assertLess(self.clock.now - self.initial, 10)
        self.assertIsNone(self.fetcher._blocked)


class AdaptiveMaterials(unittest.TestCase):
    def setUp(self):
        self.fixture = material.MaterialsTests("test_delay_waits_actual_completion_and_does_not_close_before_save")
        self.fixture.setUp()

    def tearDown(self):
        self.fixture.tearDown()

    def test_generating_attachment_with_progress_waits_for_actual_download(self):
        test = self.fixture
        began = test.clock.now
        def begin(parent, descriptor):
            parent.snap["download_pending"] = True
            parent.on("file-progress", lambda amount: parent.snap.update(file_progress=[amount]))
            for amount in (40, 80, 120, 160, 200):
                parent.scheduled.append((began + amount, "file-progress", amount))
            parent.scheduled.append((began + 230, "download", material.Download(descriptor)))
        test.parent.on_material = begin
        result = test.fetcher.fetch_material(material.link(), material.RECORD)
        self.assertEqual(result["status"], "file")
        self.assertGreaterEqual(test.clock.now - began, 230)
        self.assertEqual(test.parent.material_clicks, 1)
        self.assertFalse(test.parent.closed)

    def test_unmoving_generation_is_pending_preserves_click_record_and_page(self):
        test = self.fixture
        test.parent.on_material = lambda parent, _: parent.snap.update(download_pending=True)
        result = test.fetcher.fetch_material(material.link(), material.RECORD)
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertEqual(test.fetcher._binding["material_flow"]["step"], "download_clicked")
        self.assertFalse(test.parent.closed)


class AdaptiveCnki(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = chinese.Clock()
        self.context = chinese.Context(self.clock)
        self.fetcher = browser.FulltextBrowserFetcher({}, self.tmp.name, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)

    def tearDown(self):
        self.fetcher.close()
        self.tmp.cleanup()

    def test_official_popup_parent_remains_until_saved_status_then_all_owned_pages_close(self):
        def setup(page):
            def title(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                owner.emit("popup", child)
            page.on_title = title
        self.context.next_setup = setup
        result = cnki.run_cnki(self.fetcher, chinese.RECORD, {})
        self.assertEqual(result["status"], "pdf_page")
        parent, child = self.context.pages[1:]
        self.assertFalse(parent.closed)
        self.assertFalse(child.closed)
        Path(self.tmp.name, "saved.pdf").write_bytes(result["bytes"])
        Path(self.tmp.name, "status.json").write_text('{"status":"fetched_pdf"}')
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(parent.closed)
        self.assertTrue(child.closed)

    def test_cnki_permanent_generation_is_bounded_pending_not_failure(self):
        def setup(page):
            page.on_download = lambda current: current.ui.update(generating=True)
        self.context.next_setup = setup
        result = cnki.run_cnki(self.fetcher, chinese.RECORD, {})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertFalse(self.fetcher._page.closed)
        self.assertEqual(self.fetcher._page.download_clicks, 1)


if __name__ == "__main__":
    unittest.main()
