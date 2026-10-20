"""CNKI normal-click handoff through the full-text driver, without any browser.

All 49-target jobs and 30 cached files are temporary synthetic fixtures. The
fetch_cnki seam never connects to CNKI, CDP, or a persistent browser profile.
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import literature_fulltext as fulltext
from test_literature_fulltext import (
    article_page, candidate, fake_pdf_bytes, read_status, run_stage, status_map,
    write_candidates, write_dedupe,
)


CURRENT = "CNKI-007"
ARTICLE_TITLE = "PGE2在热应激肉鸡肠道免疫功能中的调控机制"


def snapshot_files(root, paths):
    return {relative: hashlib.sha256((root / relative).read_bytes()).hexdigest()
            for relative in paths}


def make_job(job):
    """Match the real task's shape, without copying any user research data."""
    rows = []
    for prefix, count, source in (("PMID", 10, "pubmed"), ("SCOPUS", 10, "scopus"),
                                  ("WANFANG", 10, "wanfang"), ("CNKI", 10, "cnki"),
                                  ("GSC", 9, "google-scholar")):
        for index in range(1, count + 1):
            paper_id = f"{prefix}-{index:03d}"
            is_cnki = source == "cnki"
            rows.append(candidate(
                paper_id,
                title=ARTICLE_TITLE if paper_id == CURRENT else f"Synthetic study {paper_id}",
                source_key=source,
                result_url=("https://kns.cnki.net/kcms2/article/abstract" if is_cnki
                            else f"https://publisher.invalid/article/{paper_id}"),
                links=([{"label": "下载", "url": "https://bar.cnki.net/bar/download/order?fixture=not-replayable"}]
                       if is_cnki else []),
            ))
    write_candidates(job, rows)
    write_dedupe(job, [{"canonical_id": row["candidate_id"], "title": row["title"],
                       "doi": "", "records": [row]} for row in rows])
    config = {"version": 2, "query": 'broiler "heat stress"',
              "sources": ["pubmed", "scopus", "wanfang", "cnki", "google-scholar"],
              "fulltext": {"maxPapers": 0, "perPaperTimeoutSec": 120}}
    (job / "run_config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    (job / "candidates.csv").write_bytes(b"candidate_id,title\nfixture,synthetic\n")
    folder = job / "fulltext" / "files"
    folder.mkdir(parents=True)
    items = []
    for target in fulltext.load_targets(job, config):
        item = fulltext._item_skeleton(target)
        if target["source_key"] in {"pubmed", "scopus", "wanfang"}:
            relative = f"fulltext/files/{target['paper_id']}.txt"
            blob = ("Abstract\nSynthetic previously saved abstract " * 35).encode("utf-8")
            (job / relative).write_bytes(blob)
            item.update(status="abstract_only", kind="html", path=relative,
                        size=len(blob), evidence_level="abstract_only",
                        reason="Existing cache reviewed offline; not full text",
                        retrieved_at="2026-10-19T00:00:00Z", reviewed_at="2026-10-20T00:00:00Z")
        elif target["source_key"] == "cnki":
            item.update(status="unavailable", entry_required=True,
                        reviewed_at="2026-10-20T00:00:00Z", reason=fulltext.CNKI_ENTRY_MESSAGE)
        items.append(item)
    fulltext._write_status(job, items)
    unchanged = ["run_config.json", "candidates.json", "candidates.csv", "dedupe/dedupe.json"]
    unchanged.extend(str(path.relative_to(job)).replace("\\", "/") for path in folder.iterdir())
    return config, copy.deepcopy(status_map(read_status(job))), snapshot_files(job, unchanged)


class CnkiFetcher:
    def __init__(self, result, job=None, on_complete=None):
        self.result = result
        self.job = job
        self.on_complete = on_complete
        self.calls = []
        self.completed = 0
        self.closed = 0

    def ensure_ready(self):
        self.calls.append(("ensure_ready",))
        return {"status": "ok"}

    def fetch_cnki(self, record, opts):
        self.calls.append(("fetch_cnki", copy.deepcopy(record)))
        return copy.deepcopy(self.result)

    def fetch_page(self, *args):
        raise AssertionError("CNKI must not replay cached landing/transfer URLs")

    def fetch_pdf(self, *args):
        raise AssertionError("CNKI must not fall back to copied PDF URLs")

    def complete_paper(self):
        if self.on_complete:
            self.on_complete()
        self.completed += 1

    def close(self):
        self.closed += 1


class CnkiPipelineTests(unittest.TestCase):
    def assert_preserved(self, job, original_items, hashes):
        current = status_map(read_status(job))
        self.assertEqual(len(current), 49)
        for paper_id, original in original_items.items():
            if paper_id != CURRENT:
                self.assertEqual(current[paper_id], original, f"unselected target changed: {paper_id}")
        self.assertEqual(snapshot_files(job, hashes), hashes)
        self.assertEqual(len(list((job / "fulltext/files").glob("*.txt"))), 30)

    def test_only_one_of_49_retries_and_pdf_status_saved_before_close(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            config, original, hashes = make_job(job)
            blob = fake_pdf_bytes()

            def persisted_before_close():
                item = status_map(read_status(job))[CURRENT]
                self.assertEqual(item["status"], "fetched_pdf")
                self.assertEqual((job / item["path"]).read_bytes(), blob)

            fetcher = CnkiFetcher({"status": "pdf_page", "url": "https://kns.cnki.net/kcms2/article/read",
                                   "bytes": blob}, job, persisted_before_close)
            code, events = run_stage(job, config, fetcher=fetcher, resume=True,
                                     only=[CURRENT], retry_unavailable=True, limit=1)
            self.assertEqual(code, 0)
            self.assertEqual(events[-1]["type"], "result")
            self.assertEqual(fetcher.completed, 1)
            self.assertEqual(fetcher.closed, 1)
            calls = [call[1] for call in fetcher.calls if call[0] == "fetch_cnki"]
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["paper_id"], CURRENT)
            self.assertEqual(calls[0]["source_candidate_id"], CURRENT)
            self.assertEqual(calls[0]["source_key"], "cnki")
            self.assertEqual(calls[0]["title"], ARTICLE_TITLE)
            self.assert_preserved(job, original, hashes)

            # A subsequent resume does not download or reopen a verified cache.
            repeated = CnkiFetcher({"status": "attention", "reason": "page_error"})
            code, _ = run_stage(job, config, fetcher=repeated, resume=True,
                                only=[CURRENT], retry_unavailable=True, limit=1)
            self.assertEqual(code, 0)
            self.assertEqual(repeated.calls, [])
            self.assert_preserved(job, original, hashes)

    def test_attention_keeps_single_current_paper_and_does_not_continue_other_pending(self):
        for reason in ("verification", "login", "rate_limited", "load_timeout", "page_error"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                config, original, hashes = make_job(job)
                fetcher = CnkiFetcher({"status": "attention", "reason": reason,
                                       "message": "Synthetic official page requires attention",
                                       "url": "https://kns.cnki.net/kcms2/article/read"})
                code, events = run_stage(job, config, fetcher=fetcher, resume=True,
                                         only=[CURRENT], retry_unavailable=True, limit=1)
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertEqual(events[-1]["paper_id"], CURRENT)
                self.assertEqual(events[-1]["reason"], reason)
                self.assertEqual(sum(call[0] == "fetch_cnki" for call in fetcher.calls), 1)
                self.assertEqual(fetcher.completed, 0)
                self.assertEqual(fetcher.closed, 1)
                current = status_map(read_status(job))[CURRENT]
                self.assertEqual(current["status"], "needs_attention")
                self.assertEqual(current["path"], "")
                self.assertFalse((job / "fulltext/files/CNKI-007.pdf").exists())
                self.assert_preserved(job, original, hashes)

    def test_invalid_download_and_abstract_are_not_accepted_as_fulltext(self):
        variants = [
            {"status": "pdf_page", "bytes": b"<html>Not a PDF</html>"},
            {"status": "pdf_page", "bytes": b"%PDF-1.4\nsmall"},
            {"status": "ok", "text": "Abstract\n" + "Synthetic abstract " * 300},
            article_page("A completely different article title"),
        ]
        for result in variants:
            with self.subTest(status=result["status"]), tempfile.TemporaryDirectory() as temporary:
                job = Path(temporary)
                config, original, hashes = make_job(job)
                fetcher = CnkiFetcher(result)
                code, events = run_stage(job, config, fetcher=fetcher, only=[CURRENT],
                                         resume=True, retry_unavailable=True, limit=1)
                self.assertEqual(code, 0)
                self.assertEqual(events[-1]["type"], "attention")
                self.assertEqual(status_map(read_status(job))[CURRENT]["status"], "needs_attention")
                self.assertEqual(fetcher.completed, 0)
                self.assertFalse((job / "fulltext/files/CNKI-007.pdf").exists())
                self.assertFalse((job / "fulltext/files/CNKI-007.txt").exists())
                self.assert_preserved(job, original, hashes)

    def test_normalized_group_retains_actual_source_record_identity(self):
        row = candidate("REAL-CNKI-008", source_key="cnki", title=ARTICLE_TITLE)
        target = fulltext._target_from_group({"canonical_id": "canonical-mixed-group",
                                             "title": ARTICLE_TITLE, "records": [row]})
        self.assertEqual(target["paper_id"], "canonical-mixed-group")
        self.assertEqual(target["source_key"], "cnki")
        self.assertEqual(target["source_candidate_id"], "REAL-CNKI-008")

    def test_single_retry_does_not_silently_review_another_legacy_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            config, _, hashes = make_job(job)
            document = read_status(job)
            legacy = document["items"][0]
            legacy.update(status="fetched_html", evidence_level="fulltext_html")
            fulltext.atomic_write_json(job / "fulltext/status.json", document)
            before = (job / "fulltext/status.json").read_bytes()
            fetcher = CnkiFetcher({"status": "pdf_page", "bytes": fake_pdf_bytes()})
            code, events = run_stage(job, config, fetcher=fetcher, only=[CURRENT],
                                     resume=True, retry_unavailable=True, limit=1)
            self.assertEqual(code, 1)
            self.assertEqual(events[-1]["type"], "error")
            self.assertIn("复核", events[-1]["message"])
            self.assertEqual(fetcher.calls, [])
            self.assertEqual((job / "fulltext/status.json").read_bytes(), before)
            self.assertEqual(snapshot_files(job, hashes), hashes)
            self.assertFalse((job / "fulltext/review.json").exists())
            self.assertFalse((job / "fulltext/backups").exists())

    def test_id_prefix_alone_does_not_send_non_cnki_paper_to_cnki_flow(self):
        with tempfile.TemporaryDirectory() as temporary:
            fetcher = CnkiFetcher({"status": "pdf_page", "bytes": fake_pdf_bytes()})
            # No source metadata and no legal link: should remain gated normally.
            target = fulltext._target_from_candidate(candidate("CNKI-LOOKALIKE"))
            item = fulltext.fetch_one(target, Path(temporary), {"fetcher": fetcher})
            self.assertEqual(item["status"], "unavailable")
            self.assertEqual(fetcher.calls, [])


if __name__ == "__main__":
    unittest.main()
