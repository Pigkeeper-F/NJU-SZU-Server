"""Integrated full-text safeguards using temporary files and offline fixtures."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_extract as extract
import literature_fulltext as fulltext
from literature_fulltext_browser import FulltextBrowserFetcher
from literature_fulltext_evidence import verified_saved_html
from test_literature_extract import write_job
from test_literature_fulltext import (
    FakeFetcher, article_page, candidate, read_status, run_stage, status_map, write_candidates,
)
from test_literature_fulltext_browser import Clock, Context, Response, snapshot


class ReviewSafetyTests(unittest.TestCase):
    def test_review_old_abstract_labels_does_not_count_empty_or_navigation(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            folder = job / "fulltext/files"
            folder.mkdir(parents=True)
            texts = ["\n", "Scopus Logo\nView PDF\nFull text\n", "Abstract\nA controlled experiment measured the effects of heat stress on broiler growth performance and feed intake.\nKeywords\npoultry"]
            items = []
            for index, text in enumerate(texts):
                name = f"item-{index}.txt"
                (folder / name).write_text(text, encoding="utf-8")
                items.append({"paper_id": str(index), "status": "abstract_only", "kind": "html",
                              "path": f"fulltext/files/{name}", "source_url": "https://www.scopus.com/pages/publications/105001"})
            original = json.dumps({"items": items}).encode("utf-8")
            (job / "fulltext/status.json").write_bytes(original)
            with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("must stay offline")):
                report = fulltext.review_saved_fulltext(job, emit_result=False)
            self.assertEqual(report["counts"]["abstract_only"], 1)
            self.assertEqual(report["counts"]["unavailable"], 2)
            self.assertEqual(report["counts"]["fetched"], 0)
            self.assertEqual((job / report["backup"]).read_bytes(), original)
            for index, text in enumerate(texts):
                self.assertEqual((folder / f"item-{index}.txt").read_text(encoding="utf-8"), text)

    def test_cnki_missing_entry_is_explained_offline_without_requeue(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            (job / "fulltext").mkdir()
            original = {"version": 1, "items": [{"paper_id":"CNKI-001", "status":"unavailable", "path":"",
                "source_url":"https://kns.cnki.net/kcms2/article/abstract", "reason":"old failure"}]}
            (job / "fulltext/status.json").write_text(json.dumps(original), encoding="utf-8")
            with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("no browser")):
                report = fulltext.review_saved_fulltext(job, emit_result=False)
            item = read_status(job)["items"][0]
            self.assertEqual(item["status"], "unavailable")
            self.assertTrue(item["entry_required"])
            self.assertIn("中转链接", item["reason"])
            self.assertEqual(report["counts"]["changed"], 1)
            self.assertEqual(report["counts"]["pending"], 0)

    def legacy_job(self, root: Path):
        job = root / "old-cache"
        folder = job / "fulltext" / "files"
        folder.mkdir(parents=True)
        items, file_bytes = [], {}
        for number in range(1, 31):
            paper_id = f"PMID-{number:03d}"
            blob = ("Abstract\n" + "A long PubMed abstract with citations and navigation. " * 80 + "\nReferences\n").encode("utf-8")
            relative = f"fulltext/files/{paper_id}.txt"
            (job / relative).write_bytes(blob)
            file_bytes[relative] = blob
            items.append({"paper_id": paper_id, "status": "fetched_html", "kind": "html",
                          "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{10000000 + number}/",
                          "path": relative, "evidence_level": "fulltext_html", "reason": ""})
        pending = {"paper_id": "CNKI-001", "status": "pending", "path": "", "reason": "not attempted"}
        items.append(pending)
        status_path = job / "fulltext" / "status.json"
        original = (json.dumps({"version": 1, "items": items}, indent=3) + "\n").encode("utf-8")
        status_path.write_bytes(original)
        return job, original, file_bytes, pending

    def test_thirty_old_pubmed_caches_review_offline_keep_exact_files_and_backup(self):
        with tempfile.TemporaryDirectory() as temp:
            job, original, files, pending = self.legacy_job(Path(temp))
            # Any accidental browser construction/network work is a test failure.
            with patch.object(fulltext, "make_fetcher", side_effect=AssertionError("review must stay offline")), \
                 patch.object(FulltextBrowserFetcher, "ensure_ready", side_effect=AssertionError("no browser access")):
                report = fulltext.review_saved_fulltext(job, emit_result=False)
            self.assertTrue(report["offline_only"])
            self.assertEqual(report["counts"]["reviewed"], 30)
            self.assertEqual(report["counts"]["changed"], 30)
            self.assertEqual(report["counts"]["abstract_only"], 30)
            self.assertEqual(report["counts"]["pending"], 1)
            self.assertEqual(report["counts"]["fetched"], 0)
            self.assertEqual((job / report["backup"]).read_bytes(), original)
            self.assertIn(hashlib.sha256(original).hexdigest(), report["backup"])
            saved = read_status(job)
            self.assertEqual(saved["items"][-1], pending)
            self.assertTrue(all(item["status"] == "abstract_only" for item in saved["items"][:-1]))
            for relative, blob in files.items():
                self.assertEqual((job / relative).read_bytes(), blob)
            self.assertEqual(json.loads((job / "fulltext" / "review.json").read_text(encoding="utf-8")), report)

    def test_existing_downstream_artifact_refuses_review_without_any_mutation(self):
        for downstream in ("extraction", "validation", "export"):
            with self.subTest(downstream=downstream), tempfile.TemporaryDirectory() as temp:
                job, original, files, _ = self.legacy_job(Path(temp))
                folder = job / downstream
                folder.mkdir()
                marker = folder / "existing-result.json"
                marker.write_bytes(b'{"existing":true}\n')
                with self.assertRaisesRegex(ValueError, "下游"):
                    fulltext.review_saved_fulltext(job, emit_result=False)
                self.assertEqual((job / "fulltext" / "status.json").read_bytes(), original)
                self.assertFalse((job / "fulltext" / "backups").exists())
                self.assertFalse((job / "fulltext" / "review.json").exists())
                self.assertEqual(marker.read_bytes(), b'{"existing":true}\n')
                for relative, blob in files.items():
                    self.assertEqual((job / relative).read_bytes(), blob)


class FetchSafetyTests(unittest.TestCase):
    def test_bare_cnki_error_entry_is_never_requested(self):
        with tempfile.TemporaryDirectory() as temp:
            record = candidate("CNKI-001", result_url="https://kns.cnki.net/kcms2/article/abstract")
            fetcher = FakeFetcher()
            self.assertEqual(fulltext.candidate_urls(record), [])
            target = fulltext._target_from_candidate(record)
            item = fulltext.fetch_one(target, Path(temp), {"fetcher": fetcher})
            self.assertEqual(item["status"], "unavailable")
            self.assertEqual(fetcher.calls, [])
            valid = candidate("CNKI-002", result_url="https://kns.cnki.net/kcms2/article/abstract?v=article-identity")
            self.assertTrue(fulltext.candidate_urls(valid))

    def test_cached_cnki_transfer_is_never_replayed_and_pauses_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            transfer = "https://bar.cnki.net/bar/download/order?id=fixture-only"
            rows = [candidate("CNKI-001", result_url="https://kns.cnki.net/kcms2/article/abstract",
                              links=[{"label":"下载", "url":transfer}]),
                    candidate("GSC-002", result_url="https://example.org/next")]
            write_candidates(job, rows)
            fetcher = FakeFetcher()
            code, events = run_stage(job, fetcher=fetcher)
            self.assertEqual(code, 0)
            self.assertEqual([call for call in fetcher.calls if call[0] != "ensure_ready"], [])
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(events[-1]["reason"], "page_error")
            self.assertIn("中转链接", events[-1]["message"])
            self.assertNotIn("fixture-only", events[-1]["message"])
            items = status_map(read_status(job))
            self.assertEqual(items["CNKI-001"]["status"], "needs_attention")
            self.assertEqual(items["GSC-002"]["status"], "pending")
            self.assertEqual(fulltext.candidate_urls(rows[0]), [])

    def test_legal_article_body_is_not_rejected_because_old_transfer_also_exists(self):
        with tempfile.TemporaryDirectory() as temp:
            title = "Heat stress and growth performance in broiler chickens"
            stable = "https://example.org/article"
            transfer = "https://bar.cnki.net/bar/download/order?id=fixture-only"
            record = fulltext._target_from_candidate(candidate("CNKI-001", title=title, result_url=stable,
                links=[{"label":"下载", "url":transfer}]))
            fetcher = FakeFetcher(page={stable:article_page(title)})
            result = fulltext.fetch_one(record, Path(temp), {"fetcher":fetcher})
            self.assertEqual(result["status"], "fetched_html")
            self.assertNotIn(("fetch_page", transfer), fetcher.calls)

    def test_long_pubmed_abstract_follows_observed_pmc_link_and_saves_only_verified_body(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            title = "Heat stress and growth performance in broiler chickens"
            pubmed = "https://pubmed.ncbi.nlm.nih.gov/33925609/"
            pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC8146860/"
            abstract = "Abstract\n" + "PubMed abstract, references and navigation. " * 120
            page = article_page(title)
            fetcher = FakeFetcher(page={
                pubmed: {"status": "ok", "text": abstract,
                         "html_evidence": {"links": [{"url": pmc, "text": "Free full text in PMC"}]}},
                pmc: page,
            })
            record = fulltext._target_from_candidate(candidate("PMID-001", title=title, result_url=pubmed))
            item = fulltext.fetch_one(record, job, {"fetcher": fetcher})
            self.assertEqual([url for kind, url in fetcher.calls if kind == "fetch_page"], [pubmed, pmc])
            self.assertEqual(item["status"], "fetched_html")
            self.assertEqual(item["fulltext_url"], pmc)
            saved = (job / item["path"]).read_text(encoding="utf-8")
            self.assertEqual(saved, page["html_evidence"]["article_text"].strip() + "\n")
            self.assertNotIn("PubMed abstract", saved)
            self.assertTrue(verified_saved_html(item, saved)[0])

    def test_wrong_article_after_fulltext_link_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            title = "Heat stress and growth performance in broiler chickens"
            source = "https://pubmed.ncbi.nlm.nih.gov/33925609/"
            linked = "https://pmc.ncbi.nlm.nih.gov/articles/PMC8146860/"
            fetcher = FakeFetcher(page={source: {"status": "ok", "text": "Abstract\n" + "Abstract text " * 300,
                                               "html_evidence": {"links": [{"url": linked, "text": "Full text"}]}},
                                        linked: article_page("An unrelated article about another topic")})
            record = fulltext._target_from_candidate(candidate("PMID-001", title=title, result_url=source))
            item = fulltext.fetch_one(record, Path(temp), {"fetcher": fetcher})
            self.assertEqual(item["status"], "abstract_only")
            self.assertNotIn("evidence_version", item)

    def test_429_and_404_pause_current_save_pending_rest_disconnect_preserve_pages(self):
        for http_status, reason in ((429, "rate_limited"), (404, "page_error")):
            with self.subTest(status=http_status), tempfile.TemporaryDirectory() as temp:
                job = Path(temp)
                write_candidates(job, [candidate("CNKI-001", result_url="https://kns.cnki.net/article/one"),
                                       candidate("CNKI-002", result_url="https://kns.cnki.net/article/two")])
                context = Context([{"response": Response(http_status), "snapshot": snapshot()}])
                clock = Clock()
                fetcher = FulltextBrowserFetcher({}, job, runtime_factory=context.runtime,
                                                clock=clock.time, sleep=clock.sleep)
                with patch.object(fetcher, "complete_paper", wraps=fetcher.complete_paper) as completed:
                    code, events = run_stage(job, fetcher=fetcher)
                    completed.assert_not_called()
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertEqual(events[-1]["reason"], reason)
                items = status_map(read_status(job))
                self.assertEqual(items["CNKI-001"]["status"], "needs_attention")
                self.assertEqual(items["CNKI-002"]["status"], "pending")
                self.assertEqual(context.entries, 1)
                self.assertEqual(context.exits, 1)
                self.assertTrue(all(not page.closed for page in context.pages))
                self.assertEqual(sum(len(page.gotos) for page in context.pages), 1)

    def test_success_closes_owned_page_only_after_artifact_and_status_are_saved(self):
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            write_candidates(job, [candidate("GSC-002", result_url="https://publisher.test/article")])
            testcase = self

            class OrderedFetcher(FakeFetcher):
                def __init__(self):
                    super().__init__(page={"https://publisher.test/article": article_page()})
                    self.completed = 0
                    self.disconnected = False

                def complete_paper(self):
                    item = status_map(read_status(job))["GSC-002"]
                    testcase.assertEqual(item["status"], "fetched_html")
                    text = (job / item["path"]).read_text(encoding="utf-8")
                    testcase.assertTrue(verified_saved_html(item, text)[0])
                    self.completed += 1

                def close(self):
                    testcase.assertEqual(self.completed, 1)
                    self.disconnected = True

            fetcher = OrderedFetcher()
            code, events = run_stage(job, fetcher=fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["count"], 1)
            self.assertTrue(fetcher.disconnected)
            self.assertEqual(fetcher.completed, 1)

    def test_unsuccessful_item_does_not_call_complete_paper(self):
        for page in ({"status": "nav_error"}, {"status": "ok", "text": "Abstract\n" + "Abstract text. " * 300},
                     {"status": "attention", "reason": "page_error", "message": "404; paused"}):
            with self.subTest(status=page["status"]), tempfile.TemporaryDirectory() as temp:
                job = Path(temp)
                write_candidates(job, [candidate("GSC-002", result_url="https://publisher.test/article")])
                fetcher = FakeFetcher(page={"https://publisher.test/article": page})
                with patch.object(fetcher, "complete_paper", create=True) as complete:
                    run_stage(job, fetcher=fetcher)
                    complete.assert_not_called()


class ExtractionGateSafetyTests(unittest.TestCase):
    def test_legacy_html_is_refused_even_with_matching_schema_input_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            job = write_job(Path(temp))
            config = json.loads((job / "run_config.json").read_text(encoding="utf-8"))
            schema = extract.require_schema(job)
            folder = job / "extraction" / "inputs"
            folder.mkdir(parents=True)
            bundle = folder / "GSC-001.json"
            original_bundle = (json.dumps({"schema_sha256": schema["sha256"], "paper_id": "GSC-001",
                                          "fulltext": {"text": "Old unverified bundle"}}) + "\n").encode("utf-8")
            bundle.write_bytes(original_bundle)
            status_path = job / "fulltext" / "status.json"
            status = json.loads(status_path.read_text(encoding="utf-8"))
            for key in ("evidence_version", "html_evidence", "content_sha256"):
                status["items"][0].pop(key, None)
            status_path.write_text(json.dumps(status), encoding="utf-8")
            original_status = status_path.read_bytes()
            for force in (False, True):
                with self.subTest(force=force), self.assertRaisesRegex(extract.StageError, "正文复核"):
                    extract.build_bundles(config, job, force=force)
            self.assertEqual(bundle.read_bytes(), original_bundle)
            self.assertEqual(status_path.read_bytes(), original_status)


if __name__ == "__main__":
    unittest.main()
