"""Tests for the restricted fulltext acquisition stage (tools/literature_fulltext.py).

Coverage (offline fixtures only; no real site is ever contacted):

- URL classification: direct readable page / PDF link / unreachable (§2.4.3 priority);
- optional PDF landing path (out_path_override -> fulltext/files/<id>.pdf, %PDF+50KB checks);
- per-item status records with failure reasons and 待补充 marking (§3.5);
- interop with candidates.json and dedupe/dedupe.json inputs;
- resume policy (fetched_* kept, needs_attention retried, unavailable gated behind
  --retry-unavailable), --limit / --only / fulltext.maxPapers quotas;
- captcha -> attention(verification) + exit 0 + needs_attention item;
- production alias points at the dedicated task-page fetcher;
- one end-to-end pass over a real localhost http.server fixture (paper.pdf,
  article.html, paywall.html, missing page, refused port).
"""
from __future__ import annotations

import contextlib
import functools
import http.server
import io
import json
import socket
import sys
import tempfile
import threading
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import literature_fulltext as lf


def fake_pdf_bytes(size: int | None = None) -> bytes:
    size = size or lf.MIN_PDF_BYTES + 1024
    return b"%PDF-1.4\n" + b"0" * (size - 15) + b"\n%%EOF"


def article_page(title: str = "论文 GSC-002") -> dict:
    """Explicit body fixture; unrelated long page text is never upgraded."""
    sections = []
    for number, heading in enumerate(("Introduction", "Materials and methods", "Results", "Discussion")):
        text = (f"This section {number} describes temperature effects on poultry growth and measured production responses. " * 5).strip()
        sections.append({"heading": heading, "text": text})
    body = "\n\n".join(f"{section['heading']}\n{section['text']}" for section in sections)
    return {"status": "ok", "text": body,
            "html_evidence": {"origin": "dom_article_region", "container_verified": True,
                              "container": "article .body", "page_title": title, "citation_title": title,
                              "article_text": body, "sections": sections}}


def candidate(cid: str, *, result_url: str = "", links: list[dict] | None = None, snippet: str = "", **extra) -> dict:
    record = {
        "candidate_id": cid,
        "title": f"论文 {cid}",
        "result_url": result_url,
        "fulltext_links": links or [],
        "snippet": snippet,
        "screening_status": "pending_review",
        "evidence_level": "search_result_snippet",
    }
    record.update(extra)
    return record


def write_candidates(job_dir: Path, records: list[dict]) -> None:
    (job_dir / "candidates.json").write_text(
        json.dumps({"version": 2, "source": "Google Scholar", "query": "q", "count": len(records), "records": records}, ensure_ascii=False),
        encoding="utf-8",
    )


def write_dedupe(job_dir: Path, groups: list[dict]) -> None:
    (job_dir / "dedupe").mkdir(parents=True, exist_ok=True)
    (job_dir / "dedupe" / "dedupe.json").write_text(
        json.dumps(
            {
                "version": 1,
                "generated_at": "2026-10-15T00:00:00+00:00",
                "threshold": 0.55,
                "counts": {"records_in": len(groups), "groups": len(groups), "merged": 0, "needs_review_groups": 0},
                "groups": groups,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def read_status(job_dir: Path) -> dict:
    return json.loads((job_dir / "fulltext" / "status.json").read_text(encoding="utf-8"))


def status_map(doc: dict) -> dict:
    return {item["paper_id"]: item for item in doc["items"]}


def run_stage(job_dir: Path, config: dict | None = None, fetcher=None, **kwargs):
    events: list[dict] = []
    with patch.object(lf, "emit", lambda kind, **values: events.append({"type": kind, **values})):
        code = lf.run(config or {"version": 2}, job_dir, fetcher=fetcher, **kwargs)
    return code, events


class FakeFetcher:
    """Deterministic offline fetcher fixture: URL -> canned outcome."""

    def __init__(self, *, pdf: dict | None = None, page: dict | None = None, ready: dict | None = None):
        self.pdf_results = pdf or {}
        self.page_results = page or {}
        self.ready_result = ready or {"status": "ok"}
        self.calls: list[tuple[str, str]] = []

    def ensure_ready(self) -> dict:
        self.calls.append(("ensure_ready", ""))
        return self.ready_result

    def fetch_pdf(self, url: str, out_path: Path, opts: dict) -> dict:
        self.calls.append(("fetch_pdf", url))
        payload = dict(self.pdf_results.get(url) or {"status": "saved"})
        if payload.get("status") in {"saved", "already_exists"}:
            blob = payload.pop("bytes", None) or fake_pdf_bytes()
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_bytes(blob)
        payload.pop("bytes", None)
        return payload

    def fetch_page(self, url: str, opts: dict) -> dict:
        self.calls.append(("fetch_page", url))
        payload = dict(self.page_results.get(url) or {"status": "nav_error", "error": "fixture: unreachable"})
        if payload.get("status") == "pdf_page":
            payload["url"] = payload.get("url") or url
            payload["bytes"] = payload.get("bytes") or fake_pdf_bytes()
        return payload


# ---------------------------------------------------------------------------
# Classification & pure helpers
# ---------------------------------------------------------------------------

class ClassifyTargetTest(unittest.TestCase):
    def test_pdf_direct_link_has_top_priority(self) -> None:
        record = candidate("GSC-001", result_url="https://example.org/article", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}])
        verdict = lf.classify_target(record)
        self.assertEqual(verdict["kind"], "pdf")
        self.assertEqual(verdict["url"], "https://example.org/a.pdf")

    def test_result_url_pdf_detected_with_query_string_and_case(self) -> None:
        record = candidate("GSC-001", result_url="https://example.org/a.PDF?download=1")
        self.assertEqual(lf.classify_target(record)["kind"], "pdf")

    def test_result_url_page_classified_html(self) -> None:
        record = candidate("GSC-001", result_url="https://example.org/article")
        self.assertEqual(lf.classify_target(record)["kind"], "html")

    def test_non_pdf_fulltext_link_used_as_page_when_no_result_url(self) -> None:
        record = candidate("GSC-001", links=[{"label": "HTML", "url": "https://example.org/html-version"}])
        verdict = lf.classify_target(record)
        self.assertEqual(verdict["kind"], "html")
        self.assertEqual(verdict["url"], "https://example.org/html-version")

    def test_snippet_only_is_abstract(self) -> None:
        record = candidate("GSC-001", snippet="Scholar 片段")
        self.assertEqual(lf.classify_target(record)["kind"], "abstract")

    def test_nothing_is_none(self) -> None:
        self.assertEqual(lf.classify_target(candidate("GSC-001"))["kind"], "none")

    def test_unsafe_urls_are_ignored(self) -> None:
        record = candidate("GSC-001", result_url="javascript:alert(1)", links=[{"label": "x", "url": "ftp://example.org/a.pdf"}])
        self.assertEqual(lf.classify_target(record)["kind"], "none")

    def test_attempt_chain_orders_pdf_links_then_pdf_result_then_pages(self) -> None:
        record = candidate(
            "GSC-001",
            result_url="https://example.org/article",
            links=[{"label": "HTML", "url": "https://example.org/h"}, {"label": "PDF", "url": "https://example.org/p.pdf"}],
        )
        self.assertEqual(
            lf.candidate_urls(record),
            [("pdf", "https://example.org/p.pdf"), ("html", "https://example.org/article"), ("html", "https://example.org/h")],
        )

    def test_pubmed_candidate_tries_pmc_before_pubmed_and_other_links(self) -> None:
        pubmed = "https://pubmed.ncbi.nlm.nih.gov/33142538/"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/"
        record = candidate("PMID-001", source_key="pubmed", result_url=pubmed, links=[
            {"label": "Publisher PDF", "url": "https://publisher.test/paper.pdf"},
            {"label": "PubMed Central full text", "url": pmc},
        ])
        self.assertEqual(lf.candidate_urls(record)[:3],
                         [("pdf", pmc.rstrip("/") + "/pdf/"), ("html", pmc), ("html", pubmed)])


class AssessHtmlTextTest(unittest.TestCase):
    def test_long_text_without_dom_proof_is_not_fulltext(self) -> None:
        self.assertEqual(lf.assess_html_text("正文内容 " * 500)[0], "unavailable")

    def test_verified_article_is_fulltext(self) -> None:
        page = article_page()
        self.assertEqual(lf.assess_html_text(page["text"], evidence=page["html_evidence"], expected_title="论文 GSC-002")[0], "fulltext")

    def test_long_pubmed_abstract_stays_abstract(self) -> None:
        verdict, _ = lf.assess_html_text("Abstract\n" + "A long abstract with results and references. " * 150,
                                          url="https://pubmed.ncbi.nlm.nih.gov/33925609/")
        self.assertEqual(verdict, "abstract")

    def test_medium_text_is_abstract_with_pending_note(self) -> None:
        verdict, reason = lf.assess_html_text("摘要\n" + "摘要文本 " * 80)
        self.assertEqual(verdict, "abstract")
        self.assertTrue(reason)

    def test_short_text_is_unavailable(self) -> None:
        verdict, reason = lf.assess_html_text("太短")
        self.assertEqual(verdict, "unavailable")
        self.assertTrue(reason)

    def test_english_paywall_marker_wins_over_length(self) -> None:
        verdict, reason = lf.assess_html_text("Purchase this article to continue. " * 200)
        self.assertEqual(verdict, "unavailable")
        self.assertIn("权限", reason)

    def test_chinese_paywall_marker_wins_over_length(self) -> None:
        verdict, reason = lf.assess_html_text("需订阅后阅读全文 " * 300)
        self.assertEqual(verdict, "unavailable")
        self.assertIn("权限", reason)


class ValidatePdfBytesTest(unittest.TestCase):
    def test_empty_rejected(self) -> None:
        self.assertEqual(lf.validate_pdf_bytes(b"")[1], "empty")

    def test_missing_magic_rejected(self) -> None:
        self.assertEqual(lf.validate_pdf_bytes(b"<html>" + b"0" * lf.MIN_PDF_BYTES)[1], "not_a_pdf")

    def test_too_small_rejected(self) -> None:
        self.assertEqual(lf.validate_pdf_bytes(b"%PDF-1.4 tiny")[1], "too_small")

    def test_valid_accepted(self) -> None:
        ok, why, size = lf.validate_pdf_bytes(fake_pdf_bytes())
        self.assertTrue(ok)
        self.assertEqual(why, "ok")
        self.assertEqual(size, lf.MIN_PDF_BYTES + 1024)


# ---------------------------------------------------------------------------
# fetch_one
# ---------------------------------------------------------------------------

class FetchOneTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.job = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _opts(self, fetcher) -> dict:
        return {"fetcher": fetcher, "per_paper_timeout_sec": 120, "prefer_pmc_pdf": False}

    def _target(self, **kwargs) -> dict:
        return lf._target_from_candidate(candidate("GSC-001", **kwargs))

    def test_pubmed_tries_pmc_first_and_stops_after_verified_fulltext(self) -> None:
        pubmed = "https://pubmed.ncbi.nlm.nih.gov/33142538/"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/"
        fetcher = FakeFetcher(page={pmc: article_page("论文 GSC-001")})
        item = lf.fetch_one(self._target(source_key="pubmed", result_url=pubmed,
            links=[{"label": "PubMed Central full text", "url": pmc}]), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "fetched_html")
        self.assertEqual(fetcher.calls, [("fetch_page", pmc)])

    def test_pubmed_falls_back_after_pmc_access_error(self) -> None:
        pubmed = "https://pubmed.ncbi.nlm.nih.gov/33142538/"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/"
        class ReleasableFetcher(FakeFetcher):
            def defer_paper(self, **kwargs):
                self.calls.append(("defer_paper", kwargs["url"]))
        fetcher = ReleasableFetcher(page={
            pmc: {"status": "attention", "reason": "access_required", "url": pmc},
            pubmed: {"status": "ok", "text": "Abstract\n" + "Study details. " * 30, "url": pubmed},
        })
        item = lf.fetch_one(self._target(source_key="pubmed", result_url=pubmed,
            links=[{"label": "PubMed Central full text", "url": pmc}]), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "abstract_only")
        self.assertEqual(fetcher.calls[:3], [("fetch_page", pmc), ("defer_paper", pmc), ("fetch_page", pubmed)])

    def test_pubmed_does_not_continue_after_pmc_verification(self) -> None:
        pubmed = "https://pubmed.ncbi.nlm.nih.gov/33142538/"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/"
        fetcher = FakeFetcher(page={pmc: {"status": "captcha", "url": pmc}})
        with self.assertRaises(lf.CaptchaPause):
            lf.fetch_one(self._target(source_key="pubmed", result_url=pubmed,
                links=[{"label": "PubMed Central full text", "url": pmc}]), self.job, self._opts(fetcher))
        self.assertEqual(fetcher.calls, [("fetch_page", pmc)])

    def test_pdf_success_records_file_status_and_evidence(self) -> None:
        fetcher = FakeFetcher()
        item = lf.fetch_one(self._target(links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "fetched_pdf")
        self.assertEqual(item["kind"], "pdf")
        self.assertEqual(item["path"], "fulltext/files/GSC-001.pdf")
        self.assertEqual(item["evidence_level"], "fulltext_pdf")
        self.assertEqual(item["size"], lf.MIN_PDF_BYTES + 1024)
        self.assertTrue((self.job / item["path"]).exists())
        self.assertEqual(item["reason"], "")

    def test_invalid_pdf_from_downloader_is_deleted_and_falls_through(self) -> None:
        fetcher = FakeFetcher(pdf={"https://example.org/a.pdf": {"status": "saved", "bytes": b"not-a-pdf"}})
        item = lf.fetch_one(self._target(links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "unavailable")
        self.assertIn("PDF 校验失败", item["reason"])
        self.assertFalse((self.job / "fulltext" / "files" / "GSC-001.pdf").exists())

    def test_pdf_failure_falls_back_to_html_page(self) -> None:
        fetcher = FakeFetcher(
            pdf={"https://example.org/dead.pdf": {"status": "no_pdf_button_found"}},
            page={"https://example.org/article": article_page("论文 GSC-001")},
        )
        item = lf.fetch_one(
            self._target(result_url="https://example.org/article", links=[{"label": "[PDF]", "url": "https://example.org/dead.pdf"}]),
            self.job,
            self._opts(fetcher),
        )
        self.assertEqual(item["status"], "fetched_html")
        self.assertEqual(item["kind"], "html")
        self.assertEqual(item["path"], "fulltext/files/GSC-001.txt")
        self.assertEqual(item["evidence_level"], "fulltext_html")
        self.assertTrue((self.job / item["path"]).exists())
        self.assertEqual([call[0] for call in fetcher.calls], ["fetch_pdf", "fetch_page"])

    def test_page_returning_pdf_bytes_is_saved_as_pdf(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/download": {"status": "pdf_page"}})
        item = lf.fetch_one(self._target(result_url="https://example.org/download"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "fetched_pdf")
        self.assertTrue((self.job / item["path"]).read_bytes().startswith(b"%PDF"))

    def test_verified_html_is_kept_while_main_pdf_wins_over_supplement_pdf(self) -> None:
        article = article_page("Test paper")
        article["html_evidence"]["links"] = [
            {"url": "https://example.org/supp.pdf", "label": "Supplementary PDF", "kind": "pdf"},
            {"url": "https://example.org/main.pdf", "label": "Download article PDF", "kind": "pdf"},
        ]
        fetcher = FakeFetcher(page={"https://example.org/article": article})
        target = self._target(result_url="https://example.org/article", title="Test paper")
        checkpoints = []
        item = lf.fetch_one(target, self.job, {**self._opts(fetcher), "on_main_saved": lambda saved: checkpoints.append(dict(saved))})
        self.assertEqual(item["status"], "fetched_pdf")
        self.assertEqual([entry["status"] for entry in checkpoints], ["fetched_html", "fetched_pdf"])
        self.assertTrue((self.job / "fulltext/files/GSC-001.txt").exists())
        self.assertIn(("fetch_pdf", "https://example.org/main.pdf"), fetcher.calls)
        self.assertNotIn(("fetch_pdf", "https://example.org/supp.pdf"), fetcher.calls)

    def test_returned_main_is_checkpointed_before_supplement_attention(self) -> None:
        discovery = {"status": "checked", "links": [{"url": "https://example.org/s1.xlsx", "label": "Table S1"}]}
        for route in ["pdf", "pdf_page", "html", "cnki"]:
            with self.subTest(route=route):
                folder = self.job / route
                folder.mkdir()
                checkpoint = []
                record = self._target(title="Test paper", result_url="https://example.org/article")
                fetcher = FakeFetcher()
                if route == "pdf":
                    record["source_url"] = "https://example.org/main.pdf"
                    record["result_url"] = record["source_url"]
                    fetcher.pdf_results[record["source_url"]] = {"status": "saved", "material_discovery": discovery}
                elif route == "pdf_page":
                    fetcher.page_results["https://example.org/article"] = {"status": "pdf_page", "material_discovery": discovery}
                elif route == "cnki":
                    record["source_key"] = "cnki"
                    fetcher.fetch_cnki = lambda *_: {"status": "pdf_page", "bytes": fake_pdf_bytes(), "material_discovery": discovery}
                else:
                    fetcher.page_results["https://example.org/article"] = {**article_page("Test paper"), "material_discovery": discovery}
                def pause_after_save(_):
                    self.assertEqual(len(checkpoint), 1)
                    self.assertTrue((folder / checkpoint[0]["path"]).is_file())
                    return {"status": "attention", "reason": "verification", "message": "Supplement login"}
                with self.assertRaises(lf.FulltextPause):
                    lf.fetch_one(record, folder, {**self._opts(fetcher), "on_main_saved": lambda saved: checkpoint.append(dict(saved)),
                                                 "on_material_discovery": pause_after_save})
                self.assertEqual(checkpoint[0]["status"], "fetched_html" if route == "html" else "fetched_pdf")

    def test_invalid_pdf_bytes_from_page_are_not_saved(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/download": {"status": "pdf_page", "bytes": b"<html>404</html>"}})
        item = lf.fetch_one(self._target(result_url="https://example.org/download"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "unavailable")
        self.assertIn("PDF 校验失败", item["reason"])
        self.assertFalse((self.job / "fulltext" / "files" / "GSC-001.pdf").exists())

    def test_paywall_page_is_unavailable_with_pending_marker(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/article": {"status": "ok", "text": "Purchase this article to continue reading " * 60}})
        item = lf.fetch_one(self._target(result_url="https://example.org/article"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "unavailable")
        self.assertIn("权限", item["reason"])
        self.assertIn("待补充", item["reason"])
        self.assertEqual(item["path"], "")

    def test_short_page_is_unavailable(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/article": {"status": "ok", "text": "404 Not Found"}})
        item = lf.fetch_one(self._target(result_url="https://example.org/article"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "unavailable")
        self.assertIn("待补充", item["reason"])

    def test_abstract_level_page_saved_as_txt_with_abstract_evidence(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/article": {"status": "ok", "text": "摘要\n" + "摘要内容 " * 150}})
        item = lf.fetch_one(self._target(result_url="https://example.org/article"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "abstract_only")
        self.assertEqual(item["kind"], "html")
        self.assertEqual(item["evidence_level"], "abstract_only")
        self.assertTrue((self.job / item["path"]).exists())
        self.assertIn("正文", item["reason"])

    def test_unreachable_everything_reports_combined_reason(self) -> None:
        fetcher = FakeFetcher(pdf={"https://example.org/dead.pdf": {"status": "nav_error", "error": "boom"}})
        item = lf.fetch_one(
            self._target(result_url="https://example.org/article", links=[{"label": "[PDF]", "url": "https://example.org/dead.pdf"}]),
            self.job,
            self._opts(fetcher),
        )
        self.assertEqual(item["status"], "unavailable")
        self.assertIn("https://example.org/dead.pdf", item["reason"])
        self.assertIn("https://example.org/article", item["reason"])
        self.assertIn("待补充", item["reason"])

    def test_snippet_only_is_abstract_only(self) -> None:
        item = lf.fetch_one(self._target(snippet="只有检索片段"), self.job, self._opts(FakeFetcher()))
        self.assertEqual(item["status"], "abstract_only")
        self.assertEqual(item["kind"], "abstract")
        self.assertEqual(item["evidence_level"], "search_result_snippet")
        self.assertEqual(item["path"], "")
        self.assertIn("待补充", item["reason"])

    def test_no_link_no_snippet_is_unavailable(self) -> None:
        item = lf.fetch_one(self._target(), self.job, self._opts(FakeFetcher()))
        self.assertEqual(item["status"], "unavailable")
        self.assertEqual(item["kind"], "none")
        self.assertIn("待补充", item["reason"])

    def test_untracked_existing_pdf_is_preserved_and_requires_review(self) -> None:
        files = self.job / "fulltext" / "files"
        files.mkdir(parents=True)
        (files / "GSC-001.pdf").write_bytes(fake_pdf_bytes())
        fetcher = FakeFetcher()
        before = (files / "GSC-001.pdf").read_bytes()
        with self.assertRaises(lf.FulltextPause) as paused:
            lf.fetch_one(self._target(links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]), self.job, self._opts(fetcher))
        self.assertEqual(paused.exception.reason, "local_fulltext_verification")
        self.assertEqual((files / "GSC-001.pdf").read_bytes(), before)
        self.assertEqual(fetcher.calls, [])

    def test_captcha_in_pdf_raises_pause_with_url(self) -> None:
        fetcher = FakeFetcher(pdf={"https://example.org/a.pdf": {"status": "captcha"}})
        with self.assertRaises(lf.CaptchaPause) as ctx:
            lf.fetch_one(self._target(links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]), self.job, self._opts(fetcher))
        self.assertEqual(ctx.exception.paper_id, "GSC-001")
        self.assertEqual(ctx.exception.url, "https://example.org/a.pdf")

    def test_captcha_in_page_raises_pause(self) -> None:
        fetcher = FakeFetcher(page={"https://example.org/article": {"status": "captcha"}})
        with self.assertRaises(lf.CaptchaPause):
            lf.fetch_one(self._target(result_url="https://example.org/article"), self.job, self._opts(fetcher))


# ---------------------------------------------------------------------------
# Input loading
# ---------------------------------------------------------------------------

    def test_pubmed_prefers_pmc_pdf_when_enabled(self) -> None:
        pubmed = "https://pubmed.ncbi.nlm.nih.gov/33142538/"
        pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC7647856/"
        pdf = pmc.rstrip("/") + "/pdf/"
        fetcher = FakeFetcher(pdf={pdf: {"status": "saved"}})
        item = lf.fetch_one(self._target(source_key="pubmed", result_url=pubmed,
            links=[{"label": "PMC", "url": pmc}]), self.job,
            {**self._opts(fetcher), "prefer_pmc_pdf": True})
        self.assertEqual(item["status"], "fetched_pdf")
        self.assertEqual(item["completeness"]["status"], "complete")
        self.assertEqual(fetcher.calls, [("fetch_pdf", pdf)])

    def test_incomplete_html_is_partial_and_lists_missing_sections(self) -> None:
        intro = "Introduction " + ("This introduction describes the study rationale and prior evidence. " * 6)
        results = "Results " + ("The measured growth response was higher in the treatment group. " * 6)
        body = intro + chr(10) + results
        page = {"status": "ok", "text": body,
                "html_evidence": {"origin": "dom_article_region", "container_verified": True,
                                  "citation_title": "论文 GSC-001", "article_text": body,
                                  "sections": [{"heading": "Introduction", "text": intro},
                                               {"heading": "Results", "text": results}]}}
        fetcher = FakeFetcher(page={"https://example.org/article": page})
        item = lf.fetch_one(self._target(result_url="https://example.org/article"), self.job, self._opts(fetcher))
        self.assertEqual(item["status"], "partial")
        self.assertIn("Conclusions/结论", item["completeness"]["missing_sections"])

class LoadTargetsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.job = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_candidates_fallback_keeps_order_and_skips_auto_excluded(self) -> None:
        write_candidates(self.job, [
            candidate("GSC-001", result_url="https://example.org/1"),
            candidate("GSC-002", screening_status="auto_excluded_duplicate", screening_reason="GSC-001"),
            candidate("GSC-003", result_url="https://example.org/3"),
        ])
        targets = lf.load_targets(self.job, {})
        self.assertEqual([t["paper_id"] for t in targets], ["GSC-001", "GSC-003"])
        self.assertEqual(targets[0]["source_url"], "https://example.org/1")
        self.assertEqual(targets[0]["title"], "论文 GSC-001")

    def test_candidates_deduplicates_by_canonical_id(self) -> None:
        write_candidates(self.job, [
            candidate("GSC-001", result_url="https://example.org/1"),
            candidate("GSC-B2-003", canonical_id="GSC-001", result_url="https://example.org/dup"),
            candidate("GSC-002", result_url="https://example.org/2"),
        ])
        targets = lf.load_targets(self.job, {})
        self.assertEqual([t["paper_id"] for t in targets], ["GSC-001", "GSC-002"])

    def test_dedupe_groups_are_preferred_over_candidates(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", result_url="https://example.org/candidate")])
        write_dedupe(self.job, [{
            "canonical_id": "GSC-001",
            "title": "归并标题",
            "doi": "10.1/abc",
            "records": [
                candidate("GSC-B2-003", result_url="https://example.org/dup"),
                candidate("GSC-001", result_url="https://example.org/canonical", links=[{"label": "[PDF]", "url": "https://example.org/canonical.pdf"}]),
            ],
        }])
        targets = lf.load_targets(self.job, {})
        self.assertEqual(len(targets), 1)
        self.assertEqual(targets[0]["paper_id"], "GSC-001")
        self.assertEqual(targets[0]["title"], "归并标题")
        self.assertEqual(targets[0]["doi"], "10.1/abc")
        # links/urls come from the canonical member record, not the first record
        self.assertEqual(targets[0]["source_url"], "https://example.org/canonical")
        self.assertEqual(targets[0]["fulltext_links"][0]["url"], "https://example.org/canonical.pdf")

    def test_malformed_dedupe_falls_back_to_candidates(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", result_url="https://example.org/1")])
        (self.job / "dedupe").mkdir()
        (self.job / "dedupe" / "dedupe.json").write_text("{not json", encoding="utf-8")
        targets = lf.load_targets(self.job, {})
        self.assertEqual([t["paper_id"] for t in targets], ["GSC-001"])

    def test_missing_inputs_raise(self) -> None:
        with self.assertRaises(FileNotFoundError):
            lf.load_targets(self.job, {})

    def test_empty_records_yield_empty_targets(self) -> None:
        write_candidates(self.job, [])
        self.assertEqual(lf.load_targets(self.job, {}), [])


# ---------------------------------------------------------------------------
# Stage run
# ---------------------------------------------------------------------------

class RunFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.job = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _three_papers(self) -> None:
        write_candidates(self.job, [
            candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]),
            candidate("GSC-002", result_url="https://example.org/article"),
            candidate("GSC-003", result_url="https://example.org/dead"),
        ])

    def test_fresh_run_status_document_and_result_event(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(page={"https://example.org/article": article_page()})
        code, events = run_stage(self.job, fetcher=fetcher)
        self.assertEqual(code, 0)
        self.assertEqual(events[0]["type"], "stage")
        result = events[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["stage"], "fulltext")
        self.assertEqual(result["files"], ["fulltext/status.json", "fulltext/materials.json"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["counts"]["fetched_pdf"], 1)
        self.assertEqual(result["counts"]["fetched_html"], 1)
        self.assertEqual(result["counts"]["unavailable"], 1)
        self.assertEqual(result["counts"]["skipped"], 0)

        doc = read_status(self.job)
        self.assertEqual(doc["version"], 1)
        self.assertEqual(doc["policy"], lf.POLICY_TEXT)
        self.assertIn("待补充", doc["policy"])
        items = status_map(doc)
        self.assertEqual(items["GSC-001"]["status"], "fetched_pdf")
        self.assertEqual(items["GSC-002"]["status"], "fetched_html")
        self.assertEqual(items["GSC-003"]["status"], "unavailable")
        self.assertTrue((self.job / items["GSC-001"]["path"]).exists())
        self.assertTrue((self.job / items["GSC-002"]["path"]).exists())
        self.assertEqual(doc["counts"]["total"], 3)
        # §3.5 item key set
        self.assertEqual(
            set(items["GSC-001"].keys()),
            {"paper_id", "title", "doi", "source_url", "fulltext_url", "kind", "status", "path", "size", "retrieved_at", "evidence_level", "reason", "content_sha256", "pdf_evidence", "completeness", "materials_completeness"},
        )

    def test_captcha_pauses_with_attention_and_resume_completes(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(page={"https://example.org/article": {"status": "captcha", "url": "https://example.org/article"}})
        code, events = run_stage(self.job, fetcher=fetcher)
        self.assertEqual(code, 0)
        attention = events[-1]
        self.assertEqual(attention["type"], "attention")
        self.assertEqual(attention["stage"], "verification")
        self.assertIn("不会自动绕过", attention["message"])

        items = status_map(read_status(self.job))
        self.assertEqual(items["GSC-001"]["status"], "fetched_pdf")
        self.assertEqual(items["GSC-002"]["status"], "needs_attention")
        self.assertEqual(items["GSC-003"]["status"], "pending")
        doc_counts = read_status(self.job)["counts"]
        self.assertEqual(doc_counts["needs_attention"], 1)
        self.assertEqual(doc_counts["pending"], 1)

        # resume: needs_attention and pending are retried; fetched item is untouched
        fetcher2 = FakeFetcher(page={
            "https://example.org/article": article_page(),
            "https://example.org/dead": article_page("论文 GSC-003"),
        })
        code2, events2 = run_stage(self.job, fetcher=fetcher2, resume=True)
        self.assertEqual(code2, 0)
        self.assertEqual(events2[-1]["type"], "result")
        self.assertIn("继续", events2[0]["message"])
        calls = [call for call in fetcher2.calls if call[0] != "ensure_ready"]
        self.assertEqual([call[1] for call in calls], ["https://example.org/article", "https://example.org/dead"])
        items = status_map(read_status(self.job))
        self.assertEqual(items["GSC-001"]["status"], "fetched_pdf")
        self.assertEqual(items["GSC-002"]["status"], "fetched_html")
        self.assertEqual(items["GSC-003"]["status"], "fetched_html")

    def test_unavailable_is_gated_behind_retry_flag(self) -> None:
        self._three_papers()
        code, _ = run_stage(self.job, fetcher=FakeFetcher(page={"https://example.org/article": article_page()}))
        self.assertEqual(code, 0)
        self.assertEqual(status_map(read_status(self.job))["GSC-003"]["status"], "unavailable")

        # default resume: unreachable item is not retried, and no browser first touch
        fetcher2 = FakeFetcher()
        code2, events2 = run_stage(self.job, fetcher=fetcher2, resume=True)
        self.assertEqual(code2, 0)
        self.assertEqual([call for call in fetcher2.calls if call[0] != "ensure_ready"], [])
        messages = [event.get("message", "") for event in events2 if event["type"] == "stage"]
        self.assertTrue(any("跳过" in message and "--retry-unavailable" in message for message in messages))
        self.assertEqual(status_map(read_status(self.job))["GSC-003"]["status"], "unavailable")

        # with the flag the item is retried and can become fetched
        fetcher3 = FakeFetcher(page={"https://example.org/dead": article_page("论文 GSC-003")})
        code3, _ = run_stage(self.job, fetcher=fetcher3, resume=True, retry_unavailable=True)
        self.assertEqual(code3, 0)
        self.assertEqual(status_map(read_status(self.job))["GSC-003"]["status"], "fetched_html")

    def test_all_fetched_run_never_launches_browser(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}])])
        code, _ = run_stage(self.job, fetcher=FakeFetcher())
        self.assertEqual(code, 0)
        fetcher2 = FakeFetcher()
        code2, events2 = run_stage(self.job, fetcher=fetcher2, resume=True)
        self.assertEqual(code2, 0)
        self.assertEqual(fetcher2.calls, [])
        self.assertEqual(events2[-1]["count"], 1)
        self.assertEqual(events2[-1]["counts"]["skipped"], 1)

    def test_default_fetcher_backfills_old_main_without_downloading_main_again(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}])])
        self.assertEqual(run_stage(self.job, fetcher=FakeFetcher())[0], 0)
        fetcher = FakeFetcher()
        def inspect(record, opts):
            fetcher.calls.append(("inspect_materials", record["paper_id"]))
            return {"status": "ok", "material_discovery": {"status": "none_declared", "reason": "Publisher explicitly declares none", "links": []}}
        fetcher.inspect_materials = inspect
        with patch.object(lf, "make_fetcher", return_value=fetcher):
            self.assertEqual(run_stage(self.job, resume=True)[0], 0)
        self.assertIn(("inspect_materials", "GSC-001"), fetcher.calls)
        self.assertFalse(any(call[0] in {"fetch_pdf", "fetch_page"} for call in fetcher.calls))
        manifest = json.loads((self.job / "fulltext/materials.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["papers"][0]["supplement_check"]["status"], "none_declared")
        fetcher.calls.clear()
        self.assertEqual(run_stage(self.job, fetcher=fetcher, resume=True)[0], 0)
        self.assertEqual(fetcher.calls, [])

    def test_verified_html_cache_retains_evidence_and_never_reopens_browser(self) -> None:
        write_candidates(self.job, [candidate("GSC-002", result_url="https://example.org/article")])
        first = FakeFetcher(page={"https://example.org/article": article_page()})
        self.assertEqual(run_stage(self.job, fetcher=first)[0], 0)
        original = status_map(read_status(self.job))["GSC-002"]
        self.assertEqual(original["evidence_version"], "fulltext-evidence-v1")
        self.assertTrue(original["content_sha256"])
        second = FakeFetcher()
        self.assertEqual(run_stage(self.job, fetcher=second, resume=True)[0], 0)
        item = status_map(read_status(self.job))["GSC-002"]
        self.assertEqual(item["status"], "fetched_html")
        self.assertEqual(item["content_sha256"], original["content_sha256"])
        self.assertEqual(second.calls, [])

    def test_old_long_html_cache_cannot_silently_enter_fetched_result(self) -> None:
        write_candidates(self.job, [candidate("GSC-002", result_url="https://pubmed.ncbi.nlm.nih.gov/33925609/")])
        folder = self.job / "fulltext" / "files"
        folder.mkdir(parents=True)
        text = "Abstract\n" + "A long abstract followed by references. " * 200
        (folder / "GSC-002.txt").write_text(text, encoding="utf-8")
        (self.job / "fulltext" / "status.json").write_text(json.dumps({"version": 1, "items": [{
            "paper_id": "GSC-002", "status": "fetched_html", "path": "fulltext/files/GSC-002.txt",
            "source_url": "https://pubmed.ncbi.nlm.nih.gov/33925609/", "evidence_level": "fulltext_html",
        }]}), encoding="utf-8")
        fetcher = FakeFetcher()
        code, events = run_stage(self.job, fetcher=fetcher, resume=True)
        self.assertEqual(code, 0)
        self.assertEqual(events[-1]["count"], 0)
        self.assertNotEqual(status_map(read_status(self.job))["GSC-002"]["status"], "fetched_html")
        self.assertEqual((folder / "GSC-002.txt").read_text(encoding="utf-8"), text)
        self.assertEqual(fetcher.calls, [])

    def test_fetched_item_with_missing_file_is_requeued(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}])])
        run_stage(self.job, fetcher=FakeFetcher())
        (self.job / "fulltext" / "files" / "GSC-001.pdf").unlink()
        fetcher2 = FakeFetcher()
        code, _ = run_stage(self.job, fetcher=fetcher2, resume=True)
        self.assertEqual(code, 0)
        self.assertIn(("fetch_pdf", "https://example.org/a.pdf"), fetcher2.calls)
        self.assertTrue((self.job / "fulltext" / "files" / "GSC-001.pdf").exists())

    def test_limit_caps_this_run_and_keeps_rest_pending(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(page={"https://example.org/article": article_page()})
        code, events = run_stage(self.job, fetcher=fetcher, limit=1)
        self.assertEqual(code, 0)
        counts = read_status(self.job)["counts"]
        self.assertEqual(counts["fetched_pdf"], 1)
        self.assertEqual(counts["pending"], 2)
        self.assertEqual(events[-1]["counts"]["skipped"], 2)

    def test_max_papers_quota_from_config(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher()
        code, _ = run_stage(self.job, config={"version": 2, "fulltext": {"maxPapers": 1, "perPaperTimeoutSec": 120}}, fetcher=fetcher)
        self.assertEqual(code, 0)
        counts = read_status(self.job)["counts"]
        self.assertEqual(counts["fetched_pdf"], 1)
        self.assertEqual(counts["pending"], 2)

    def test_only_selects_single_paper(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(page={"https://example.org/article": article_page()})
        code, _ = run_stage(self.job, fetcher=fetcher, only=["GSC-002"])
        self.assertEqual(code, 0)
        items = status_map(read_status(self.job))
        self.assertEqual(items["GSC-001"]["status"], "pending")
        self.assertEqual(items["GSC-002"]["status"], "fetched_html")
        self.assertEqual(items["GSC-003"]["status"], "pending")

    def test_only_with_unknown_ids_fails(self) -> None:
        self._three_papers()
        code, events = run_stage(self.job, fetcher=FakeFetcher(), only="GSC-999")
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("不在候选清单", events[-1]["message"])

    def test_only_mixed_unknown_reports_and_continues(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(page={"https://example.org/article": article_page()})
        code, events = run_stage(self.job, fetcher=fetcher, only="GSC-002,GSC-999")
        self.assertEqual(code, 0)
        self.assertTrue(any("GSC-999" in event.get("message", "") for event in events if event["type"] == "stage"))
        self.assertEqual(status_map(read_status(self.job))["GSC-002"]["status"], "fetched_html")

    def test_missing_inputs_emit_error_exit_1(self) -> None:
        code, events = run_stage(self.job, fetcher=FakeFetcher())
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("尚未完成候选检索", events[-1]["message"])

    def test_browser_launch_failure_emits_error(self) -> None:
        self._three_papers()
        fetcher = FakeFetcher(ready={"status": "error", "message": "浏览器启动失败：chromium 未安装"})
        code, events = run_stage(self.job, fetcher=fetcher)
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("浏览器启动失败", events[-1]["message"])

    def test_invalid_fulltext_section_rejected(self) -> None:
        self._three_papers()
        code, events = run_stage(self.job, config={"version": 2, "fulltext": {"perPaperTimeoutSec": 1}}, fetcher=FakeFetcher())
        self.assertEqual(code, 1)
        self.assertIn("perPaperTimeoutSec", events[-1]["message"])

    def test_dedupe_input_drives_fetching(self) -> None:
        write_dedupe(self.job, [
            {"canonical_id": "GSC-001", "title": "归并后的论文", "doi": "10.1/x",
             "records": [candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/canonical.pdf"}])]},
            {"canonical_id": "GSC-002", "title": "第二篇", "doi": "",
             "records": [candidate("GSC-002", result_url="https://example.org/2")]},
        ])
        fetcher = FakeFetcher(page={"https://example.org/2": article_page("第二篇")})
        code, events = run_stage(self.job, fetcher=fetcher)
        self.assertEqual(code, 0)
        self.assertIn("去重结果", events[0]["message"])
        items = status_map(read_status(self.job))
        self.assertEqual(sorted(items), ["GSC-001", "GSC-002"])
        self.assertEqual(items["GSC-001"]["status"], "fetched_pdf")
        self.assertEqual(items["GSC-001"]["doi"], "10.1/x")
        self.assertEqual(items["GSC-002"]["status"], "fetched_html")

    def test_status_json_is_atomic_and_reparsable(self) -> None:
        self._three_papers()
        run_stage(self.job, fetcher=FakeFetcher(page={"https://example.org/article": article_page()}))
        leftover = list((self.job / "fulltext").glob("*.tmp"))
        self.assertEqual(leftover, [])
        read_status(self.job)  # raises if not valid JSON


# ---------------------------------------------------------------------------
# CLI (main)
# ---------------------------------------------------------------------------

class MainCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.job = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run_main(self, argv: list[str], fetcher: FakeFetcher | None = None):
        buffer = io.StringIO()
        factory = (lambda config, job_dir=None: fetcher) if fetcher is not None else lf.make_fetcher
        with patch.object(lf, "make_fetcher", factory), contextlib.redirect_stdout(buffer):
            code = lf.main(argv)
        lines = [json.loads(line) for line in buffer.getvalue().splitlines() if line.strip()]
        return code, lines

    def _config(self, **fulltext) -> Path:
        path = self.job / "run_config.json"
        path.write_text(json.dumps({"version": 2, "fulltext": fulltext or {"maxPapers": 0, "perPaperTimeoutSec": 120}}), encoding="utf-8")
        return path

    def test_main_emits_strict_ndjson(self) -> None:
        write_candidates(self.job, [candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}])])
        config = self._config()
        fetcher = FakeFetcher()
        code, lines = self._run_main(["--config", str(config), "--output-dir", str(self.job)], fetcher)
        self.assertEqual(code, 0)
        self.assertEqual(lines[0]["type"], "stage")
        self.assertEqual(lines[-1]["type"], "result")
        self.assertEqual(lines[-1]["stage"], "fulltext")
        for line in lines:
            self.assertIn(line["type"], {"stage", "attention", "error", "result"})
        self.assertTrue((self.job / "fulltext" / "status.json").exists())

    def test_main_resume_and_only_flags(self) -> None:
        write_candidates(self.job, [
            candidate("GSC-001", links=[{"label": "[PDF]", "url": "https://example.org/a.pdf"}]),
            candidate("GSC-002", links=[{"label": "[PDF]", "url": "https://example.org/b.pdf"}]),
        ])
        config = self._config()
        code, lines = self._run_main(["--config", str(config), "--output-dir", str(self.job), "--resume", "--only", "GSC-002"], FakeFetcher())
        self.assertEqual(code, 0)
        self.assertIn("继续", lines[0]["message"])
        self.assertTrue(any("GSC-002" in line.get("message", "") for line in lines))
        items = status_map(read_status(self.job))
        self.assertEqual(items["GSC-001"]["status"], "pending")
        self.assertEqual(items["GSC-002"]["status"], "fetched_pdf")

    def test_main_rejects_broken_config(self) -> None:
        write_candidates(self.job, [candidate("GSC-001")])
        config = self.job / "run_config.json"
        config.write_text("{broken", encoding="utf-8")
        code, lines = self._run_main(["--config", str(config), "--output-dir", str(self.job)], FakeFetcher())
        self.assertEqual(code, 1)
        self.assertEqual(lines[-1]["type"], "error")

    def test_main_rejects_invalid_limit_and_only(self) -> None:
        write_candidates(self.job, [candidate("GSC-001")])
        config = self._config()
        code, lines = self._run_main(["--config", str(config), "--output-dir", str(self.job), "--limit", "0"], FakeFetcher())
        self.assertEqual(code, 1)
        self.assertIn("--limit", lines[-1]["message"])
        code, lines = self._run_main(["--config", str(config), "--output-dir", str(self.job), "--only", " "], FakeFetcher())
        self.assertEqual(code, 1)
        self.assertIn("--only", lines[-1]["message"])


# ---------------------------------------------------------------------------
# Production task-page fetcher alias (detailed lifecycle tests in its own suite)
# ---------------------------------------------------------------------------

class ProductionFetcherAliasTest(unittest.TestCase):
    def test_alias_and_factory_use_dedicated_fetcher(self) -> None:
        from literature_fulltext_browser import FulltextBrowserFetcher
        self.assertIs(lf.SocBrowserFetcher, FulltextBrowserFetcher)
        with tempfile.TemporaryDirectory() as temp:
            fetcher = lf.make_fetcher({}, Path(temp))
            self.assertIsInstance(fetcher, FulltextBrowserFetcher)
            self.assertEqual(fetcher.job_dir, Path(temp).resolve())
            fetcher.close()


# ---------------------------------------------------------------------------
# Real localhost fixture (http.server; no external network)
# ---------------------------------------------------------------------------

class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args) -> None:  # keep the test output clean
        pass


class _ArticleFixtureParser(HTMLParser):
    """Local fixture adapter reads the actual article/heading/paragraph tree."""
    def __init__(self):
        super().__init__()
        self.inside = False
        self.title = ""
        self.tag = ""
        self.heading = ""
        self.sections = []
        self.parts = []
        self.current = []

    def _flush(self):
        if self.heading:
            self.sections.append({"heading": self.heading, "text": " ".join(self.current).strip()})
        self.current = []

    def handle_starttag(self, tag, attrs):
        self.tag = tag
        if tag == "article":
            self.inside = True
        if self.inside and tag == "h2":
            self._flush()
            self.heading = ""

    def handle_data(self, data):
        if not self.inside or not data.strip():
            return
        self.parts.append(data.strip())
        if self.tag == "h1":
            self.title += data.strip()
        elif self.tag == "h2":
            self.heading += data.strip()
        else:
            self.current.append(data.strip())

    def handle_endtag(self, tag):
        if tag == "article":
            self._flush()
            self.inside = False
        self.tag = ""

    def evidence(self):
        return {"origin": "dom_article_region", "container_verified": bool(self.parts),
                "container": "article", "citation_title": self.title, "page_title": self.title,
                "article_text": "\n".join(self.parts), "sections": self.sections}


class UrllibFixtureFetcher:
    """Test-only fetcher over a real local HTTP server (proxy-free urllib)."""

    def __init__(self, timeout: float = 5.0) -> None:
        import urllib.request

        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.timeout = timeout

    def _get(self, url: str):
        import urllib.request

        with self._opener.open(urllib.request.Request(url), timeout=self.timeout) as response:
            return response.headers.get("content-type", ""), response.read()

    def ensure_ready(self) -> dict:
        return {"status": "ok"}

    def fetch_pdf(self, url: str, out_path: Path, opts: dict) -> dict:
        try:
            _, blob = self._get(url)
        except Exception as exc:
            return {"status": "nav_error", "error": str(exc)}
        ok, why, size = lf.validate_pdf_bytes(blob)
        if not ok:
            return {"status": why}
        Path(out_path).write_bytes(blob)
        return {"status": "saved", "path": str(out_path), "size": size}

    def fetch_page(self, url: str, opts: dict) -> dict:
        try:
            content_type, blob = self._get(url)
        except Exception as exc:
            return {"status": "nav_error", "error": str(exc), "url": url}
        if "pdf" in content_type.lower():
            return {"status": "pdf_page", "url": url, "bytes": blob}
        html = blob.decode("utf-8", errors="replace")
        parser = _ArticleFixtureParser()
        parser.feed(html)
        return {"status": "ok", "text": html, "url": url, "html_evidence": parser.evidence()}


class LocalHttpFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name) / "site"
        root.mkdir(parents=True)
        page = article_page("论文 GSC-002")
        sections = "".join(f"<section><h2>{s['heading']}</h2><p>{s['text']}</p></section>"
                           for s in page["html_evidence"]["sections"])
        (root / "article.html").write_text(
            "<html><body><nav>Site navigation</nav><article><h1>论文 GSC-002</h1>" + sections + "</article></body></html>", encoding="utf-8"
        )
        (root / "paper.pdf").write_bytes(fake_pdf_bytes())
        (root / "paywall.html").write_text(
            "<html><body>Purchase this article to continue reading. Abstract teaser only.</body></html>", encoding="utf-8"
        )
        handler = functools.partial(_QuietHandler, directory=str(root))
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.dead = socket.socket()
        cls.dead.bind(("127.0.0.1", 0))
        cls.dead_port = cls.dead.getsockname()[1]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.dead.close()
        cls.temp.cleanup()

    def test_three_url_classes_over_localhost_fixture(self) -> None:
        base = f"http://127.0.0.1:{self.port}"
        dead = f"http://127.0.0.1:{self.dead_port}"
        with tempfile.TemporaryDirectory() as temp:
            job = Path(temp)
            write_candidates(job, [
                candidate("GSC-001", links=[{"label": "[PDF]", "url": f"{base}/paper.pdf"}]),
                candidate("GSC-002", result_url=f"{base}/article.html"),
                candidate("GSC-003", result_url=f"{base}/missing.html"),
                candidate("GSC-004", result_url=f"{base}/paywall.html"),
                candidate("GSC-005", result_url=f"{dead}/paper.pdf"),
            ])
            code, events = run_stage(job, fetcher=UrllibFixtureFetcher())
            self.assertEqual(code, 0)
            doc = read_status(job)
            items = status_map(doc)

            self.assertEqual(items["GSC-001"]["status"], "fetched_pdf")
            self.assertEqual(items["GSC-001"]["kind"], "pdf")
            self.assertTrue((job / items["GSC-001"]["path"]).read_bytes().startswith(b"%PDF"))

            self.assertEqual(items["GSC-002"]["status"], "fetched_html")
            self.assertEqual(items["GSC-002"]["kind"], "html")
            self.assertTrue((job / items["GSC-002"]["path"]).exists())

            self.assertEqual(items["GSC-003"]["status"], "unavailable")
            self.assertIn("待补充", items["GSC-003"]["reason"])

            self.assertEqual(items["GSC-004"]["status"], "unavailable")
            self.assertIn("权限", items["GSC-004"]["reason"])

            self.assertEqual(items["GSC-005"]["status"], "unavailable")

            self.assertEqual({key: doc["counts"][key] for key in (
                "total", "fetched_pdf", "fetched_html", "abstract_only", "unavailable", "needs_attention", "pending")}, {
                "total": 5,
                "fetched_pdf": 1,
                "fetched_html": 1,
                "abstract_only": 0,
                "unavailable": 3,
                "needs_attention": 0,
                "pending": 0,
            })
            self.assertEqual(events[-1]["files"], ["fulltext/status.json", "fulltext/materials.json"])


if __name__ == "__main__":
    unittest.main()
