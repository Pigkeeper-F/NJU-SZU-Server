"""Supplementary-file fixtures: local fake events and network-blocked DOM."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import literature_fulltext_browser as mod
import literature_cnki_fulltext as cnki
import test_literature_cnki_fulltext as fixture
import test_literature_fulltext_browser as generic


TITLE = "Heat stress in broilers"
RECORD = {"paper_id": "P-1", "source_key": "publisher", "title": TITLE, "doi": "10.1/test",
          "source_url": "https://publisher.test/article/1"}


def link(extension="xlsx", **changes):
    value = {"url": f"https://publisher.test/files/supplement.{extension}",
             "label": "Supporting information", "filename": f"supplement.{extension}", "mime_type": ""}
    value.update(changes)
    return value


def article(*links, **changes):
    value = generic.snapshot(materials={"links": list(links), "complete": True,
                                       "region_found": bool(links), "none_declared": False})
    value.update(changes)
    return value


class Download:
    def __init__(self, descriptor, blob=b"PK\x03\x04original-file", failure=None):
        self.url, self.suggested_filename = descriptor["url"], descriptor["filename"]
        self.blob, self.error, self.saved = blob, failure, 0

    def save_as(self, filename):
        self.saved += 1
        Path(filename).write_bytes(self.blob)

    def failure(self):
        return self.error


class Anchor:
    def __init__(self, page, descriptor):
        self.page, self.descriptor = page, descriptor

    def evaluate(self, script):
        return {"url": self.descriptor["url"], "label": self.descriptor["label"]}

    def is_visible(self):
        return True

    def dispose(self):
        pass

    def click(self, **options):
        assert options["modifiers"] == ["Control"]
        self.page.material_clicks += 1
        self.page.on_material(self.page, self.descriptor)


class MaterialsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock = fixture.Clock()
        self.context = fixture.Context(self.clock)
        self.progress = []
        self.fetcher = self.new_fetcher()
        self.fetcher.ensure_ready()
        self.parent = self.fetcher._page
        self.parent.url = RECORD["source_url"]
        self.parent.snap = article(link())
        self.parent.material_clicks = 0
        self.parent.on_material = self.download
        original = self.parent.query_selector_all
        self.parent.query_selector_all = lambda selector: [Anchor(self.parent, item) for item in self.parent.snap["materials"]["links"]] if selector == "a[href]" else original(selector)

    def tearDown(self):
        self.temp.cleanup()

    def new_fetcher(self):
        return mod.FulltextBrowserFetcher({}, Path(self.temp.name), runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep, on_progress=self.progress.append)

    def download(self, parent, descriptor):
        parent.scheduled.append((self.clock.now + 2, "download", Download(descriptor)))

    def test_all_original_formats_are_completed_without_pdf_conversion(self):
        for extension, content in [("xlsx", b"PK\x03\x04sheet"), ("docx", b"PK\x03\x04word"),
                                   ("zip", b"PK\x03\x04archive"), ("pdf", b"%PDF-1.7\nsmall supplementary PDF")]:
            with self.subTest(extension=extension):
                descriptor = link(extension)
                self.parent.snap = article(descriptor)
                download = Download(descriptor, content)
                self.parent.on_material = lambda parent, item: parent.scheduled.append((self.clock.now + 2, "download", download))
                result = self.fetcher.fetch_material(descriptor, RECORD)
                self.assertEqual(result["status"], "file")
                self.assertEqual(result["bytes"], content)
                self.assertEqual(result["suggested_filename"], f"supplement.{extension}")
                self.assertEqual(download.saved, 1)
                self.assertFalse(self.parent.closed)
                self.assertEqual(self.fetcher.complete_material(), {"closed": True})
        self.assertEqual(self.parent.material_clicks, 4)
        self.assertFalse(self.parent.gotos)

    def test_empty_material_region_is_unknown_explicit_declaration_is_none(self):
        self.parent.snap = article()
        self.assertEqual(self.fetcher.capture_material_discovery(RECORD)["status"], "unknown")
        self.parent.snap["materials"]["region_found"] = True
        self.assertEqual(self.fetcher.capture_material_discovery(RECORD)["status"], "unknown")
        self.parent.snap["materials"]["none_declared"] = True
        self.assertEqual(self.fetcher.capture_material_discovery(RECORD)["status"], "none_declared")

    def test_wrong_paper_or_conflicting_doi_never_clicks(self):
        self.parent.snap["citation_doi"] = "10.1/different"
        self.assertEqual(self.fetcher.capture_material_discovery(RECORD)["status"], "unknown")
        result = self.fetcher.fetch_material(link(), RECORD)
        self.assertEqual(result["status"], "attention")
        self.assertEqual(self.parent.material_clicks, 0)

    def test_missing_bound_page_never_borrows_existing_matching_article(self):
        self.parent.closed = True
        researcher = self.context.pages[0]
        researcher.snap, researcher.url = article(link()), RECORD["source_url"]
        self.assertEqual(self.fetcher.capture_material_discovery(RECORD)["reason"], "original_article_page_unavailable")
        self.assertEqual(self.fetcher.fetch_material(link(), RECORD)["status"], "fetch_error")
        self.assertFalse(researcher.gotos)

    def test_delay_waits_actual_completion_and_does_not_close_before_save(self):
        self.parent.on_material = lambda parent, descriptor: parent.scheduled.append((self.clock.now + 35, "download", Download(descriptor)))
        result = self.fetcher.fetch_material(link(), RECORD)
        self.assertEqual(result["status"], "file")
        self.assertGreaterEqual(self.clock.now, 1035)
        self.assertEqual(self.parent.material_clicks, 1)
        self.assertFalse(self.parent.closed)

    def test_verification_pause_resume_never_reclicks(self):
        def open_verification(parent, descriptor):
            parent.snap["verification"] = True
        self.parent.on_material = open_verification
        first = self.fetcher.fetch_material(link(), RECORD)
        self.assertEqual(first["reason"], "verification")
        self.parent.snap["verification"] = False
        self.parent.scheduled.append((self.clock.now + 2, "download", Download(link())))
        resumed = self.new_fetcher()
        result = resumed.fetch_material(link(), RECORD)
        self.assertEqual(result["status"], "file")
        self.assertEqual(self.parent.material_clicks, 1)
        self.assertFalse(self.parent.gotos)

    def test_owned_popup_cleanup_only_after_file_and_status_save(self):
        def popup(parent, descriptor):
            child = self.context.new_page(opener=parent)
            child.url, child.snap = descriptor["url"], article()
            parent.emit("popup", child)
            child.scheduled.append((self.clock.now + 2, "download", Download(descriptor)))
        self.parent.on_material = popup
        result = self.fetcher.fetch_material(link(), RECORD)
        child = self.context.pages[-1]
        self.assertEqual(result["status"], "file")
        self.assertFalse(child.closed)
        self.assertFalse(self.parent.closed)
        self.assertEqual(self.fetcher.complete_paper(), {"closed": False})
        self.assertTrue(self.fetcher.open_current()["opened"])
        self.assertEqual(child.fronts, 1)
        self.assertEqual(self.parent.fronts, 0)
        self.assertEqual(self.fetcher.complete_material(), {"closed": True})
        self.assertTrue(child.closed)
        self.assertFalse(self.parent.closed)
        self.assertFalse(self.context.pages[0].closed)

    def test_wrong_opener_not_adopted_or_read_as_artifact(self):
        def popup(parent, descriptor):
            child = self.context.new_page(opener=self.context.pages[0])
            child.url = descriptor["url"]
            parent.emit("popup", child)
            child.scheduled.append((self.clock.now + 1, "download", Download(descriptor)))
        self.parent.on_material = popup
        result = self.fetcher.fetch_material(link(), RECORD)
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("child_target_id", self.fetcher._binding["material_flow"])
        self.assertFalse(self.context.pages[-1].closed)

    def test_cnki_transfer_entry_is_not_replayed_or_clicked(self):
        descriptor = link(url="https://kns.cnki.net/bar/order?v=secret")
        self.parent.snap = article(descriptor)
        result = self.fetcher.fetch_material(descriptor, RECORD)
        self.assertEqual(result["status"], "fetch_error")
        self.assertEqual(self.parent.material_clicks, 0)
        self.assertNotIn("secret", self.fetcher.binding_path.read_text(encoding="utf-8"))

    def test_unfinished_or_error_file_is_not_accepted(self):
        for blob, error in [(b"", None), (b"<!doctype html><html>Login</html>", None), (b"bytes", "cancelled")]:
            with self.subTest(blob=blob):
                self.fetcher._blocked = None
                self.fetcher._binding.pop("material_flow", None)
                self.parent.on_material = lambda parent, descriptor: parent.emit("download", Download(descriptor, blob, error))
                self.assertEqual(self.fetcher.fetch_material(link(), RECORD)["status"], "attention")

    def test_material_payload_host_not_in_visible_link_is_rejected(self):
        def download(parent, descriptor):
            event = Download(descriptor)
            event.url = "https://unrelated.test/file.zip"
            parent.emit("download", event)
        self.parent.on_material = download
        self.assertEqual(self.fetcher.fetch_material(link(), RECORD)["status"], "attention")

    def test_binding_never_persists_descriptor_raw_token(self):
        descriptor = link(url="https://publisher.test/files/supp.xlsx?ticket=private-token")
        self.parent.snap = article(descriptor)
        self.assertEqual(self.fetcher.fetch_material(descriptor, RECORD)["status"], "file")
        self.assertNotIn("private-token", self.fetcher.binding_path.read_text(encoding="utf-8"))

    def test_bound_blob_download_is_actual_file_not_a_navigated_url(self):
        def download(parent, descriptor):
            event = Download(descriptor)
            event.url = "blob:https://publisher.test/private-id"
            parent.emit("download", event)
        self.parent.on_material = download
        self.assertEqual(self.fetcher.fetch_material(link(), RECORD)["status"], "file")
        self.assertFalse(self.parent.gotos)

    def test_second_material_cannot_start_before_previous_status_cleanup(self):
        self.assertEqual(self.fetcher.fetch_material(link(), RECORD)["status"], "file")
        second = link("zip")
        self.parent.snap = article(second)
        result = self.fetcher.fetch_material(second, RECORD)
        self.assertEqual(result["status"], "attention")
        self.assertEqual(self.parent.material_clicks, 1)

    def test_read_only_received_proof_matches_saved_original_after_restart(self):
        descriptor = link(material_id="M-supplement-1")
        self.parent.snap = article(descriptor)
        result = self.fetcher.fetch_material(descriptor, RECORD)
        resumed = self.new_fetcher()
        before = resumed.binding_path.read_bytes()
        proof = resumed.pending_material_state(RECORD)
        self.assertEqual(proof["status"], "file_received")
        self.assertEqual(proof["material_id"], "M-supplement-1")
        self.assertEqual(proof["sha256"], hashlib.sha256(result["bytes"]).hexdigest())
        self.assertEqual(proof["size"], len(result["bytes"]))
        self.assertIsNone(resumed.pending_material_state(dict(RECORD, paper_id="other")))
        self.assertEqual(resumed.binding_path.read_bytes(), before)
        restored = resumed.fetch_material(descriptor, RECORD)
        self.assertEqual(restored["bytes"], result["bytes"])
        self.assertEqual(restored["suggested_filename"], result["suggested_filename"])
        self.assertEqual(self.parent.material_clicks, 1)
        staged = resumed._material_stage_path(resumed._binding["material_flow"])
        self.assertTrue(staged.is_file())
        self.assertEqual(resumed.complete_material(), {"closed": True})
        self.assertFalse(staged.exists())

    def test_corrupt_received_stage_never_redownloads_or_claims_success(self):
        descriptor = link()
        self.fetcher.fetch_material(descriptor, RECORD)
        staged = self.fetcher._material_stage_path(self.fetcher._binding["material_flow"])
        staged.write_bytes(b"corrupt")
        resumed = self.new_fetcher()
        result = resumed.fetch_material(descriptor, RECORD)
        self.assertEqual(result["status"], "attention")
        self.assertEqual(self.parent.material_clicks, 1)

    def test_verified_stage_remains_deliverable_after_article_page_closed(self):
        result = self.fetcher.fetch_material(link(), RECORD)
        self.parent.closed = True
        resumed = self.new_fetcher()
        restored = resumed.fetch_material(link(), RECORD)
        self.assertEqual(restored["status"], "file")
        self.assertEqual(restored["bytes"], result["bytes"])
        self.assertEqual(self.parent.material_clicks, 1)

    def test_initial_child_file_response_before_popup_event_is_captured_once(self):
        descriptor = link("pdf")
        self.parent.snap = article(descriptor)
        payload = b"%PDF-1.7\nreal supplement"
        def popup(parent, item):
            child = self.context.new_page(opener=parent)
            child.url, child.snap = item["url"], article()
            child.main_frame = type("Frame", (), {"page": child})()
            request = type("Request", (), {"frame": child.main_frame, "is_navigation_request": lambda _: True})()
            response = type("Response", (), {"request": request, "url": child.url,
                "headers": {"content-type": "application/pdf"}, "body": lambda _: payload})()
            self.context.emit("response", response)
            parent.emit("popup", child)
            child.emit("response", response)
        self.parent.on_material = popup
        result = self.fetcher.fetch_material(descriptor, RECORD)
        self.assertEqual(result["status"], "file")
        self.assertEqual(result["bytes"], payload)
        self.assertEqual(self.parent.material_clicks, 1)
        self.assertEqual(self.fetcher._binding["material_flow"]["child_target_id"], self.context.pages[-1].target)

    def test_context_response_from_unrelated_page_is_never_adopted(self):
        def unrelated(parent, descriptor):
            page = self.context.pages[0]
            page.main_frame = type("Frame", (), {"page": page})()
            request = type("Request", (), {"frame": page.main_frame, "is_navigation_request": lambda _: True})()
            response = type("Response", (), {"request": request, "url": descriptor["url"],
                "headers": {"content-type": "application/pdf"}, "body": lambda _: b"%PDF-private"})()
            self.context.emit("response", response)
            parent.snap["verification"] = True
        self.parent.on_material = unrelated
        result = self.fetcher.fetch_material(link(), RECORD)
        self.assertEqual(result["reason"], "verification")
        self.assertNotIn("child_target_id", self.fetcher._binding["material_flow"])

    def test_inline_original_text_response_uses_real_attachment_filename(self):
        descriptor = link("txt")
        self.parent.snap = article(descriptor)
        self.parent.main_frame = type("Frame", (), {"page": self.parent})()
        payload = b"original supplementary measurements\n1,2,3\n"
        def response(parent, item):
            request = type("Request", (), {"frame": parent.main_frame, "is_navigation_request": lambda _: True})()
            event = type("Response", (), {"request": request, "url": item["url"], "status": 200,
                "headers": {"content-type": "text/plain", "content-disposition": 'inline; filename="measurements.txt"'},
                "body": lambda _: payload})()
            parent.emit("response", event)
        self.parent.on_material = response
        result = self.fetcher.fetch_material(descriptor, RECORD)
        self.assertEqual(result["status"], "file")
        self.assertEqual(result["bytes"], payload)
        self.assertEqual(result["suggested_filename"], "measurements.txt")


class IntegrationTests(unittest.TestCase):
    def test_generic_discovery_callback_runs_before_pdf_navigation_and_carries_links(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = generic.Clock()
            context = generic.Context([{ "snapshot": article(link(), links=[{"url": "https://publisher.test/main.pdf", "text": "PDF"}])},
                                       {"response": generic.Response(headers={"content-type": "application/pdf"}, body=generic.PDF)}])
            fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)
            observed = []
            result = fetcher.fetch_pdf(RECORD["source_url"], Path(directory) / "main.pdf", {"record": RECORD,
                "on_material_discovery": lambda discovery: observed.append((discovery, len(context.pages[-1].gotos)))})
            self.assertEqual(result["status"], "saved")
            self.assertEqual(observed[0][1], 1)
            self.assertEqual(result["material_discovery"]["links"][0]["filename"], "supplement.xlsx")

    def test_callback_attention_or_exception_stops_before_main_pdf(self):
        for callback in [lambda _: {"status": "attention", "reason": "verification", "message": "manual"},
                         lambda _: (_ for _ in ()).throw(RuntimeError("secret"))]:
            with tempfile.TemporaryDirectory() as directory:
                context = generic.Context([{ "snapshot": article(link(), links=[{"url": "https://publisher.test/main.pdf", "text": "PDF"}])}])
                fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime)
                result = fetcher.fetch_pdf(RECORD["source_url"], Path(directory) / "main.pdf", {"record": RECORD, "on_material_discovery": callback})
                self.assertEqual(result["status"], "attention")
                self.assertEqual(len(context.pages[-1].gotos), 1)
                self.assertNotIn("secret", str(result))

    def test_cnki_materials_only_normal_lookup_never_clicks_main_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = fixture.Clock()
            context = fixture.Context(clock)
            fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)
            context.next_setup = lambda page: setattr(page, "on_title", lambda p: (p.detail(p), p.snap.update(materials={"links": [link(url="https://kns.cnki.net/files/appendix.xlsx")], "complete": True, "region_found": True})))
            result = fetcher.inspect_materials(fixture.RECORD, {})
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["material_discovery"]["status"], "checked")
            self.assertEqual(fetcher._page.title_clicks, 1)
            self.assertEqual(fetcher._page.download_clicks, 0)

    def test_cnki_pdf_result_carries_preclick_material_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = fixture.Clock()
            context = fixture.Context(clock)
            fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)
            context.next_setup = lambda page: setattr(page, "on_title", lambda p: (p.detail(p), p.snap.update(materials={"links": [link(url="https://kns.cnki.net/files/supp.zip")], "complete": True, "region_found": True})))
            calls = []
            result = fetcher.fetch_cnki(fixture.RECORD, {"on_material_discovery": lambda discovery: calls.append(fetcher._page.download_clicks)})
            self.assertEqual(result["status"], "pdf_page")
            self.assertEqual(result["material_discovery"]["status"], "checked")
            self.assertEqual(calls, [0])

    def test_cnki_supplement_callback_events_do_not_enter_main_pdf_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = fixture.Clock()
            context = fixture.Context(clock)
            fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)
            descriptor = link("zip", url="https://kns.cnki.net/files/supp.zip")
            def setup(page):
                def detail(parent):
                    parent.detail(parent)
                    parent.snap["materials"] = {"links": [descriptor], "complete": True, "region_found": True}
                    parent.material_clicks = 0
                    parent.on_material = lambda p, item: p.emit("download", Download(item))
                    original = parent.query_selector_all
                    parent.query_selector_all = lambda selector: [Anchor(parent, descriptor)] if selector == "a[href]" else original(selector)
                page.on_title = detail
            context.next_setup = setup
            def collect(discovery):
                result = fetcher.fetch_material(discovery["links"][0], fixture.RECORD)
                self.assertEqual(result["status"], "file")
                self.assertEqual(fetcher.complete_material(), {"closed": True})
            result = fetcher.fetch_cnki(fixture.RECORD, {"on_material_discovery": collect})
            self.assertEqual(result["status"], "pdf_page")
            self.assertEqual(fetcher._page.material_clicks, 1)
            self.assertEqual(fetcher._page.download_clicks, 1)

    def test_inspection_direct_pdf_remains_unknown_without_saving_again(self):
        with tempfile.TemporaryDirectory() as directory:
            context = generic.Context([{"response": generic.Response(headers={"content-type": "application/pdf"}, body=generic.PDF)}])
            fetcher = mod.FulltextBrowserFetcher({}, directory, runtime_factory=context.runtime)
            result = fetcher.inspect_materials(RECORD)
            self.assertEqual(result["status"], "ok")
            self.assertEqual(result["material_discovery"]["reason"], "only_main_pdf_page_available")
            self.assertNotIn("bytes", result)
            self.assertFalse((Path(directory) / "fulltext").exists())


class LocalDOMTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        if not Path(cls.playwright.chromium.executable_path).exists():
            cls.playwright.stop()
            raise unittest.SkipTest("Local Chromium unavailable")
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--disable-background-networking"])
        cls.context = cls.browser.new_context()
        cls.context.route("**/*", lambda route: route.abort())
        cls.page = cls.context.new_page()

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def test_main_pdf_and_supplement_pdf_are_separate_actual_dom(self):
        self.page.set_content('<meta name="citation_title" content="Heat stress in broilers"><h1>Heat stress in broilers</h1>'
            '<a href="https://publisher.test/main.pdf">PDF</a><section><h2>Supporting information</h2>'
            '<a href="https://publisher.test/supp.pdf">PDF</a><a download="data.xlsx" href="https://publisher.test/data.xlsx">Table S1</a></section>')
        snap = self.page.evaluate(mod._SNAPSHOT_JS)
        self.assertEqual([item["url"] for item in snap["links"]], ["https://publisher.test/main.pdf"])
        self.assertEqual(len(snap["materials"]["links"]), 2)
        ui = self.page.evaluate(cnki._CNKI_UI_JS)
        control, _, ambiguous = cnki._download_control(ui)
        self.assertFalse(ambiguous)
        self.assertEqual(control["text"], "PDF")
        element, _ = cnki._download_element(self.page)
        self.assertEqual(element.get_attribute("href"), "https://publisher.test/main.pdf")
        element.dispose()

    def test_hidden_links_and_unrelated_navigation_not_enumerated(self):
        self.page.set_content('<nav><a href="https://publisher.test/help">Help</a></nav><section id="supplementary-material">'
            '<h2>Supplementary material</h2><a href="https://publisher.test/a.zip">Archive</a>'
            '<a style="display:none" href="https://publisher.test/hidden.zip">Hidden</a></section>')
        result = self.page.evaluate(mod._MATERIALS_JS)
        self.assertEqual([item["url"] for item in result["links"]], ["https://publisher.test/a.zip"])

    def test_no_section_is_not_no_supplementary_declaration(self):
        self.page.set_content('<main><h1>Paper</h1><p>Normal article.</p></main>')
        result = self.page.evaluate(mod._MATERIALS_JS)
        self.assertFalse(result["none_declared"])
        self.assertFalse(result["region_found"])
        self.page.set_content('<article><p>No supplementary material is provided.</p></article>')
        self.assertTrue(self.page.evaluate(mod._MATERIALS_JS)["none_declared"])

    def test_unlabelled_supplement_pdf_is_not_used_as_main_pdf(self):
        self.page.set_content('<a href="https://publisher.test/supplement.pdf">PDF</a>')
        snapshot = self.page.evaluate(mod._SNAPSHOT_JS)
        self.assertEqual(snapshot["links"], [])
        self.assertEqual(snapshot["materials"]["links"], [])


if __name__ == "__main__":
    unittest.main()
