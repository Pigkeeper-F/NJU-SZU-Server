"""Conservative local full-text validation and reuse; never accesses the network.

Only status-backed files inside a task's fulltext/files directory qualify.
Paper identifiers are local to a task: cross-task matching uses bibliographic
identity, never candidate numbers, fuzzy titles or an isolated file name.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit
from contextlib import redirect_stderr

from literature_fulltext_evidence import verified_saved_html


PROOF_VERSION = "pdf-file-evidence-v1"
MIN_PDF_BYTES = 50 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024
FETCHED = {"fetched_pdf", "fetched_html"}
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
SHA = re.compile(r"[0-9a-f]{64}")


def _norm(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def _title(value):
    return "".join(character for character in _norm(value) if character.isalnum())


def _doi(value):
    text = _norm(value)
    text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi\s*:\s*)", "", text)
    return text if re.fullmatch(r"10\.\d{4,9}/\S+", text) else ""


def _authors(value):
    if isinstance(value, list):
        value = ";".join(str(entry.get("name") or "") if isinstance(entry, dict) else str(entry)
                         for entry in value)
    return _norm(value).strip(" ;；、") if isinstance(value, str) else ""


def _cnki_id(record):
    if record.get("source_key") != "cnki":
        return ""
    try:
        parsed = urlsplit(str(record.get("source_url") or record.get("result_url") or ""))
        if parsed.scheme != "https" or parsed.hostname != "kns.cnki.net":
            return ""
        if parsed.path.rstrip("/").casefold() not in {"/kcms2/article/abstract", "/kcms/detail/detail.aspx"}:
            return ""
        query = {key.casefold(): values for key, values in parse_qs(parsed.query).items()}
        values = [query.get(key, []) for key in ("dbcode", "dbname", "filename")]
        if any(len(value) != 1 or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,100}", value[0]) for value in values):
            return ""
        return ":".join(value[0].casefold() for value in values)
    except (TypeError, ValueError):
        return ""


def identity(record):
    year = record.get("year")
    year = str(year).strip() if not isinstance(year, bool) else ""
    return {"doi": _doi(record.get("doi")), "cnki_id": _cnki_id(record),
            "title": _title(record.get("title")),
            "year": year if re.fullmatch(r"\d{4}", year) else "",
            "authors": _authors(record.get("authors"))}


def match_identity(left, right):
    """Return a strong matching reason, or empty for conflict/insufficient proof."""
    if left.get("doi") and right.get("doi") and left["doi"] != right["doi"]:
        return ""
    if left.get("cnki_id") and right.get("cnki_id") and left["cnki_id"] != right["cnki_id"]:
        return ""
    if left.get("doi") and left["doi"] == right.get("doi"):
        return "doi_exact"
    if left.get("cnki_id") and left["cnki_id"] == right.get("cnki_id"):
        return "cnki_document_exact"
    if (len(left.get("title", "")) >= 8 and left.get("title") == right.get("title")
        and left.get("year") and left["year"] == right.get("year")
        and len(left.get("authors", "")) >= 2 and left["authors"] == right.get("authors")):
        return "title_year_authors_exact"
    return ""


def _reparse(path):
    try:
        info = path.lstat()
        return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0)
                                         & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))
    except OSError:
        return False


def contained_file(job_dir, relative, *, cache=False):
    """Reject traversal, links and reparse directories before reading a file."""
    base = Path(job_dir).absolute()
    raw = Path(str(relative or ""))
    if raw.is_absolute() or not raw.parts or any(part in {"..", "."} for part in raw.parts):
        return None
    if cache and tuple(part.casefold() for part in raw.parts[:2]) != ("fulltext", "files"):
        return None
    current = base
    if _reparse(base) or _reparse(base.parent):
        return None
    try:
        for part in raw.parts:
            current = current / part
            if _reparse(current):
                return None
        resolved = current.resolve()
        resolved.relative_to(base.resolve())
        return current if current.is_file() else None
    except (OSError, ValueError):
        return None


def _result(status, reason, **values):
    return {"status": status, "reason": reason, **values}


def _pdf_text_check(blob, expected):
    try:
        from pypdf import PdfReader
    except ImportError:
        return _result("unavailable", "本地尚无PDF解析依赖，不能核验既有文件；请补齐依赖或人工核查，不会重新下载。")
    try:
        # Duplicate dictionary keys in an otherwise readable CNKI PDF are not
        # truncation. Do not use strict=True or expose parser diagnostics.
        with redirect_stderr(io.StringIO()):
            reader = PdfReader(io.BytesIO(blob), strict=False)
            if reader.is_encrypted and not reader.decrypt(""):
                return _result("unavailable", "既有PDF需要密码，暂不能核验；保留原件，请人工核查，不会重新下载。")
            pages = len(reader.pages)
            if not 1 <= pages <= 10000:
                return _result("invalid", "既有PDF页数无法核验，保留原件，请人工核查。")
            text = "\n".join((reader.pages[index].extract_text() or "")[:200000]
                              for index in range(min(3, pages)))
    except Exception as error:
        if type(error).__name__ in {"DependencyError", "FileNotDecryptedError"}:
            return _result("unavailable", "本地PDF加密解析依赖不足或文件暂不可读；请补齐依赖或人工核查，不会重新下载。")
        return _result("invalid", "既有PDF结构暂未通过本地校验；保留原件，请人工核查，不会直接认定文件截断。")
    wanted = expected.get("doi") or ""
    title = expected.get("title") or ""
    doi_matches = bool(wanted and wanted in _norm(text))
    title_matches = bool(len(title) >= 8 and title in _title(text))
    if not (doi_matches or title_matches):
        return _result("unavailable", "既有PDF可读，但尚不能核对为目标文献；请人工核查，不会将同名文件直接复用。",
                       pages=pages, text_chars=len(text.strip()))
    return _result("valid", "已核对PDF结构与目标文献正文身份。", pages=pages,
                   text_chars=len(text.strip()),
                   identity_method="pdf_text_doi" if doi_matches else "pdf_text_title")


def pdf_proof(blob, record, *, cnki_navigation=False):
    """Evidence recorded only for a newly received complete browser artifact."""
    expected = identity(record)
    checked = _pdf_text_check(blob, expected)
    method = checked.get("identity_method") or ("cnki_normal_navigation" if cnki_navigation else "candidate_entry_unverified")
    return {"version": PROOF_VERSION, "sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob),
            "pdf_magic": blob.startswith(b"%PDF"), "eof_marker": b"%%EOF" in blob[-2048:],
            "transfer_completed": True, "identity": expected, "identity_method": method,
            "parser_status": checked["status"],
            **({"pages": checked["pages"]} if checked.get("pages") else {}),
            **({"text_chars": checked["text_chars"]} if checked.get("text_chars") is not None else {})}


def inspect_saved(job_dir, item, record, *, for_reuse=False):
    path = contained_file(job_dir, item.get("path"), cache=True)
    if path is None:
        raw = Path(str(item.get("path") or ""))
        base = Path(job_dir).absolute()
        candidate_path = base / raw
        safe_missing = (not raw.is_absolute() and len(raw.parts) >= 3
                        and tuple(part.casefold() for part in raw.parts[:2]) == ("fulltext", "files")
                        and ".." not in raw.parts and not _reparse(base) and not _reparse(base.parent))
        current = base
        if safe_missing:
            for part in raw.parts:
                current = current / part
                if _reparse(current):
                    safe_missing = False
                    break
        if safe_missing and not candidate_path.exists():
            return _result("invalid", "上次保存的全文文件已缺失，可以按原任务重新获取。", missing_file=True)
        return _result("invalid", "已保存全文缺失或路径无法安全核验；保留已有记录，请人工核查。")
    try:
        size = path.stat().st_size
        if not 0 < size <= MAX_FILE_BYTES:
            return _result("invalid", "已保存全文的文件大小无法核验；保留原件，请人工核查。")
        blob = path.read_bytes()
    except OSError:
        return _result("unavailable", "本地全文文件暂不可读；保留原件，请稍后核查，不会重新下载。")
    digest = hashlib.sha256(blob).hexdigest()
    recorded_size = item.get("size")
    if type(recorded_size) is int and recorded_size > 0 and recorded_size != len(blob):
        return _result("invalid", "本地全文大小与保存记录不符；保留原件，请人工核查。")
    proof = item.get("pdf_evidence") if isinstance(item.get("pdf_evidence"), dict) else {}
    hashes = [value for value in (item.get("content_sha256"), item.get("observed_content_sha256"), proof.get("sha256")) if value is not None]
    if any(not isinstance(value, str) or not SHA.fullmatch(value) or value != digest for value in hashes):
        return _result("invalid", "本地全文与已记录SHA256不符；保留原件，请人工核查。")
    if item.get("status") == "fetched_html":
        try:
            text = blob.decode("utf-8")
        except UnicodeError:
            return _result("invalid", "已保存网页正文不是可核验的UTF-8文本；保留原件，请人工核查。")
        verified = dict(item)
        verified.update(title=record.get("title") or item.get("title"), doi=record.get("doi") or item.get("doi"))
        valid, reason = verified_saved_html(verified, text)
        if not valid:
            return _result("invalid", reason)
        return _result("valid", "已核对网页正文证据与SHA256。", blob=blob, sha256=digest, size=len(blob), kind="html")
    if item.get("status") != "fetched_pdf":
        return _result("invalid", "记录并未确认取得全文，不能复用摘要或独立文件。")
    if len(blob) < MIN_PDF_BYTES or not blob.startswith(b"%PDF") or b"%%EOF" not in blob[-2048:]:
        return _result("invalid", "已保存PDF未通过文件头、大小及结束标记校验；保留原件，请人工核查。")
    if not for_reuse:
        # A same-task resume retains the existing acquisition record after a
        # bounded file check. A newly observed digest is not historical proof
        # and does not remove the stricter cross-task parser requirement.
        return _result("valid", "同任务PDF已核对路径、大小、已有摘要与结束标记。", blob=blob,
                       sha256=digest, size=len(blob), kind="pdf", observed_sha256=not bool(hashes))
    expected = identity(record)
    proven_identity = proof.get("identity") if isinstance(proof.get("identity"), dict) else {}
    proof_matches = (proven_identity.get("title") == expected.get("title") and bool(expected.get("title"))
                     and not any(proven_identity.get(key) and expected.get(key)
                                 and proven_identity[key] != expected[key] for key in ("doi", "cnki_id")))
    if (proof.get("version") == PROOF_VERSION and proof.get("sha256") == digest
        and proof.get("size") == len(blob) and proof.get("pdf_magic") is True
        and proof.get("eof_marker") is True and proof.get("transfer_completed") is True
        and proof.get("parser_status") in {"valid", "unavailable"}
        and proof.get("identity_method") in {"cnki_normal_navigation", "pdf_text_doi", "pdf_text_title"}
        and proof_matches):
        return _result("valid", "已核对PDF保存证据、身份与SHA256。", blob=blob, sha256=digest, size=len(blob), kind="pdf", pdf_evidence=copy.deepcopy(proof))
    checked = _pdf_text_check(blob, expected)
    if checked["status"] != "valid":
        return checked
    evidence = {"version": PROOF_VERSION, "sha256": digest, "size": len(blob), "pdf_magic": True,
                "eof_marker": True, "transfer_completed": True, "identity": expected,
                "identity_method": checked["identity_method"], "pages": checked["pages"], "parser_status": "valid"}
    return _result("valid", checked["reason"], blob=blob, sha256=digest, size=len(blob), kind="pdf", pdf_evidence=evidence)


def _read_json(job, relative):
    file = contained_file(job, relative)
    if file is None:
        return None
    try:
        return json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _copy_artifact(job, paper_id, checked):
    folder = Path(job) / "fulltext" / "files"
    if _reparse(Path(job)) or _reparse(Path(job).parent) or _reparse(folder.parent) or _reparse(folder):
        raise ValueError("Unsafe task artifact directory")
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^0-9A-Za-z._-]+", "_", paper_id).strip("._")[:80] or "paper"
    extension = "pdf" if checked["kind"] == "pdf" else "txt"
    destination = folder / f"{stem}.{extension}"
    if destination.exists():
        safe = contained_file(job, str(destination.relative_to(job)), cache=True)
        if safe is not None and hashlib.sha256(safe.read_bytes()).hexdigest() == checked["sha256"]:
            return destination.relative_to(job).as_posix()
        destination = folder / f"{stem}.reused-{checked['sha256'][:16]}.{extension}"
        if destination.exists():
            safe = contained_file(job, str(destination.relative_to(job)), cache=True)
            if safe is None or hashlib.sha256(safe.read_bytes()).hexdigest() != checked["sha256"]:
                raise ValueError("Existing local artifact must not be overwritten")
            return destination.relative_to(job).as_posix()
    if _reparse(destination):
        raise ValueError("Unsafe task artifact file")
    descriptor, name = tempfile.mkstemp(prefix=".reuse-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(checked["blob"])
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, destination)
    finally:
        Path(name).unlink(missing_ok=True)
    return destination.relative_to(job).as_posix()


def artifact_destination(job, paper_id, extension):
    """Allocate a fresh received-artifact name without replacing an old file."""
    job = Path(job).absolute()
    folder = job / "fulltext" / "files"
    if extension not in {"pdf", "txt"} or any(_reparse(path) for path in (job.parent, job, folder.parent, folder)):
        raise ValueError("Unsafe full-text destination")
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^0-9A-Za-z._-]+", "_", str(paper_id)).strip("._")[:80] or "paper"
    destination = folder / f"{stem}.{extension}"
    if destination.exists() or _reparse(destination):
        destination = folder / f"{stem}.received-{uuid.uuid4().hex}.{extension}"
    return destination


class ReuseCatalog:
    def __init__(self, job_dir, targets, load_targets):
        self.job_dir = Path(job_dir).absolute()
        self.load_targets = load_targets
        self.entries = []
        self._add_job(self.job_dir, targets)
        if not _reparse(self.job_dir.parent):
            for folder in sorted(self.job_dir.parent.iterdir(), key=lambda value: value.name):
                if folder == self.job_dir or not UUID.fullmatch(folder.name) or not folder.is_dir() or _reparse(folder):
                    continue
                metadata = _read_json(folder, "job.json")
                if not isinstance(metadata, dict) or metadata.get("deletedAt") or metadata.get("status") in {"running", "preparing"}:
                    continue
                config = _read_json(folder, "run_config.json")
                if not isinstance(config, dict):
                    continue
                inputs = ("dedupe/dedupe.json",) if (folder / "dedupe/dedupe.json").exists() else ("candidates.json",)
                if any(contained_file(folder, relative) is None for relative in inputs):
                    continue
                try:
                    self._add_job(folder, load_targets(folder, config))
                except (OSError, ValueError, KeyError):
                    continue

    def _add_job(self, folder, targets):
        status = _read_json(folder, "fulltext/status.json")
        if not isinstance(status, dict):
            return
        by_id = {target["paper_id"]: target for target in targets}
        for item in status.get("items", []):
            if not isinstance(item, dict) or item.get("status") not in FETCHED:
                continue
            target = by_id.get(item.get("paper_id"))
            if not target or target.get("reuse_disabled"):
                continue
            # Status and original source metadata must describe the same title
            # and cannot contradict a DOI. A file name alone is never enough.
            if _title(item.get("title")) != _title(target.get("title")):
                continue
            if _doi(item.get("doi")) and _doi(target.get("doi")) and _doi(item.get("doi")) != _doi(target.get("doi")):
                continue
            self.entries.append((Path(folder), copy.deepcopy(target), copy.deepcopy(item)))

    def register(self, target, item):
        if item.get("status") in FETCHED and not target.get("reuse_disabled"):
            self.entries.append((self.job_dir, copy.deepcopy(target), copy.deepcopy(item)))

    def try_reuse(self, target, skeleton):
        if target.get("reuse_disabled"):
            return {"status": "no_match"}
        expected = identity(target)
        blocked = None
        for source_job, source_target, source_item in list(self.entries):
            same_item = source_job == self.job_dir and source_target["paper_id"] == target["paper_id"]
            reason = "same_task_record" if same_item and identity(source_target) == expected else match_identity(identity(source_target), expected)
            if not reason:
                continue
            checked = inspect_saved(source_job, source_item, source_target, for_reuse=True)
            if checked["status"] != "valid":
                if checked.get("missing_file"):
                    continue
                blocked = blocked or checked
                continue
            try:
                relative = _copy_artifact(self.job_dir, str(target["paper_id"]), checked)
            except (OSError, ValueError):
                blocked = _result("unavailable", "既有全文已找到，但本任务无法安全保存副本；保留原件，请人工核查。")
                continue
            item = copy.deepcopy(skeleton)
            for key in ("kind", "status", "retrieved_at", "evidence_level", "evidence_version", "html_evidence", "fulltext_url"):
                if key in source_item:
                    item[key] = copy.deepcopy(source_item[key])
            item.update(path=relative, size=checked["size"], content_sha256=checked["sha256"], reason="")
            if checked.get("pdf_evidence"):
                item["pdf_evidence"] = checked["pdf_evidence"]
            item["reused_from"] = {"job_id": source_job.name, "paper_id": source_target["paper_id"],
                "path": source_item["path"], "content_sha256": checked["sha256"], "identity_match": reason,
                "reused_at": datetime.now(timezone.utc).isoformat()}
            self.register(target, item)
            return {"status": "reused", "item": item}
        stem = re.sub(r"[^0-9A-Za-z._-]+", "_", str(target.get("paper_id") or "")).strip("._")[:80] or "paper"
        existing = self.job_dir / "fulltext" / "files" / f"{stem}.pdf"
        if blocked is None and (existing.exists() or existing.is_symlink()):
            blocked = _result("unavailable", "本任务已有尚未通过来源记录核验的同名PDF；请先核查本地文件，不会重新下载或覆盖原件。")
        return {"status": "blocked", "reason": blocked["reason"]} if blocked else {"status": "no_match"}
