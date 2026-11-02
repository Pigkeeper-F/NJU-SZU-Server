"""Isolated fixtures only. No research browser, website or model requests."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace

import literature_metadata as metadata
from literature_screening import load_inputs

ROOT = Path(__file__).resolve().parents[1]
ABSTRACT = "Broilers were randomly allocated to thermoneutral and heat stress groups. Feed intake and weight gain were measured during the experiment."


def row(cid="R1", **extra):
    return {"candidate_id": cid, "source_key": "scopus", "title": "Heat stress and broiler growth",
            "doi": "10.1234/example", "year": 2024, "authors": ["Müller A", "Li B"],
            "result_url": "https://publisher.example/article/123", "snippet": "A search result preview...",
            "evidence_level": "search_result_snippet", **extra}


def snapshot(record=None, **extra):
    record = record or row()
    return {"title": record["title"], "doi": record.get("doi"), "year": str(record.get("year") or ""),
            "authors": record.get("authors"), "abstract": ABSTRACT, "abstract_method": "explicit_abstract_dom",
            "abstract_selector": "#abstract", "abstract_complete": True,
            "keywords": ["heat stress", "growth"], "keyword_method": "explicit_keyword_meta", **extra}


class FixtureFetcher:
    def __init__(self, responses=None, clock=None):
        self.calls = []
        self.responses = list(responses or [])
        self.clock = clock

    def fetch(self, url, timeout_sec):
        self.calls.append((url, timeout_sec))
        if self.clock:
            self.clock[0] += 5
        return self.responses.pop(0) if self.responses else {"status": "ok", "url": url, "snapshot": snapshot()}


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)

    def write(self, records):
        (self.job / "candidates.json").write_text(json.dumps({"records": records}), encoding="utf-8")

    def run_metadata(self, fetcher, **kwargs):
        return metadata.run({}, self.job, fetcher=fetcher, on_event=lambda *args, **kw: None, **kwargs)

    def test_strict_identity_and_original_abstract_provenance(self):
        result = metadata.verify_snapshot(row(), snapshot(), row()["result_url"])
        self.assertEqual(result["status"], "verified")
        evidence = result["evidence"]
        self.assertEqual(evidence["identity_match"], "doi_exact")
        self.assertEqual(evidence["abstract"], ABSTRACT)
        self.assertEqual(evidence["keywords"], ["heat stress", "growth"])
        self.assertEqual(result["evidence_sha256"], metadata.digest(evidence))

    def test_wrong_doi_title_or_insufficient_identity_never_merge(self):
        cases = [snapshot(doi="10.1234/other"), snapshot(title="Different paper"),
                 snapshot(doi="", year="", authors=[])]
        for value in cases:
            self.assertEqual(metadata.verify_snapshot(row(), value, "https://publisher.example/article/123")["status"], "identity_mismatch")
        no_doi = row(doi="")
        self.assertEqual(metadata.verify_snapshot(no_doi, snapshot(no_doi), no_doi["result_url"])["evidence"]["identity_match"], "title_year_authors_exact")

    def test_no_page_description_snippet_fulltext_or_clipped_abstract(self):
        for value in [snapshot(abstract_method="og:description"), snapshot(abstract_method="fulltext_body"),
                      snapshot(abstract_complete=False), snapshot(abstract=ABSTRACT+"..."),
                      snapshot(abstract=ABSTRACT+" Read more")]:
            self.assertEqual(metadata.verify_snapshot(row(), value, row()["result_url"])["status"], "abstract_incomplete")
        self.assertEqual(metadata.verify_snapshot(row(), snapshot(abstract="", snippet=ABSTRACT), row()["result_url"])["status"], "missing")
        self.assertEqual(metadata.existing_abstract(row()), "")
        self.assertEqual(metadata.existing_abstract(row(abstract=ABSTRACT+"...")), "")

    def test_verified_sidecar_is_non_destructive_and_resume_reuses_it(self):
        records = [row()]
        self.write(records)
        before = (self.job / "candidates.json").read_bytes()
        dedupe_dir = self.job / "dedupe"
        dedupe_dir.mkdir()
        dedupe = {"candidate_file_sha256": hashlib.sha256(before).hexdigest(),
                  "groups": [{"canonical_id": "R1", "records": records}]}
        (dedupe_dir / "dedupe.json").write_text(json.dumps(dedupe), encoding="utf-8")
        fetcher = FixtureFetcher()
        self.assertEqual(self.run_metadata(fetcher)["counts"]["verified"], 1)
        self.assertEqual(self.run_metadata(fetcher)["attempted"], 0)
        self.assertEqual(len(fetcher.calls), 1)
        self.assertEqual((self.job / "candidates.json").read_bytes(), before)
        document = load_inputs(self.job)[0]["documents"][0]
        self.assertEqual(document["abstract"], ABSTRACT)
        self.assertIn("metadata_evidence", document)
        self.assertEqual(document["keywords"], ["heat stress", "growth"])

    def test_stale_or_tampered_evidence_fails_closed(self):
        self.write([row()])
        self.run_metadata(FixtureFetcher())
        state = metadata.read_status(self.job)
        entry = state["items"]["R1"]
        self.assertIsNotNone(metadata.validated_evidence(row(), entry))
        self.assertIsNone(metadata.validated_evidence(row(doi="10.1234/different"), entry))
        entry["evidence"]["abstract"] = "Invented content"
        self.assertIsNone(metadata.validated_evidence(row(), entry))

    def test_access_limit_stops_without_fallback_and_needs_explicit_retry(self):
        self.write([row(), row("R2")])
        fetcher = FixtureFetcher([{"status": "attention", "reason": "rate_limited"}])
        first = self.run_metadata(fetcher)
        self.assertFalse(first["complete"])
        self.assertEqual(first["pending_count"], 2)
        self.assertEqual(len(fetcher.calls), 1)  # no DOI fallback, no next paper
        second = self.run_metadata(fetcher)
        self.assertEqual(second["attempted"], 0)
        self.assertEqual(len(fetcher.calls), 1)
        resumed = self.run_metadata(fetcher, retry_attention=True)
        self.assertTrue(resumed["complete"])
        self.assertEqual(resumed["counts"]["verified"], 2)

    def test_total_budget_keeps_unvisited_records_for_resume(self):
        self.write([row(), row("R2")])
        clock = [0]
        fetcher = FixtureFetcher(clock=clock)
        first = self.run_metadata(fetcher, clock=lambda: clock[0], total_budget_sec=4)
        self.assertEqual(first["stop_reason"], "total_budget_exhausted")
        self.assertEqual(first["pending_count"], 1)
        self.assertEqual(len(fetcher.calls), 1)
        second = self.run_metadata(fetcher, clock=lambda: clock[0], total_budget_sec=6)
        self.assertEqual(second["pending_count"], 0)
        self.assertEqual(second["counts"]["verified"], 2)

    def test_existing_full_abstract_never_opens_browser(self):
        self.write([row(abstract=ABSTRACT, evidence_level="imported_abstract")])
        fetcher = FixtureFetcher()
        result = self.run_metadata(fetcher)
        self.assertEqual(result["counts"]["already_have_abstract"], 1)
        self.assertEqual(fetcher.calls, [])

    def test_unavailable_is_not_repeated_until_explicit_retry(self):
        self.write([row(result_url="")])
        fetcher = FixtureFetcher([{"status": "missing", "reason": "explicit_abstract_not_available"}])
        self.run_metadata(fetcher)
        self.assertEqual(self.run_metadata(fetcher)["attempted"], 0)
        result = self.run_metadata(fetcher, retry_unavailable=True)
        self.assertEqual(result["counts"]["verified"], 1)
        self.assertEqual(len(fetcher.calls), 2)

    def test_missing_abstract_or_entry_is_not_exclusion_or_fabricated_text(self):
        self.write([row(doi="", result_url="")])
        fetcher = FixtureFetcher()
        result = self.run_metadata(fetcher)
        self.assertEqual(result["counts"]["unresolved_abstracts"], 1)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(load_inputs(self.job)[0]["documents"][0]["abstract"], "")

    def test_unsafe_download_and_search_entries_not_requested(self):
        for url in ["http://127.0.0.1/x", "http://localhost/x", "file:///tmp/data", "https://publisher.example/a.pdf",
                    "https://scholar.google.com/scholar?q=heat", "https://publisher.example/download/42",
                    "https://user:password@publisher.example/x", "https://publisher.example/login"]:
            self.assertEqual(metadata.article_urls(row(doi="", result_url=url)), [], url)
        self.assertEqual(len(metadata.article_urls(row())), 2)

    def test_native_id_requires_official_url_not_arbitrary_eid_query(self):
        record = row(doi="", authors=[], year="", result_url="https://www.scopus.com/record/display.uri?eid=2-s2.0-123")
        self.assertEqual(metadata.verify_snapshot(record, snapshot(record), record["result_url"])["status"], "verified")
        self.assertEqual(metadata.verify_snapshot(record, snapshot(record), "https://publisher.example/a?eid=2-s2.0-123")["status"], "identity_mismatch")

    def test_python_and_javascript_screening_read_identical_evidence(self):
        records = [row(authors=["Groß A", "Li B"])]
        self.write(records)
        fetcher = FixtureFetcher([{"status": "ok", "url": records[0]["result_url"], "snapshot": snapshot(records[0])}])
        self.run_metadata(fetcher)
        script = "process.stdout.write(JSON.stringify(require('./tools/literature-screening').loadInputs(process.argv[1])))"
        outcome = subprocess.run(["node", "-e", script, str(self.job)], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True)
        self.assertEqual(json.loads(outcome.stdout), load_inputs(self.job))


class BrowserGuardTests(unittest.TestCase):
    def fetcher(self, observed=None, status=200, mime="text/html", download=False):
        class Page:
            url = "https://publisher.example/article/123"
            def __init__(self):
                self.handlers = {}
                self.cancelled = False
                self.goto_calls = []
            def on(self, name, callback): self.handlers[name] = callback
            def remove_listener(self, name, callback): self.handlers.pop(name, None)
            def route(self, pattern, callback): self.route_callback = callback
            def unroute(self, pattern, callback): self.route_callback = None
            def goto(self, url, **kwargs):
                self.goto_calls.append(url)
                if download:
                    self.handlers["download"](SimpleNamespace(cancel=lambda: setattr(self, "cancelled", True)))
                return SimpleNamespace(status=status, headers={"content-type": mime})
            def evaluate(self, script):
                self.script = script
                return {"ready_state": "complete", **(observed or snapshot())}
            def wait_for_timeout(self, ms): pass
        from literature_fulltext_browser import FulltextBrowserFetcher
        page = Page()
        browser = SimpleNamespace(_get_page=lambda: page, _pace=lambda url: None,
                                  _record_destination=lambda url: None, _blocked=None,
                                  _reason=FulltextBrowserFetcher._reason)
        fetcher = metadata.MetadataBrowserFetcher.__new__(metadata.MetadataBrowserFetcher)
        fetcher.browser = browser
        return fetcher, page

    def test_only_metadata_dom_is_read_and_no_fulltext_method_is_used(self):
        fetcher, page = self.fetcher()
        result = fetcher.fetch(page.url)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["snapshot"]["abstract"], ABSTRACT)
        self.assertIn("literature_metadata_snapshot", page.script)
        self.assertEqual(page.goto_calls, [page.url])

    def test_pdf_navigation_is_not_read_or_saved_and_download_is_cancelled(self):
        fetcher, page = self.fetcher(mime="application/pdf", download=True)
        result = fetcher.fetch(page.url)
        self.assertEqual(result["reason"], "pdf_not_metadata_page")
        self.assertTrue(page.cancelled)
        self.assertFalse(hasattr(page, "script"))

    def test_rate_limit_and_login_return_before_metadata(self):
        for value, status, reason in [({}, 429, "rate_limited"), ({"login": True}, 200, "login")]:
            fetcher, page = self.fetcher(observed=value, status=status)
            result = fetcher.fetch(page.url)
            self.assertEqual(result["status"], "attention")
            self.assertEqual(result["reason"], reason)
            again = fetcher.fetch("https://doi.org/10.1234/example")
            self.assertEqual(again, result)
            self.assertEqual(len(page.goto_calls), 1)


class MetadataDOMTests(unittest.TestCase):
    """Real JS on local HTML. Separate headless context; every request blocked."""
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as error:
            raise unittest.SkipTest("Playwright unavailable") from error
        cls.playwright = sync_playwright().start()
        if not Path(cls.playwright.chromium.executable_path).exists():
            cls.playwright.stop()
            raise unittest.SkipTest("Chromium unavailable")
        cls.browser = cls.playwright.chromium.launch(headless=True, timeout=15000, args=["--disable-background-networking"])
        cls.context = cls.browser.new_context()
        cls.context.route("**/*", lambda route: route.abort())
        cls.page = cls.context.new_page()

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def evaluate(self, html):
        self.page.set_content(html)
        return self.page.evaluate(metadata.METADATA_SNAPSHOT_JS)

    def test_explicit_abstract_keywords_and_link_text_are_retained(self):
        result = self.evaluate('<meta name="citation_title" content="Heat stress and broiler growth">'
            '<meta name="citation_doi" content="10.1234/example">'
            '<meta name="citation_publication_date" content="2024-02-01">'
            '<article><div id="abstract"><h2>Abstract</h2><p>Broilers were allocated to '
            '<a href="#term">thermoneutral</a> and heat stress groups. Weight gain was measured.</p></div>'
            '<div class="keywords">Keywords: heat stress; growth</div></article>')
        self.assertTrue(result["abstract_complete"])
        self.assertIn("thermoneutral", result["abstract"])
        self.assertNotIn("Keywords", result["abstract"])
        self.assertEqual(result["keywords"], ["heat stress", "growth"])
        self.assertEqual(result["year"], "2024")

    def test_description_and_body_are_never_used_as_abstract(self):
        result = self.evaluate('<meta name="description" content="'+ABSTRACT+'"><article><h1>A title</h1><p>'+ABSTRACT+'</p></article>')
        self.assertEqual(result["abstract"], "")
        self.assertEqual(result["abstract_method"], "")

    def test_collapsed_or_clamped_abstract_cannot_be_marked_complete(self):
        result = self.evaluate('<article><div id="abstract" style="display:-webkit-box;-webkit-line-clamp:1;overflow:hidden">'+ABSTRACT+'</div></article>')
        self.assertFalse(result["abstract_complete"])
        result = self.evaluate('<article><div id="abstract">'+ABSTRACT+'<button>Read more</button></div></article>')
        self.assertFalse(result["abstract_complete"])

    def test_recommendation_abstract_is_not_used(self):
        result = self.evaluate('<h1>Current article</h1><aside><div class="abstract">'+ABSTRACT+'</div></aside>')
        self.assertEqual(result["abstract"], "")


if __name__ == "__main__":
    unittest.main()
