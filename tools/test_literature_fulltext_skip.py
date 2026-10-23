"""Offline skip-policy regressions; synthetic jobs, no browser/network access."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as lf
from literature_materials import MaterialsError
from test_literature_fulltext import (FakeFetcher, article_page, candidate,
    read_status, run_stage, status_map, write_candidates)


class SkipFetcher(FakeFetcher):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.deferred = []
        self.completed = 0

    def defer_paper(self, *, reason, url):
        self.deferred.append((reason, url))
        return {"status": "deferred"}

    def complete_paper(self):
        self.completed += 1


def manifest(job):
    return json.loads((job / "fulltext/materials.json").read_text(encoding="utf-8"))


class SkipUnavailableTests(unittest.TestCase):
    def test_remote_pauses_skip_first_and_get_second(self):
        for reason in ("login", "verification", "access_required", "rate_limited", "page_error", "load_timeout"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                job = Path(folder)
                first, second = "https://example.org/first", "https://example.org/second.pdf"
                write_candidates(job, [candidate("ONE", result_url=first), candidate("TWO", result_url=second)])
                fetcher = SkipFetcher(page={first: {"status": "attention", "reason": reason, "message": "Synthetic remote gap", "url": first}})
                code, events = run_stage(job, fetcher=fetcher, skip_unavailable=True)
                rows = status_map(read_status(job))
                self.assertEqual(code, 0)
                self.assertEqual(rows["ONE"]["status"], "unavailable")
                self.assertEqual(rows["ONE"]["fulltext_url"], "")
                self.assertEqual(rows["ONE"]["attempted_url"], first)
                self.assertEqual(rows["ONE"]["acquisition_skip"]["reason"], reason)
                self.assertEqual(read_status(job)["counts"]["acquisition_skipped"], 1)
                self.assertGreater(read_status(job)["counts"]["material_incomplete"], 0)
                self.assertIn("本轮已跳过", rows["ONE"]["reason"])
                self.assertEqual(rows["TWO"]["status"], "fetched_pdf")
                self.assertEqual(fetcher.deferred, [(reason, first)])
                self.assertFalse(any(event["type"] == "attention" for event in events))
                self.assertEqual(events[-1]["type"], "result")
                self.assertEqual(events[-1]["counts"]["unavailable"], 1)
                self.assertEqual(events[-1]["counts"]["acquisition_skipped"], 1)
                self.assertGreater(events[-1]["counts"]["material_incomplete"], 0)
                paper = next(row for row in manifest(job)["papers"] if row["paper_id"] == "ONE")
                self.assertEqual(paper["main_pdf_status"], "missing")

                resumed = SkipFetcher()
                code, later = run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
                self.assertEqual(code, 0)
                self.assertEqual(resumed.calls, [], "ordinary resume must not request a skipped paper")
                self.assertEqual(status_map(read_status(job))["ONE"]["acquisition_skip"]["reason"], reason)
                self.assertEqual(later[-1]["counts"]["acquisition_skipped"], 1)

    def test_default_policy_still_pauses(self):
        with tempfile.TemporaryDirectory() as folder:
            job, url = Path(folder), "https://example.org/first"
            write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/second.pdf")])
            fetcher = SkipFetcher(page={url: {"status": "attention", "reason": "access_required", "message": "Synthetic permission required"}})
            code, events = run_stage(job, fetcher=fetcher)
            rows = status_map(read_status(job))
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(rows["ONE"]["status"], "needs_attention")
            self.assertEqual(rows["ONE"]["pause_reason"], "access_required")
            self.assertEqual(rows["ONE"]["fulltext_url"], "")
            self.assertEqual(rows["ONE"]["attempted_url"], url)
            self.assertEqual(rows["TWO"]["status"], "pending")
            self.assertEqual(fetcher.deferred, [])

    def test_saved_html_and_supplement_survive_pdf_gap_and_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            url, pdf = "https://example.org/one", "https://example.org/one.pdf"
            write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/two.pdf")])
            page = article_page("论文 ONE")
            page["html_evidence"]["links"] = [{"url": pdf, "kind": "pdf"}]
            page["material_discovery"] = {"status": "none_declared", "reason": "Synthetic no supplements", "links": []}
            fetcher = SkipFetcher(page={url: page}, pdf={pdf: {"status": "attention", "reason": "access_required", "message": "PDF requires permission"}})
            code, events = run_stage(job, fetcher=fetcher, skip_unavailable=True)
            rows = status_map(read_status(job))
            saved = rows["ONE"]
            self.assertEqual((code, saved["status"], rows["TWO"]["status"]), (0, "fetched_html", "fetched_pdf"))
            original = (job / saved["path"]).read_bytes()
            digest = saved["content_sha256"]
            self.assertEqual(saved["acquisition_skip"]["reason"], "access_required")
            self.assertEqual(events[-1]["counts"]["acquisition_skipped"], 1)
            # A real inspect_materials method would otherwise backfill HTML's
            # missing PDF and supplement gaps on every normal resume.
            resumed = SkipFetcher()
            def inspect_other(record, _opts):
                self.assertNotEqual(record["paper_id"], "ONE", "Skipped material gap was inspected again")
                return {"status": "ok", "material_discovery": {"status": "none_declared", "links": []}}
            resumed.inspect_materials = inspect_other
            run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
            after = status_map(read_status(job))["ONE"]
            self.assertFalse(any(kind in {"fetch_page", "fetch_pdf"} for kind, _ in resumed.calls))
            self.assertEqual(after["content_sha256"], digest)
            self.assertEqual((job / after["path"]).read_bytes(), original)
            self.assertEqual(after["status"], "fetched_html")

    def test_resume_skips_existing_remote_pause_before_any_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            job, url = Path(folder), "https://example.org/one"
            write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/two.pdf")])
            first = SkipFetcher(page={url: {"status": "attention", "reason": "load_timeout", "message": "页面超过1分钟未就绪"}})
            run_stage(job, fetcher=first)
            resumed = SkipFetcher()
            code, events = run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
            rows = status_map(read_status(job))
            self.assertEqual(code, 0)
            self.assertNotIn(("fetch_page", url), resumed.calls)
            self.assertEqual(rows["ONE"]["status"], "unavailable")
            self.assertEqual(rows["TWO"]["status"], "fetched_pdf")
            self.assertEqual(len(resumed.deferred), 1)
            self.assertEqual(events[-1]["type"], "result")

    def test_legacy_failed_link_is_not_carried_to_another_paper_on_resume(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            own = "https://pubmed.ncbi.nlm.nih.gov/33132728/"
            other = "https://pmc.ncbi.nlm.nih.gov/articles/PMC10522860/"
            write_candidates(job, [candidate("PMID-010", result_url=own)])
            first = SkipFetcher(page={own: {"status": "attention", "reason": "load_timeout", "message": "页面超过1分钟未就绪"}})
            run_stage(job, fetcher=first)
            legacy = read_status(job)
            legacy["items"][0]["fulltext_url"] = other
            legacy["items"][0].pop("attempted_url", None)
            lf.atomic_write_json(job / "fulltext/status.json", legacy)

            resumed = SkipFetcher()
            code, _ = run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
            saved = status_map(read_status(job))["PMID-010"]
            self.assertEqual(code, 0)
            self.assertEqual(saved["status"], "unavailable")
            self.assertEqual(saved["fulltext_url"], "")
            self.assertEqual(saved["attempted_url"], own)
            self.assertEqual(resumed.deferred, [("load_timeout", own)])

    def test_only_run_does_not_preserve_a_failed_link_on_untouched_paper(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            own = "https://pubmed.ncbi.nlm.nih.gov/33132728/"
            other = "https://pmc.ncbi.nlm.nih.gov/articles/PMC10522860/"
            write_candidates(job, [candidate("PMID-010", result_url=own),
                                   candidate("PMID-006", result_url="https://example.org/six.pdf")])
            first = SkipFetcher(page={own: {"status": "attention", "reason": "load_timeout", "message": "Timeout"}})
            run_stage(job, fetcher=first)
            legacy = read_status(job)
            legacy["items"][0]["fulltext_url"] = other
            lf.atomic_write_json(job / "fulltext/status.json", legacy)

            code, _ = run_stage(job, fetcher=SkipFetcher(), resume=True, only="PMID-006")
            saved = status_map(read_status(job))["PMID-010"]
            self.assertEqual(code, 0)
            self.assertEqual(saved["status"], "needs_attention")
            self.assertEqual(saved["fulltext_url"], "")

    def test_supplement_timeout_retains_earlier_original_and_main_body(self):
        with tempfile.TemporaryDirectory() as folder:
            job, url = Path(folder), "https://example.org/one"
            write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/two.pdf")])
            first = {"material_id": "S1", "role": "supplement", "label": "Supplementary Table S1", "filename": "S1.csv", "url": "https://example.org/S1.csv"}
            second = {"material_id": "S2", "role": "supplement", "label": "Supplementary Table S2", "filename": "S2.csv", "url": "https://example.org/S2.csv"}
            page = article_page("论文 ONE")
            page["material_discovery"] = {"status": "checked", "links": [first, second]}
            fetcher = SkipFetcher(page={url: page})
            results = [{"status": "file", "bytes": b"temperature,value\n35,10\n"},
                       {"status": "attention", "reason": "load_timeout", "message": "Synthetic supplement timeout"}]
            fetcher.fetch_material = lambda *_args: results.pop(0)
            code, events = run_stage(job, fetcher=fetcher, skip_unavailable=True)
            paper = next(row for row in manifest(job)["papers"] if row["paper_id"] == "ONE")
            saved = next(material for material in paper["materials"] if material["material_id"] == "S1")
            missing = next(material for material in paper["materials"] if material["material_id"] == "S2")
            self.assertEqual(code, 0)
            self.assertEqual(saved["download_status"], "downloaded")
            self.assertEqual((job / saved["path"]).read_bytes(), b"temperature,value\n35,10\n")
            self.assertEqual(missing["download_status"], "missing")
            self.assertEqual(status_map(read_status(job))["ONE"]["status"], "fetched_html")
            self.assertEqual(status_map(read_status(job))["TWO"]["status"], "fetched_pdf")
            self.assertEqual(events[-1]["counts"]["acquisition_skipped"], 1)
            resumed = SkipFetcher()
            run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
            self.assertEqual(resumed.calls, [])
            self.assertEqual((job / saved["path"]).read_bytes(), b"temperature,value\n35,10\n")

    def test_legacy_saved_body_permission_pause_is_skipped_without_reopening(self):
        with tempfile.TemporaryDirectory() as folder:
            job, url, pdf = Path(folder), "https://example.org/one", "https://example.org/one.pdf"
            write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/two.pdf")])
            page = article_page("论文 ONE")
            page["html_evidence"]["links"] = [{"url": pdf, "kind": "pdf"}]
            first = SkipFetcher(page={url: page}, pdf={pdf: {"status": "attention", "reason": "access_required", "message": "全文页面需要机构或订阅权限，已暂停；请核对后继续。"}})
            run_stage(job, fetcher=first)
            status = read_status(job)
            status["items"][0].pop("pause_reason", None)  # pre-policy status format
            lf.atomic_write_json(job / "fulltext/status.json", status)
            original = (job / status["items"][0]["path"]).read_bytes()
            resumed = SkipFetcher()
            def inspect_other(record, _opts):
                self.assertNotEqual(record["paper_id"], "ONE", "Legacy remote pause repeated")
                return {"status": "ok", "material_discovery": {"status": "none_declared", "links": []}}
            resumed.inspect_materials = inspect_other
            code, events = run_stage(job, fetcher=resumed, resume=True, skip_unavailable=True)
            saved = status_map(read_status(job))["ONE"]
            self.assertEqual(code, 0)
            self.assertEqual(saved["status"], "fetched_html")
            self.assertEqual((job / saved["path"]).read_bytes(), original)
            self.assertEqual(saved["acquisition_skip"]["reason"], "access_required")
            self.assertEqual(events[-1]["counts"]["fetched"], 2)

    def test_explicit_single_retry_can_finish_a_skipped_gap(self):
        with tempfile.TemporaryDirectory() as folder:
            job, url = Path(folder), "https://example.org/one.pdf"
            write_candidates(job, [candidate("ONE", result_url=url)])
            first = SkipFetcher(pdf={url: {"status": "attention", "reason": "load_timeout", "message": "Synthetic timeout"}})
            run_stage(job, fetcher=first, skip_unavailable=True)
            # A broad retry switch does not silently undo the user's skip.
            broad = SkipFetcher()
            run_stage(job, fetcher=broad, resume=True, retry_unavailable=True)
            self.assertEqual(broad.calls, [])
            retry = SkipFetcher()
            code, events = run_stage(job, fetcher=retry, resume=True, only="ONE", retry_unavailable=True, limit=1)
            saved = status_map(read_status(job))["ONE"]
            self.assertEqual((code, saved["status"]), (0, "fetched_pdf"))
            self.assertNotIn("acquisition_skip", saved)
            self.assertEqual(events[-1]["counts"]["acquisition_skipped"], 0)

    def test_local_fulltext_and_material_failures_still_pause(self):
        for reason in ("local_fulltext_verification", "local_material_verification", "material_cleanup"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                job, url = Path(folder), "https://example.org/one"
                write_candidates(job, [candidate("ONE", result_url=url), candidate("TWO", result_url="https://example.org/two.pdf")])
                fetcher = SkipFetcher(page={url: {"status": "attention", "reason": reason, "message": "Synthetic local safety failure"}})
                code, events = run_stage(job, fetcher=fetcher, skip_unavailable=True)
                rows = status_map(read_status(job))
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertEqual(events[-1]["reason"], reason)
                self.assertEqual(rows["TWO"]["status"], "pending")
                self.assertNotIn("acquisition_skip", rows["ONE"])
                self.assertEqual(fetcher.deferred, [])

    def test_materials_error_never_emits_success_or_moves_to_next_paper(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder)
            write_candidates(job, [candidate("ONE", result_url="https://example.org/one.pdf"), candidate("TWO", result_url="https://example.org/two.pdf")])
            fetcher = SkipFetcher()
            with patch.object(lf.MaterialsStore, "read_materials", side_effect=MaterialsError("Synthetic SHA conflict")):
                code, events = run_stage(job, fetcher=fetcher, skip_unavailable=True)
            rows = status_map(read_status(job))
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(events[-1]["reason"], "local_material_verification")
            self.assertEqual(rows["ONE"]["status"], "fetched_pdf", "durable main body survives")
            self.assertEqual(rows["TWO"]["status"], "pending")
            self.assertEqual(fetcher.deferred, [])


if __name__ == "__main__":
    unittest.main()
