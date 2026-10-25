"""Manual access queues for material-only snapshots; entirely offline."""
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf
import literature_fulltext_browser as browser
from literature_materials import MaterialsStore
from test_literature_fulltext import read_status, run_stage
from test_literature_fulltext_browser import Clock, Context, snapshot
from test_literature_fulltext_reuse import snapshot as tree_snapshot
from test_literature_materials import descriptor
import test_literature_replenish as replenish_tests


class DeferredFetcher(replenish_tests.ReplenishFetcher):
    def __init__(self, records, blocked=None, **kwargs):
        super().__init__(records, **kwargs)
        self.blocked = blocked or {}
        self.deferred, self.resumed, self.cleared = [], [], []

    def fetch_pdf(self, url, out_path, opts):
        paper_id = opts["record"]["paper_id"]
        if paper_id in self.blocked:
            self.calls.append(("fetch_pdf", url))
            reason, message = self.blocked[paper_id]
            return {"status": "attention", "reason": reason, "message": message}
        return super().fetch_pdf(url, out_path, opts)

    def defer_paper(self, **kwargs):
        self.deferred.append(kwargs)

    def fetch_page(self, url, opts):
        if opts["record"]["paper_id"] in self.blocked:
            self.calls.append(("fetch_page", url))
            reason, message = self.blocked[opts["record"]["paper_id"]]
            return {"status": "attention", "reason": reason, "message": message}
        return super().fetch_page(url, opts)

    def resume_deferred(self, paper_id):
        self.resumed.append(paper_id)

    def clear_deferred(self, paper_id):
        self.cleared.append(paper_id)


class DeferAccessTests(unittest.TestCase):
    def fixture(self, root, **kwargs):
        return replenish_tests.ReplenishmentTests().fixture(root, **kwargs)

    def run_defer(self, job, config, fetcher, **kwargs):
        with patch.object(lf, "_europe_pmc_pdf_urls", side_effect=AssertionError("No external network")), patch.object(lf, "_pmc_xml_item", side_effect=AssertionError("No body re-download")):
            return run_stage(job, config, fetcher=fetcher, resume=True,
                             replenish_materials=True, defer_access=True, **kwargs)

    def test_current_pause_is_queued_without_retry_and_later_papers_complete(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=4, html_count=0)
            status = read_status(job)
            item = status["items"][0]
            item.pop("acquisition_skip")
            item.update(status="needs_attention", pause_reason="access_required", reason="Publisher requires subscription")
            lf._write_status(job, status["items"])
            frozen = {p: (job / p).read_bytes() for p in ("run_config.json", "candidates.json", "candidates.csv", "dedupe/dedupe.json", "dedupe/dedupe.csv")}
            fetcher = DeferredFetcher(records)
            code, events = self.run_defer(job, config, fetcher)
            self.assertEqual((code, events[-1]["type"], events[-1]["reason"]), (0, "attention", "deferred_materials"))
            self.assertEqual(read_status(job)["counts"]["fetched_pdf"], 3)
            self.assertFalse(any(url == records[0]["fulltext_links"][0]["url"] for kind, url in fetcher.calls if kind == "fetch_pdf"))
            self.assertEqual([v["paper_id"] for v in fetcher.deferred], ["PMID-001"])
            self.assertEqual(events[-1]["counts"]["deferred_materials"], 1)
            for name, blob in frozen.items():
                self.assertEqual((job / name).read_bytes(), blob)
            self.assertFalse(any((job / name).exists() for name in ("extraction", "validation", "export")))

    def test_new_access_failure_does_not_block_later_pdf_and_old_three_txt_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=5, html_count=3)
            originals = {p: p.read_bytes() for p in (job / "fulltext/files").glob("*.txt")}
            fetcher = DeferredFetcher(records, {"PMID-004": ("verification", "Complete the captcha")})
            code, events = self.run_defer(job, config, fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(read_status(job)["counts"]["fetched_pdf"], 4)
            self.assertEqual(events[-1]["reason"], "deferred_materials")
            self.assertEqual([item["paper_id"] for item in fetcher.deferred], ["PMID-004"])
            self.assertEqual(fetcher.completed, 4)
            self.assertEqual(len(originals), 3)
            for path, data in originals.items():
                self.assertEqual(path.read_bytes(), data)

    def test_resume_never_retries_manual_queue_until_explicit_retry(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=3, html_count=0)
            first = DeferredFetcher(records, {"PMID-001": ("login", "Please log in")})
            self.run_defer(job, config, first)
            before = tree_snapshot(job)
            second = DeferredFetcher(records)
            _, events = self.run_defer(job, config, second)
            self.assertEqual(second.calls, [])
            self.assertEqual(second.resumed, [])
            self.assertEqual(events[-1]["reason"], "deferred_materials")
            retry = DeferredFetcher(records)
            _, events = self.run_defer(job, config, retry, retry_deferred=True)
            self.assertEqual(retry.resumed, ["PMID-001"])
            self.assertEqual(retry.cleared, ["PMID-001"])
            self.assertEqual([url for kind, url in retry.calls if kind == "fetch_pdf"], [records[0]["fulltext_links"][0]["url"]])
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(json.loads((job / lf.MANUAL_ACTION_FILES[0]).read_text(encoding="utf-8"))["items"], [])
            for name, blob in before.items():
                if name.endswith(("PMID-002.pdf", "PMID-003.pdf")):
                    self.assertEqual((job / name).read_bytes(), blob)

    def test_manual_report_keeps_unknown_supplements_and_all_failures_without_tokens(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, targets, store = self.fixture(root, count=2, html_count=0, checked="unknown")
            store.record_discovery(targets[0], {"status": "unknown", "links": [descriptor("missing.xlsx", label="Additional dataset")]})
            store.flush()
            fetcher = DeferredFetcher(records, {"PMID-001": ("login", "Login at https://publisher.invalid/login?token=secret"),
                                               "PMID-002": ("page_error", "Publisher returned error")})
            _, events = self.run_defer(job, config, fetcher)
            report_text = (job / lf.MANUAL_ACTION_FILES[0]).read_text(encoding="utf-8")
            report = json.loads(report_text)
            self.assertNotIn("secret", report_text)
            self.assertEqual(len(report["items"]), 2)
            for action in report["items"]:
                self.assertEqual(action["status"], "needs_attention")
                self.assertEqual(action["waiting_policy"], "until_explicit_retry")
                self.assertTrue(action["main_pdf_missing"])
                self.assertNotEqual(action["supplements"]["check_status"], "none_declared")
                self.assertTrue(action["official_url"].startswith("https://publisher.invalid/article/"))
            self.assertEqual(report["items"][0]["supplements"]["missing"][0]["label"], "Additional dataset")
            csv_rows = list(csv.DictReader(io.StringIO((job / lf.MANUAL_ACTION_FILES[1]).read_text(encoding="utf-8-sig"))))
            self.assertEqual(len(csv_rows), 2)
            self.assertIn("PMID-002", (job / lf.MANUAL_ACTION_FILES[2]).read_text(encoding="utf-8"))
            self.assertTrue(set(lf.MANUAL_ACTION_FILES).issubset(events[-1]["files"]))

    def test_pdf_saved_but_supplement_auth_is_queued_and_retry_does_not_redownload_pdf(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=2, html_count=0, pdf_count=1, checked="unknown")
            first = DeferredFetcher(records, inspections={"PMID-001": {"status": "attention", "reason": "access_required", "message": "Supplement requires institutional access"}})
            self.run_defer(job, config, first)
            action = json.loads((job / lf.MANUAL_ACTION_FILES[0]).read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(action["paper_id"], "PMID-001")
            self.assertFalse(action["main_pdf_missing"])
            saved = (job / "fulltext/files/PMID-001.pdf").read_bytes()
            second = DeferredFetcher(records)
            self.run_defer(job, config, second, retry_deferred=True)
            self.assertFalse(any(kind == "fetch_pdf" for kind, _ in second.calls))
            self.assertEqual((job / "fulltext/files/PMID-001.pdf").read_bytes(), saved)

    def test_local_corruption_and_identity_failure_still_stop_batch(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=2, html_count=0)
            fetcher = DeferredFetcher(records, {"PMID-001": ("page_error", "原页面身份无法核对，请检查同篇记录")})
            _, events = self.run_defer(job, config, fetcher)
            self.assertEqual(events[-1]["reason"], "page_error")
            self.assertFalse(fetcher.deferred)
            self.assertEqual(len([1 for kind, _ in fetcher.calls if kind in {"fetch_pdf", "fetch_page"}]), 1)
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root, count=2, html_count=1)
            txt = next((job / "fulltext/files").glob("*.txt")); txt.write_text("corrupted", encoding="utf-8")
            fetcher = DeferredFetcher(records)
            _, events = self.run_defer(job, config, fetcher)
            self.assertEqual(events[-1]["reason"], "local_material_verification")
            self.assertEqual(fetcher.calls, [])

    def test_invalid_flags_never_open_browser(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root)
            for flags in ({"defer_access": True}, {"resume": True, "defer_access": True}, {"retry_deferred": True}):
                fetcher = DeferredFetcher(records)
                code, _ = run_stage(job, config, fetcher=fetcher, **flags)
                self.assertEqual(code, 1)
                self.assertEqual(fetcher.calls, [])

    def test_open_deferred_cli_only_foregrounds_named_page_and_emits_id(self):
        with tempfile.TemporaryDirectory() as root:
            job, config, records, _, _ = self.fixture(root)
            fake = DeferredFetcher(records)
            fake.open_current = lambda **kwargs: {"opened": kwargs == {"paper_id": "PMID-001"}}
            fake.close = lambda: None
            events = []
            with patch.object(lf, "make_fetcher", return_value=fake), patch.object(lf, "emit", lambda kind, **values: events.append({"type": kind, **values})):
                code = lf.main(["--config", str(job / "run_config.json"), "--output-dir", str(job), "--open-deferred", "PMID-001"])
            self.assertEqual((code, events[-1]["opened"], events[-1]["paper_id"]), (0, True, "PMID-001"))
            self.assertEqual(fake.calls, [])


class DeferredBrowserTests(unittest.TestCase):
    def fetcher(self, root, context, clock):
        return browser.FulltextBrowserFetcher({}, Path(root) / "job", runtime_factory=context.runtime, clock=clock.time, sleep=clock.sleep)

    def block(self, fetcher, context, paper_id, site):
        context.next_steps = [{"url": "https://" + site + "/login?token=secret", "snapshot": snapshot(login=True)}]
        result = fetcher.fetch_page("https://" + site + "/paper", {})
        self.assertEqual(result["reason"], "login")
        original = context.pages[-1]
        fetcher.defer_paper(reason="login", paper_id=paper_id)
        return original

    def test_multiple_problem_tabs_remain_open_indefinitely_and_exact_page_can_be_shown(self):
        with tempfile.TemporaryDirectory() as root:
            context, clock = Context(), Clock()
            fetcher = self.fetcher(root, context, clock)
            first = self.block(fetcher, context, "PMID-001", "first.test")
            second = self.block(fetcher, context, "PMID-002", "second.test")
            clock.now += 10 * 365 * 24 * 60 * 60
            fetcher.close()
            resumed = self.fetcher(root, context, clock)
            self.assertTrue(resumed.open_current(paper_id="PMID-001")["opened"])
            self.assertEqual((first.fronts, second.fronts), (1, 0))
            self.assertFalse(resumed.open_current(paper_id="PMID-003")["opened"])
            self.assertTrue(resumed.open_current(paper_id="PMID-002")["opened"])
            self.assertEqual((len(first.gotos), len(second.gotos), context.creates), (1, 1, 2))
            self.assertFalse(any(page.closed for page in context.pages))
            text = resumed.binding_path.read_text(encoding="utf-8")
            self.assertNotIn("secret", text)

    def test_same_site_papers_share_login_page_but_explicit_retry_never_reuses_or_closes_it(self):
        with tempfile.TemporaryDirectory() as root:
            context, clock = Context(), Clock()
            fetcher = self.fetcher(root, context, clock)
            first = self.block(fetcher, context, "PMID-001", "shared.test")
            result = fetcher.fetch_page("https://shared.test/another", {})
            self.assertTrue(result["deferred_site"])
            fetcher.defer_paper(reason="login", url=result["url"], paper_id="PMID-002")
            self.assertEqual(context.creates, 1)
            self.assertTrue(fetcher.open_current(paper_id="PMID-002")["opened"])
            restored = fetcher.resume_deferred("PMID-001")
            self.assertEqual(restored, {"restored": False, "shared": True})
            context.next_steps = [{}]
            self.assertEqual(fetcher.fetch_page("https://shared.test/paper", {})["status"], "ok")
            self.assertIsNot(fetcher._page, first)
            fetcher.clear_deferred("PMID-001")
            self.assertTrue(fetcher.complete_paper()["closed"])
            self.assertFalse(first.closed)
            self.assertTrue(fetcher.open_current(paper_id="PMID-002")["opened"])
            self.assertTrue(fetcher.resume_deferred("PMID-002")["shared"])
            self.assertFalse(first.closed)

    def test_retry_rebinds_exact_unshared_original_without_navigation(self):
        with tempfile.TemporaryDirectory() as root:
            context, clock = Context(), Clock()
            fetcher = self.fetcher(root, context, clock)
            original = self.block(fetcher, context, "PMID-001", "first.test")
            fetcher.close()
            retry = self.fetcher(root, context, clock)
            result = retry.resume_deferred("PMID-001")
            self.assertEqual(result, {"restored": True, "shared": False})
            self.assertIs(retry._get_page(), original)
            self.assertEqual((len(original.gotos), context.creates), (1, 1))
            self.assertFalse(original.closed)


if __name__ == "__main__":
    unittest.main()
