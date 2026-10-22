"""Local reuse fixtures: no browser, network, real jobs or user files."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import literature_fulltext as fulltext
import literature_fulltext_reuse as reuse
from test_literature_fulltext import article_page, candidate, read_status, run_stage, write_candidates


OLD = "11111111-1111-4111-8111-111111111111"
NEW = "22222222-2222-4222-8222-222222222222"
TITLE = "Heat stress and growth performance in broiler chickens"


def real_pdf(title=TITLE):
    """A minimal readable one-page PDF with a real text stream and EOF/xref."""
    literal = title.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    content = (f"BT /F1 12 Tf 40 700 Td ({literal}) Tj 0 -20 Td (Methods and results. Author A. 2024.) Tj ET\n"
               + "%" + "padding " * 7000 + "\n").encode("ascii")
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    result, offsets = b"%PDF-1.4\n", [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(result))
        result += f"{index} 0 obj\n".encode() + value + b"\nendobj\n"
    start = len(result)
    result += f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode()
    result += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
    result += f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()
    return result


def row(paper="OLD-001", **extra):
    values = dict(title=TITLE, doi="10.1234/poultry.2024", year=2024,
                  authors="Author A; Author B", source_key="pubmed",
                  result_url="https://publisher.invalid/article")
    values.update(extra)
    return candidate(paper, **values)


def make_job(root, name, records, *, status="completed", deleted=False):
    job = Path(root) / name
    job.mkdir(parents=True)
    write_candidates(job, records)
    (job / "run_config.json").write_text(json.dumps({"version": 2}), encoding="utf-8")
    (job / "job.json").write_text(json.dumps({"id": name, "status": status,
                                              "deletedAt": "2026-10-20" if deleted else None}), encoding="utf-8")
    return job


def save_pdf(job, record, *, proof=False, blob=None):
    target = fulltext._target_from_candidate(record)
    item = fulltext._item_skeleton(target)
    blob = blob or real_pdf(record["title"])
    relative = f"fulltext/files/{record['candidate_id']}.pdf"
    (job / "fulltext/files").mkdir(parents=True, exist_ok=True)
    (job / relative).write_bytes(blob)
    item.update(status="fetched_pdf", kind="pdf", path=relative, size=len(blob),
                retrieved_at="2026-10-19T00:00:00Z", evidence_level="fulltext_pdf")
    if proof:
        item.update(content_sha256=hashlib.sha256(blob).hexdigest(),
                    pdf_evidence=reuse.pdf_proof(blob, target, cnki_navigation=True))
    fulltext._write_status(job, [item])
    return target, item


def snapshot(job):
    return {str(path.relative_to(job)): path.read_bytes() for path in job.rglob("*") if path.is_file()}


class NoBrowser:
    def __init__(self):
        self.ready = self.closed = 0

    def ensure_ready(self):
        self.ready += 1
        raise AssertionError("Local reuse must precede even browser connection")

    def close(self):
        self.closed += 1


class ReuseTests(unittest.TestCase):
    def fixture(self, root, *, old_extra=None, new_extra=None, proof=False):
        original = row(**(old_extra or {}))
        requested = row("NEW-007", **(new_extra or {}))
        old = make_job(root, OLD, [original])
        new = make_job(root, NEW, [requested])
        _, item = save_pdf(old, original, proof=proof)
        target = fulltext._target_from_candidate(requested)
        return old, new, target, item

    def test_legacy_pdf_is_verified_and_reused_before_browser_without_changing_source(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, _, _ = self.fixture(root)
            original = snapshot(old)
            browser = NoBrowser()
            code, events = run_stage(new, fetcher=browser)
            self.assertEqual(code, 0)
            self.assertEqual(browser.ready, 0)
            item = read_status(new)["items"][0]
            self.assertEqual(item["status"], "fetched_pdf")
            self.assertEqual(item["reused_from"]["job_id"], OLD)
            self.assertEqual(item["reused_from"]["paper_id"], "OLD-001")
            self.assertEqual(item["reused_from"]["identity_match"], "doi_exact")
            self.assertEqual((new / item["path"]).read_bytes(), (old / "fulltext/files/OLD-001.pdf").read_bytes())
            self.assertEqual(item["content_sha256"], item["reused_from"]["content_sha256"])
            self.assertEqual(item["pdf_evidence"]["identity_method"], "pdf_text_title")
            self.assertTrue(any("未重新下载" in event.get("message", "") for event in events))
            self.assertEqual(snapshot(old), original)

    def test_exact_title_year_authors_reuses_without_doi_but_not_title_alone(self):
        for authors, year, expected in (("Author A; Author B", 2024, "reused"), ("Other Author", 2024, "no_match"),
                                        ("Author A; Author B", 2023, "no_match"), ("", 2024, "no_match")):
            with self.subTest(authors=authors, year=year), tempfile.TemporaryDirectory() as root:
                old, new, target, _ = self.fixture(root, old_extra={"doi": ""},
                                                  new_extra={"doi": "", "authors": authors, "year": year})
                result = reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, fulltext._item_skeleton(target))
                self.assertEqual(result["status"], expected)
                if expected == "reused":
                    self.assertEqual(result["item"]["reused_from"]["identity_match"], "title_year_authors_exact")

    def test_doi_or_cnki_document_conflicts_reject_even_if_titles_match(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, target, _ = self.fixture(root, new_extra={"doi": "10.1234/another-paper"})
            result = reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})
            self.assertEqual(result["status"], "no_match")
        left = reuse.identity(row(source_key="cnki", result_url="https://kns.cnki.net/kcms2/article/abstract?dbcode=CJFQ&dbname=CJFD2024&filename=ARTICLE01"))
        right = reuse.identity(row(source_key="cnki", result_url="https://kns.cnki.net/kcms2/article/abstract?dbcode=CJFQ&dbname=CJFD2024&filename=ARTICLE02"))
        self.assertEqual(reuse.match_identity(left, right), "")
        right["cnki_id"] = left["cnki_id"]
        right["doi"] = ""
        self.assertEqual(reuse.match_identity(left, right), "cnki_document_exact")

    def test_missing_crypto_or_parser_blocks_matching_legacy_without_redownload(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, _, _ = self.fixture(root)
            original = snapshot(old)
            fetcher = NoBrowser()
            with patch.object(reuse, "_pdf_text_check", return_value={"status": "unavailable", "reason": "本地PDF加密解析依赖不足；请人工核查，不会重新下载。"}):
                code, events = run_stage(new, fetcher=fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.ready, 0)
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(events[-1]["reason"], "local_fulltext_verification")
            self.assertEqual(read_status(new)["items"][0]["status"], "needs_attention")
            self.assertFalse((new / "fulltext/files").exists())
            self.assertEqual(snapshot(old), original)

    def test_trusted_new_pdf_proof_can_reuse_without_parser_and_hash_tampering_cannot(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, target, item = self.fixture(root, proof=True)
            with patch.object(reuse, "_pdf_text_check", side_effect=AssertionError("recorded proof suffices")):
                reused = reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})
            self.assertEqual(reused["status"], "reused")
            file = old / item["path"]
            blob = file.read_bytes().replace(b"padding", b"paddinx", 1)
            file.write_bytes(blob)
            checked = reuse.inspect_saved(old, item, fulltext._target_from_candidate(row()), for_reuse=True)
            self.assertEqual(checked["status"], "invalid")
            self.assertIn("SHA256", checked["reason"])

    def test_running_deleted_probable_and_untracked_files_do_not_supply_reuse(self):
        for variation in ("running", "deleted", "probable", "abstract", "untracked"):
            with self.subTest(variation=variation), tempfile.TemporaryDirectory() as root:
                old, new, target, item = self.fixture(root, proof=True)
                if variation in {"running", "deleted"}:
                    meta = json.loads((old / "job.json").read_text(encoding="utf-8"))
                    meta.update(status="running" if variation == "running" else "completed",
                                deletedAt="2026-10-20" if variation == "deleted" else None)
                    (old / "job.json").write_text(json.dumps(meta), encoding="utf-8")
                elif variation == "probable":
                    target["reuse_disabled"] = True
                elif variation == "abstract":
                    item["status"] = "abstract_only"
                    fulltext._write_status(old, [item])
                else:
                    (old / "fulltext/status.json").unlink()
                before = snapshot(old)
                self.assertEqual(reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})["status"], "no_match")
                self.assertEqual(snapshot(old), before)

    def test_cache_traversal_and_reparse_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, target, item = self.fixture(root, proof=True)
            item["path"] = "../outside.pdf"
            fulltext._write_status(old, [item])
            self.assertEqual(reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})["status"], "blocked")
        with tempfile.TemporaryDirectory() as root:
            old, new, target, _ = self.fixture(root, proof=True)
            actual = reuse._reparse
            with patch.object(reuse, "_reparse", side_effect=lambda path: Path(path) == old or actual(path)):
                self.assertEqual(reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})["status"], "no_match")

    def test_existing_different_destination_is_preserved_when_copying_verified_artifact(self):
        with tempfile.TemporaryDirectory() as root:
            old, new, target, _ = self.fixture(root, proof=True)
            existing = new / "fulltext/files/NEW-007.pdf"
            existing.parent.mkdir(parents=True)
            existing.write_bytes(b"Existing file that must remain intact")
            reused = reuse.ReuseCatalog(new, [target], fulltext.load_targets).try_reuse(target, {})
            self.assertEqual(reused["status"], "reused")
            self.assertEqual(existing.read_bytes(), b"Existing file that must remain intact")
            self.assertIn(".reused-", reused["item"]["path"])

    def test_valid_html_body_reuses_with_proof_but_abstract_or_changed_body_does_not(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as root:
                source = row()
                old = make_job(root, OLD, [source])
                requested = row("NEW-007")
                new = make_job(root, NEW, [requested])
                target = fulltext._target_from_candidate(source)
                page = article_page(TITLE)
                item = fulltext._settle_html(fulltext._item_skeleton(target), old,
                    page["text"], "https://publisher.invalid/fulltext", "fulltext", "", page["html_evidence"])
                fulltext._write_status(old, [item])
                if corrupt:
                    (old / item["path"]).write_text("Abstract\n" + "Only a summary. " * 100, encoding="utf-8")
                current_target = fulltext._target_from_candidate(requested)
                result = reuse.ReuseCatalog(new, [current_target], fulltext.load_targets).try_reuse(current_target, {})
                self.assertEqual(result["status"], "blocked" if corrupt else "reused")
                if not corrupt:
                    self.assertEqual(result["item"]["status"], "fetched_html")
                    checked = reuse.inspect_saved(new, result["item"], current_target, for_reuse=True)
                    self.assertEqual(checked["status"], "valid")

    def test_same_task_legacy_resume_fast_check_does_not_require_crypto_or_claim_new_proof(self):
        with tempfile.TemporaryDirectory() as root:
            old = make_job(root, OLD, [row()])
            target, item = save_pdf(old, row())
            with patch.object(reuse, "_pdf_text_check", side_effect=AssertionError("not needed for same task carry")):
                carried = fulltext._carry_previous(target, item, old)
            self.assertEqual(carried["status"], "fetched_pdf")
            self.assertIn("observed_content_sha256", carried)
            self.assertNotIn("pdf_evidence", carried)
            self.assertNotIn("content_sha256", carried)
            # A later mutation is detected against the observed digest.
            file = old / item["path"]
            file.write_bytes(file.read_bytes().replace(b"padding", b"paddinx", 1))
            self.assertEqual(fulltext._carry_previous(target, carried, old)["status"], "needs_attention")

    def test_truncated_existing_pdf_pauses_without_replacing_or_downloading(self):
        with tempfile.TemporaryDirectory() as root:
            old = make_job(root, OLD, [row()])
            target, item = save_pdf(old, row())
            file = old / item["path"]
            file.write_bytes(file.read_bytes()[:-40])
            before = file.read_bytes()
            browser = NoBrowser()
            code, events = run_stage(old, fetcher=browser, resume=True)
            self.assertEqual(code, 0)
            self.assertEqual(browser.ready, 0)
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(file.read_bytes(), before)

    def test_orphan_same_named_pdf_is_not_reused_or_overwritten_and_opens_no_browser(self):
        with tempfile.TemporaryDirectory() as root:
            current = make_job(root, NEW, [row("CURRENT")])
            file = current / "fulltext/files/CURRENT.pdf"
            file.parent.mkdir(parents=True)
            file.write_bytes(real_pdf())
            before = file.read_bytes()
            browser = NoBrowser()
            code, events = run_stage(current, fetcher=browser)
            self.assertEqual(code, 0)
            self.assertEqual(browser.ready, 0)
            self.assertEqual(events[-1]["type"], "attention")
            self.assertEqual(file.read_bytes(), before)
            self.assertEqual(read_status(current)["items"][0]["status"], "needs_attention")

    def test_new_html_body_keeps_old_same_named_abstract_file(self):
        with tempfile.TemporaryDirectory() as root:
            current = make_job(root, NEW, [row("CURRENT")])
            file = current / "fulltext/files/CURRENT.txt"
            file.parent.mkdir(parents=True)
            file.write_bytes(b"Old summary remains available\n")
            target = fulltext._target_from_candidate(row("CURRENT"))
            page = article_page(TITLE)
            item = fulltext._settle_html(fulltext._item_skeleton(target), current, page["text"],
                                        "https://publisher.invalid/fulltext", "fulltext", "", page["html_evidence"])
            self.assertEqual(file.read_bytes(), b"Old summary remains available\n")
            self.assertIn(".received-", item["path"])
            self.assertNotEqual((current / item["path"]).read_bytes(), file.read_bytes())

    def test_same_batch_second_strong_duplicate_reuses_first_without_extra_fetch(self):
        with tempfile.TemporaryDirectory() as root:
            records = [row("FIRST"), row("SECOND")]
            current = make_job(root, NEW, records)
            class Fetcher:
                def __init__(self):
                    self.fetches = self.completed = 0
                def ensure_ready(self):
                    return {"status": "ok"}
                def fetch_page(self, url, opts):
                    self.fetches += 1
                    return {"status": "pdf_page", "bytes": real_pdf(), "url": url}
                def complete_paper(self):
                    self.completed += 1
                def close(self):
                    pass
            fetcher = Fetcher()
            code, _ = run_stage(current, fetcher=fetcher)
            self.assertEqual(code, 0)
            self.assertEqual(fetcher.fetches, 1)
            self.assertEqual(fetcher.completed, 1)
            items = read_status(current)["items"]
            self.assertEqual(len(items), 2)
            self.assertEqual(items[1]["reused_from"]["paper_id"], "FIRST")
            self.assertEqual(items[1]["reused_from"]["job_id"], NEW)


if __name__ == "__main__":
    unittest.main()
