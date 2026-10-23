"""Sequential full-text acquisition with task-owned browser pages.

The frozen candidates/dedupe input is kept unchanged. Only a validated PDF or
identified article body counts as full text; metadata and abstracts are not
accepted based on page length. HTML body proof and exact-file digests protect
resume and extraction from old incorrectly labeled caches.

One task page is reused while resolving a paper. After a confirmed file and
its status are saved, the task page closes. Browser login/access/rate/page
errors normally stop the batch and leave that page for the researcher. The
explicit --skip-unavailable policy records remote access gaps and moves on;
local file/evidence failures still pause. Requests use a
fixed conservative interval; file downloads wait for the actual browser
artifact, under the outer stage budget and explicit stop control.

--review-only rechecks saved caches offline, preserving their files and the
original status backup. --open-current only foregrounds an existing task page.
Neither operation searches or downloads anything.

Outputs: fulltext/status.json, fulltext/files/*, and optional fulltext/review.json.
NDJSON events end in result, attention, or error. The persistent research
browser and unrelated tabs remain owned by the researcher.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from literature_fulltext_evidence import (EVIDENCE_VERSION, assess_html, revalidate_saved_html, verified_saved_html)
from literature_fulltext_browser import FulltextBrowserFetcher
from literature_fulltext_reuse import ReuseCatalog, inspect_saved, pdf_proof, artifact_destination
from literature_materials import MaterialsStore, MaterialsError
from literature_material_collection import MaterialCollection

ROOT = Path(__file__).resolve().parents[1]
SOC_FETCH = ROOT / "SOC-database-pipeline-clean" / ".codex" / "skills" / "soc-paper-fetch" / "scripts"

STATUS_ORDER = ["fetched_pdf", "fetched_html", "abstract_only", "unavailable", "needs_attention", "pending"]
FETCHED_STATUSES = {"fetched_pdf", "fetched_html"}
RETRYABLE_ON_RESUME = {"pending", "needs_attention"}
GATED_ON_RESUME = {"unavailable", "abstract_only"}

MIN_PDF_BYTES = 50 * 1024  # %PDF magic + >=50KB, same thresholds as SOC download_pdf
HTML_MIN_TEXT_CHARS = 300
HTML_MIN_FULLTEXT_CHARS = 2000

POLICY_TEXT = "正文优先原版PDF，保留网页正文；补充材料保留原格式并逐件核查，缺失标待补充，不可读明确登记。"

ATTENTION_VERIFICATION_MESSAGE = (
    "全文获取遇到人机验证。请在持久浏览器窗口中完成验证，然后点击继续或重跑本阶段；"
    "不会自动绕过验证码。"
)

# Conservative paywall / access-restriction markers. Access-restricted pages are
# recorded as unavailable (待补充); we never try to bypass them.
PAYWALL_MARKERS = [
    "付费墙",
    "购买全文",
    "购买此文章",
    "需订阅",
    "订阅后阅读",
    "登录后可读",
    "权限不足",
    "purchase this article",
    "purchase access",
    "buy this article",
    "buy pdf",
    "rent this article",
    "get access",
    "access options",
    "institutional access",
    "sign in to continue",
    "sign in to view",
    "subscribers only",
    "subscribe to read",
]

_STDOUT_UTF8 = False


class FulltextPause(Exception):
    """A real page issue: preserve the tab and stop the current batch."""

    def __init__(self, paper_id: str, url: str = "", *, reason="page_error", message="") -> None:
        super().__init__(message or reason)
        self.paper_id, self.url, self.reason = paper_id, safe_url(url), reason
        self.message = message or "全文页面需要核对，已暂停；已有成果保留，请查看原页面后继续。"


class CaptchaPause(FulltextPause):
    def __init__(self, paper_id: str, url: str = "") -> None:
        super().__init__(paper_id, url, reason="verification", message=ATTENTION_VERIFICATION_MESSAGE)


def emit(kind: str, **values: object) -> None:
    global _STDOUT_UTF8
    if not _STDOUT_UTF8 and hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass
        _STDOUT_UTF8 = True
    print(json.dumps({"type": kind, **values}, ensure_ascii=False), flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_url(value: object) -> str:
    if not isinstance(value, str):
        return ""
    parsed = urlparse(value.strip())
    return value.strip() if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _atomic_write(path: Path, write) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            write(stream)
        # Windows readers / security scanners may briefly deny replacing a
        # file they have open. Retry only those Windows sharing/access codes,
        # for 1.5s total; never remove or directly overwrite the old target.
        delays = (0.05, 0.1, 0.15, 0.2, 0.25, 0.25, 0.25, 0.25)
        for attempt in range(len(delays) + 1):
            try:
                os.replace(tmp_name, path)
                break
            except OSError as error:
                if getattr(error, "winerror", None) not in {5, 32, 33} or attempt == len(delays):
                    raise
                time.sleep(delays[attempt])
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, obj: object) -> None:
    def _write(stream) -> None:  # type: ignore[no-untyped-def]
        stream.write((json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))

    _atomic_write(path, _write)


def atomic_write_text(path: Path, text: str) -> None:
    _atomic_write(path, lambda stream: stream.write(text.encode("utf-8")))


def atomic_write_bytes(path: Path, blob: bytes) -> None:
    _atomic_write(path, lambda stream: stream.write(blob))


def _sanitize_stem(paper_id: str) -> str:
    stem = re.sub(r"[^0-9A-Za-z._-]+", "_", paper_id).strip("._")
    return (stem or "paper")[:80]


def _short(text: str, limit: int = 60) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# Target classification (§2.4.3 frozen priority)
# ---------------------------------------------------------------------------

def _url_looks_pdf(url: str) -> bool:
    if not url:
        return False
    return urlparse(url).path.lower().endswith(".pdf")


def _pmc_article_url(url: str) -> bool:
    parsed = urlparse(url)
    return ((parsed.hostname or "").lower() == "pmc.ncbi.nlm.nih.gov"
            and re.fullmatch(r"/articles/PMC[1-9]\d*/?", parsed.path, re.I) is not None)


def _pubmed_article_url(url: str) -> bool:
    parsed = urlparse(url)
    return ((parsed.hostname or "").lower() == "pubmed.ncbi.nlm.nih.gov"
            and re.fullmatch(r"/[1-9]\d*/?", parsed.path) is not None)


def _collect_links(record: dict) -> list[dict]:
    links: list[dict] = []
    for link in record.get("fulltext_links") or []:
        if not isinstance(link, dict):
            continue
        url = safe_url(link.get("url"))
        if url and not _supplement_link(link):
            links.append({"label": str(link.get("label") or "")[:100], "url": url})
    return links


def _supplement_link(link: dict) -> bool:
    if link.get("role") == "supplement" or link.get("kind") == "supplement":
        return True
    label = str(link.get("label") or link.get("text") or "")
    return bool(re.search(r"supplement(?:ary|al)?|supporting (?:information|material|data)|additional (?:file|material)|补充材料|附件", label, re.I))


def _observe_materials(result: dict, opts: dict, paper_id: str) -> None:
    discovery = result.get("material_discovery")
    callback = opts.get("on_material_discovery")
    if isinstance(discovery, dict) and callable(callback):
        attention = callback(discovery)
        if isinstance(attention, dict):
            _raise_page_attention(attention, paper_id, "")


def _checkpoint_main(item: dict, opts: dict) -> dict:
    callback = opts.get("on_main_saved")
    if callable(callback):
        callback(dict(item))
    return item


def _record_result_url(record: dict) -> str:
    """result_url of a raw candidate record, tolerant of normalized targets."""
    return safe_url(record.get("result_url") or record.get("source_url"))


def _cnki_transfer_url(url: str) -> bool:
    parsed = urlparse(url)
    return ((parsed.hostname or "").lower() == "bar.cnki.net"
            and parsed.path.rstrip("/").lower() == "/bar/download/order")


CNKI_ENTRY_MESSAGE = ("知网候选只有依赖原页面的下载中转链接，不能作为全文直链使用，已暂停；"
                      "请从知网正常检索或详情页核对单篇入口，或提供已下载的全文材料。")


def candidate_urls(record: dict) -> list[tuple[str, str]]:
    """Ordered (kind, url) attempt chain for one record, deduplicated.

    Accepts both raw candidate records (``result_url``) and normalized targets
    (``source_url``) so ``classify_target`` and ``fetch_one`` share one logic.
    A PubMed record with an observed PMC article link tries PMC first.
    """
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(kind: str, url: str) -> None:
        if _cnki_transfer_url(url):
            return  # A cached transfer is not a stable article/download URL.
        parsed = urlparse(url)
        if ((parsed.hostname or "").lower().endswith(".cnki.net")
                and parsed.path.rstrip("/").lower() == "/kcms2/article/abstract" and not parsed.query):
            return  # Missing article identity: never repeatedly open this 404 entry.
        if url and url not in seen:
            seen.add(url)
            out.append((kind, url))

    links = _collect_links(record)
    result_url = _record_result_url(record)
    if _pubmed_article_url(result_url):
        # PMC is the official full-text copy; a PubMed record is bibliographic
        # and must only be the fallback when its known PMC entry fails.
        for link in links:
            if _pmc_article_url(link["url"]):
                add("html", link["url"])
        add("html", result_url)
        for link in links:
            if not _pmc_article_url(link["url"]):
                add("pdf" if _url_looks_pdf(link["url"]) else "html", link["url"])
        return out
    for link in links:
        if _url_looks_pdf(link["url"]):
            add("pdf", link["url"])
    if _url_looks_pdf(result_url):
        add("pdf", result_url)
    if result_url:
        add("html", result_url)
    for link in links:
        if not _url_looks_pdf(link["url"]):
            add("html", link["url"])
    return out


def classify_target(record: dict) -> dict:
    """Classify one record: {"kind": pdf|html|abstract|none, "url", "reason"}."""
    attempts = candidate_urls(record)
    if attempts:
        kind, url = attempts[0]
        reasons = {
            "pdf": "fulltext_links/result_url 提供 PDF 直链",
            "html": "result_url 页面导航（HTML 正文优先）",
        }
        return {"kind": kind, "url": url, "reason": reasons.get(kind, "")}
    if str(record.get("snippet") or "").strip():
        return {"kind": "abstract", "url": "", "reason": "无合法全文入口，仅有检索片段"}
    return {"kind": "none", "url": "", "reason": "无合法全文入口"}


def assess_html_text(text: str, url: str = "", evidence=None, expected_title="", expected_doi="") -> tuple[str, str]:
    verdict, reason = assess_html(text, url=url, evidence=evidence, expected_title=expected_title, expected_doi=expected_doi)
    if verdict != "fulltext" and "待补充" not in reason:
        reason += "（全文待补充）"
    return verdict, reason


def validate_pdf_bytes(blob: bytes) -> tuple[bool, str, int]:
    """%PDF magic + >=50KB check (same thresholds as SOC download_pdf)."""
    if not blob:
        return False, "empty", 0
    if blob[:4] != b"%PDF":
        return False, "not_a_pdf", len(blob)
    if len(blob) < MIN_PDF_BYTES:
        return False, "too_small", len(blob)
    return True, "ok", len(blob)


# ---------------------------------------------------------------------------
# Real fetcher: persistent CDP browser + SOC scripts (A-tier reuse)
# ---------------------------------------------------------------------------

# Backwards import name retained for callers; all production fetching now uses
# one task-bound page rather than SOC's blank-page-only helper.
SocBrowserFetcher = FulltextBrowserFetcher


def make_fetcher(config: dict, job_dir: Path | None = None) -> FulltextBrowserFetcher:
    return FulltextBrowserFetcher(config, job_dir, on_progress=lambda message: emit("stage", stage="fulltext", message=message))


# ---------------------------------------------------------------------------
# Input loading (candidates.json / dedupe.json)
# ---------------------------------------------------------------------------

def _target(paper_id: str, title: str, doi: str, source_url: str, links: list[dict], snippet: str) -> dict:
    return {
        "paper_id": paper_id,
        "title": str(title or "")[:500],
        "doi": str(doi or "").strip().lower(),
        "source_url": source_url,
        "fulltext_links": links,
        "snippet": str(snippet or "").strip()[:2000],
    }


def _target_from_candidate(record: dict) -> dict | None:
    paper_id = str(record.get("canonical_id") or record.get("candidate_id") or "").strip()
    if not paper_id:
        return None
    target = _target(
        paper_id,
        record.get("title"),
        record.get("doi"),
        safe_url(record.get("result_url")),
        _collect_links(record),
        record.get("snippet"),
    )
    target.update(source_key=str(record.get("source_key") or ""),
                  source_candidate_id=str(record.get("candidate_id") or ""),
                  year=record.get("year"), authors=record.get("authors") or "",
                  reuse_disabled=bool(record.get("reuse_disabled")))
    return target


def _target_from_group(group: dict) -> dict | None:
    canonical_id = str(group.get("canonical_id") or "").strip()
    if not canonical_id:
        return None
    records = [r for r in group.get("records") or [] if isinstance(r, dict)]
    source = next((r for r in records if str(r.get("candidate_id") or "") == canonical_id), records[0] if records else {})
    title = group.get("title") or source.get("title")
    doi = group.get("doi") or source.get("doi")
    target = _target(
        canonical_id,
        title,
        doi,
        safe_url(source.get("result_url")),
        _collect_links(source),
        source.get("snippet"),
    )
    target.update(source_key=str(source.get("source_key") or ""),
                  source_candidate_id=str(source.get("candidate_id") or ""),
                  year=group.get("year") or source.get("year"), authors=source.get("authors") or "",
                  reuse_disabled=bool(group.get("needs_review") or group.get("merge_confidence") == "probable"))
    return target


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"[literature_fulltext] 无法解析 {path.name}：{error}", file=sys.stderr)
        return None


def load_targets(job_dir: Path, config: dict) -> list[dict]:
    """Load fetch targets: dedupe groups preferred, candidates fallback."""
    job_dir = Path(job_dir)
    dedupe_path = job_dir / "dedupe" / "dedupe.json"
    if dedupe_path.exists():
        dedupe = _read_json(dedupe_path)
        if isinstance(dedupe, dict) and isinstance(dedupe.get("groups"), list):
            targets: list[dict] = []
            seen: set[str] = set()
            from literature_target_groups import expanded_target_groups
            for group in expanded_target_groups(dedupe["groups"]):
                if not isinstance(group, dict):
                    continue
                target = _target_from_group(group)
                if target and target["paper_id"] not in seen:
                    seen.add(target["paper_id"])
                    targets.append(target)
            return targets
    candidates_path = job_dir / "candidates.json"
    if candidates_path.exists():
        report = _read_json(candidates_path)
        if not isinstance(report, dict):
            raise ValueError("candidates.json 解析失败")
        records = report.get("records")
        if not isinstance(records, list):
            records = report.get("results") or []
        targets = []
        seen = set()
        skipped = 0
        for record in records:
            if not isinstance(record, dict):
                continue
            if str(record.get("screening_status") or "") == "auto_excluded_duplicate":
                skipped += 1
                continue
            key = str(record.get("canonical_id") or record.get("candidate_id") or "").strip()
            if not key or key in seen:
                if key:
                    skipped += 1
                continue
            target = _target_from_candidate(record)
            if target is None:
                continue
            seen.add(key)
            targets.append(target)
        if skipped:
            print(f"[literature_fulltext] 跳过 {skipped} 条重复/已排除候选", file=sys.stderr)
        return targets
    raise FileNotFoundError("尚未完成候选检索或去重：未找到 candidates.json 或 dedupe/dedupe.json")


# ---------------------------------------------------------------------------
# Single-paper fetch
# ---------------------------------------------------------------------------

def _item_skeleton(record: dict) -> dict:
    return {
        "paper_id": str(record.get("paper_id") or ""),
        "title": str(record.get("title") or ""),
        "doi": str(record.get("doi") or ""),
        "source_url": safe_url(record.get("source_url") or record.get("result_url")),
        "fulltext_url": "",
        "kind": "none",
        "status": "pending",
        "path": "",
        "size": 0,
        "retrieved_at": "",
        "evidence_level": "",
        "reason": "",
    }


def _settle_pdf(item: dict, out_path: Path, files_rel: str, url: str, size: int, record=None, *, cnki_navigation=False) -> dict:
    item.update(
        fulltext_url=url,
        kind="pdf",
        status="fetched_pdf",
        path=files_rel,
        size=size,
        retrieved_at=now_iso(),
        evidence_level="fulltext_pdf",
        reason="",
    )
    blob = out_path.read_bytes()
    item.update(content_sha256=hashlib.sha256(blob).hexdigest(),
                pdf_evidence=pdf_proof(blob, record or item, cnki_navigation=cnki_navigation))
    return item


def _raise_page_attention(result: dict, paper_id: str, url: str) -> None:
    if result.get("status") == "captcha":
        raise CaptchaPause(paper_id, result.get("url") or url)
    if result.get("status") == "attention":
        raise FulltextPause(paper_id, result.get("url") or url,
                            reason=str(result.get("reason") or "page_error"),
                            message=str(result.get("message") or ""))


def _settle_html(item, job_dir, text, url, verdict, reason, evidence):
    path = artifact_destination(job_dir, item["paper_id"], "txt")
    saved = text.strip() + "\n"
    atomic_write_text(path, saved)
    item.update(fulltext_url=safe_url(url), kind="html",
                status="fetched_html" if verdict == "fulltext" else "abstract_only",
                path=path.relative_to(Path(job_dir).absolute()).as_posix(), size=path.stat().st_size, retrieved_at=now_iso(),
                evidence_level="fulltext_html" if verdict == "fulltext" else "abstract_only", reason=reason)
    if verdict == "fulltext":
        # Keep structural proof, not a duplicate of the entire article/HTML.
        proof = {key: evidence.get(key) for key in
                 ("origin", "container", "container_verified", "page_title", "citation_title", "citation_doi", "headings")}
        proof["sections"] = [{"heading": str(section.get("heading") or "")[:300],
                               "text": str(section.get("text") or "")[:250]}
                              for section in (evidence.get("sections") or []) if isinstance(section, dict)]
        item.update(evidence_version=EVIDENCE_VERSION, html_evidence=proof,
                    content_sha256=hashlib.sha256(saved.encode("utf-8")).hexdigest())
    return item


def _settle_cnki_result(result, record, job_dir, item):
    """Use the same PDF/body evidence gate after normal official navigation."""
    _raise_page_attention(result, item["paper_id"], "")
    page_url = safe_url(result.get("url") or "")
    if result.get("status") == "pdf_page":
        blob = result.get("bytes") or b""
        valid, why, size = validate_pdf_bytes(blob)
        if not valid:
            raise FulltextPause(item["paper_id"], page_url, reason="page_error",
                                message="知网下载文件未通过PDF校验，已暂停；请在原页面核对文件格式。")
        path = artifact_destination(job_dir, item["paper_id"], "pdf")
        relative = path.relative_to(Path(job_dir).absolute()).as_posix()
        atomic_write_bytes(path, blob)
        return _settle_pdf(item, path, relative, page_url, size, record, cnki_navigation=True)
    if result.get("status") == "ok":
        proof = result.get("html_evidence") if isinstance(result.get("html_evidence"), dict) else {}
        text = str(result.get("text") or "")
        verdict, reason = assess_html_text(text, page_url, proof, record.get("title") or "", record.get("doi") or "")
        if verdict == "fulltext":
            return _settle_html(item, job_dir, str(proof.get("article_text") or text), page_url, verdict, reason, proof)
        raise FulltextPause(item["paper_id"], page_url, reason="page_error",
                            message="知网已打开页面，但尚未取得可确认的全文，已暂停；请核对下载入口和正文。")
    raise FulltextPause(item["paper_id"], page_url, reason="page_error",
                        message=str(result.get("message") or "知网单篇下载未完成，已暂停；请查看原任务页面。"))


def fetch_one(record: dict, out_dir: Path, opts: dict) -> dict:
    """Fetch one paper, following only its observed legal entry links.

    An abstract is retained as a fallback while observed full-text links are
    tried. Access/loading issues pause the batch, except that a failed PMC
    article entry may fall back to its paired PubMed bibliographic page.
    """
    fetcher, job_dir = opts["fetcher"], Path(out_dir)
    files_dir = job_dir / "fulltext" / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    paper_id = str(record.get("paper_id") or "")
    stem, item = _sanitize_stem(paper_id), _item_skeleton(record)
    existing_pdf = files_dir / f"{stem}.pdf"
    if existing_pdf.exists() or existing_pdf.is_symlink():
        raise FulltextPause(paper_id, reason="local_fulltext_verification",
                            message="本任务已有尚未通过来源记录核验的同名PDF，已暂停；请先核查本地文件，不会重新下载或覆盖原件。")
    opts = {**opts, "record": record}
    cached = opts.get("cached_main")
    html_main = dict(cached) if isinstance(cached, dict) and cached.get("status") == "fetched_html" else None
    if record.get("source_key") == "cnki" and callable(getattr(fetcher, "fetch_cnki", None)):
        result = fetcher.fetch_cnki(record, opts)
        saved = _checkpoint_main(_settle_cnki_result(result, record, job_dir, item), opts)
        _observe_materials(result, opts, paper_id)
        return saved
    attempts = candidate_urls(record)
    # Inspect the already observed landing page before leaving it for a PDF,
    # so supplementary files can be captured while their real links remain.
    source = _record_result_url(record)
    if callable(getattr(fetcher, "fetch_material", None)) and source and ("html", source) in attempts and not _url_looks_pdf(source):
        attempts = [("html", source), *[entry for entry in attempts if entry[1] != source]]
    if not attempts:
        if any(_cnki_transfer_url(link["url"]) for link in _collect_links(record)) or _cnki_transfer_url(_record_result_url(record)):
            raise FulltextPause(paper_id, reason="page_error", message=CNKI_ENTRY_MESSAGE)
        if str(record.get("snippet") or "").strip():
            item.update(kind="abstract", status="abstract_only", evidence_level="search_result_snippet",
                        reason="无合法全文入口，仅有检索片段（待补充）")
        else:
            missing_cnki = urlparse(_record_result_url(record)).path.rstrip("/").lower() == "/kcms2/article/abstract"
            item.update(status="unavailable", reason=("知网入口缺少单篇文献标识，请从官方页面补充有效入口（待补充）" if missing_cnki else "无合法全文入口（待补充）"))
        return item
    failures, seen, abstract = [], set(), None
    confirmed_html_this_run = False
    blocked_transfer = any(_cnki_transfer_url(link["url"]) for link in _collect_links(record))
    for kind, url in attempts:
        if url in seen:
            continue
        if len(seen) >= 8:
            break
        seen.add(url)
        if confirmed_html_this_run and kind == "html":
            continue  # Confirmed body: only try remaining PDF links, not PubMed metadata.
        if kind == "pdf":
            path = artifact_destination(job_dir, paper_id, "pdf")
            relative = path.relative_to(Path(job_dir).absolute()).as_posix()
            result = fetcher.fetch_pdf(url, path, opts)
            _raise_page_attention(result, paper_id, url)
            if result.get("status") in {"saved", "already_exists"}:
                if not _looks_like_valid_pdf(path):
                    failures.append("PDF 校验失败（需 %PDF 魔数且 ≥50KB）")
                    # Only this fetch attempt's invalid artifact is discarded.
                    if path.exists():
                        path.unlink(missing_ok=True)
                    continue
                saved = _checkpoint_main(_settle_pdf(item, path, relative, url, path.stat().st_size, record), opts)
                _observe_materials(result, opts, paper_id)
                return saved
            _observe_materials(result, opts, paper_id)
            failures.append(f"PDF 获取失败（{url}）：{result.get('status') or '未知'}")
            continue
        result = fetcher.fetch_page(url, opts)
        try:
            _raise_page_attention(result, paper_id, url)
        except FulltextPause as pause:
            if (_pmc_article_url(url) and _pubmed_article_url(source)
                    and pause.reason in {"access_required", "login", "page_error", "load_timeout"}
                    and any(candidate_url == source for _, candidate_url in attempts)):
                release = getattr(fetcher, "defer_paper", None)
                if callable(release):
                    release(reason=pause.reason, url=pause.url)
                failures.append(f"PMC 正文暂不可用：{pause.reason}")
                continue
            raise
        if result.get("status") == "pdf_page":
            blob = result.get("bytes") or b""
            valid, why, size = validate_pdf_bytes(blob)
            if not valid:
                failures.append(f"页面返回的 PDF 校验失败：{why}")
                continue
            path = artifact_destination(job_dir, paper_id, "pdf")
            atomic_write_bytes(path, blob)
            saved = _checkpoint_main(_settle_pdf(item, path, path.relative_to(Path(job_dir).absolute()).as_posix(), result.get("url") or url, size, record), opts)
            _observe_materials(result, opts, paper_id)
            return saved
        if result.get("status") == "ok":
            text, page_url = str(result.get("text") or ""), safe_url(result.get("url") or url)
            proof = result.get("html_evidence") if isinstance(result.get("html_evidence"), dict) else {}
            verdict, reason = assess_html_text(text, page_url, proof, record.get("title") or "", record.get("doi") or "")
            if verdict == "fulltext":
                confirmed_html_this_run = True
                if html_main is None:
                    html_main = _settle_html(dict(item), job_dir, str(proof.get("article_text") or text), page_url, verdict, reason, proof)
                    _checkpoint_main(html_main, opts)
            _observe_materials(result, opts, paper_id)
            if verdict == "abstract" and abstract is None:
                abstract = (str(proof.get("article_text") or text), page_url, verdict, reason, proof)
            # These are visible page links, never guessed database/session URLs.
            for link in (proof.get("links") or result.get("fulltext_links") or [])[:8]:
                if not isinstance(link, dict) or _supplement_link(link):
                    continue
                linked = safe_url(link.get("url"))
                if _cnki_transfer_url(linked):
                    # Following the extracted href with goto would lose its
                    # official click context. Do not simulate headers/tickets.
                    blocked_transfer = True
                    continue
                is_pdf = _url_looks_pdf(linked) or link.get("kind") == "pdf"
                if html_main is not None and not is_pdf:
                    continue  # Keep the confirmed body; seek only its original PDF.
                if linked and linked not in seen and all(other != linked for _, other in attempts):
                    attempts.append(("pdf" if is_pdf else "html", linked))
            if verdict == "unavailable":
                failures.append(f"页面不可用（{url}）：{reason}")
            continue
        _observe_materials(result, opts, paper_id)
        failures.append(f"页面导航失败（{url}）：{result.get('status') or '未知'}")
    if html_main is not None:
        return html_main
    if blocked_transfer:
        raise FulltextPause(paper_id, reason="page_error", message=CNKI_ENTRY_MESSAGE)
    if abstract:
        return _settle_html(item, job_dir, *abstract)
    reason = "；".join(failures)[:600] or "全部获取路径失败"
    item.update(status="unavailable", reason=reason if "待补充" in reason else reason + "（待补充）")
    return item


def _looks_like_valid_pdf(path: Path) -> bool:
    try:
        if path.stat().st_size < MIN_PDF_BYTES:
            return False
        with path.open("rb") as stream:
            return stream.read(4) == b"%PDF"
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Stage run
# ---------------------------------------------------------------------------

def _fulltext_options(config: dict) -> dict:
    section = config.get("fulltext") or {}
    if not isinstance(section, dict):
        raise ValueError("fulltext 配置无效")
    max_papers = section.get("maxPapers", 0)
    per_paper = section.get("perPaperTimeoutSec", 120)
    if not isinstance(max_papers, int) or max_papers < 0:
        raise ValueError("fulltext.maxPapers 无效")
    if not isinstance(per_paper, int) or not 5 <= per_paper <= 3600:
        raise ValueError("fulltext.perPaperTimeoutSec 无效")
    return {"max_papers": max_papers, "per_paper_timeout_sec": per_paper}


def _carry_previous(target: dict, prev: dict | None, job_dir: Path) -> dict:
    item = _item_skeleton(target)
    if not prev:
        return item
    for key in ("fulltext_url", "attempted_url", "kind", "status", "path", "size", "retrieved_at", "evidence_level", "reason", "evidence_version", "html_evidence", "content_sha256", "reviewed_at", "pdf_evidence", "reused_from", "observed_content_sha256", "local_verification", "acquisition_skip", "pause_reason"):
        if key in prev:
            item[key] = prev[key]
    if item["status"] == "fetched_html":
        path = _safe_cache_path(job_dir, item.get("path") or "")
        if path is not None:
            valid, reason = verified_saved_html(item, path.read_text(encoding="utf-8", errors="replace"))
            if not valid:
                item.update(status="unavailable", evidence_level="unverified_cache", reason=reason)
    if item["status"] == "fetched_pdf":
        checked = inspect_saved(job_dir, item, target, for_reuse=False)
        if checked.get("missing_file"):
            item.update(status="pending", kind="none", path="", size=0, retrieved_at="", evidence_level="",
                        fulltext_url="", reason="上次获取的文件缺失，已重新排队")
            for key in ("pdf_evidence", "content_sha256", "observed_content_sha256", "local_verification"):
                item.pop(key, None)
        elif checked["status"] != "valid":
            item.update(status="needs_attention", evidence_level="local_verification_required",
                        reason=checked["reason"], local_verification={"status": checked["status"], "reason": checked["reason"]})
        elif checked.get("observed_sha256"):
            item["observed_content_sha256"] = checked["sha256"]
    if item["status"] in FETCHED_STATUSES:
        rel = str(item.get("path") or "")
        if not rel or not (job_dir / rel).exists():
            item.update(
                status="pending",
                kind="none",
                path="",
                size=0,
                retrieved_at="",
                evidence_level="",
                fulltext_url="",
                reason="上次获取的文件缺失，已重新排队",
            )
    if item["status"] in {"needs_attention", "unavailable"}:
        # Old runs could put a failed (or stale previous-tab) URL here. It was
        # never verified as this paper's full text, so never carry it forward.
        item["fulltext_url"] = ""
    return item


def _load_previous_items(status_path: Path) -> dict[str, dict]:
    previous: dict[str, dict] = {}
    if not status_path.exists():
        return previous
    doc = _read_json(status_path)
    if not isinstance(doc, dict):
        return previous
    for item in doc.get("items") or []:
        if isinstance(item, dict) and str(item.get("paper_id") or ""):
            previous[str(item["paper_id"])] = item
    return previous


def _counts(items: list[dict]) -> dict:
    counts = {"total": len(items)}
    for status in STATUS_ORDER:
        counts[status] = sum(1 for item in items if item.get("status") == status)
    return counts


def _write_status(job_dir: Path, items: list[dict], *, materials=None) -> dict:
    counts = _counts(items)
    if any(item.get("acquisition_skip") for item in items):
        counts["acquisition_skipped"] = sum(bool(item.get("acquisition_skip")) for item in items)
        if materials is not None:
            counts["material_incomplete"] = sum(not materials.paper_ready(item) for item in items)
    doc = {
        "version": 1,
        "generated_at": now_iso(),
        "policy": POLICY_TEXT,
        "items": items,
        "counts": counts,
    }
    atomic_write_json(job_dir / "fulltext" / "status.json", doc)
    return counts


def _safe_cache_path(job_dir: Path, relative: str) -> Path | None:
    base = (job_dir / "fulltext" / "files").resolve()
    target = (job_dir / str(relative)).resolve()
    try:
        target.relative_to(base)
    except ValueError:
        return None
    return target if target.is_file() and not target.is_symlink() else None


def review_saved_fulltext(job_dir: Path, *, emit_result=True) -> dict:
    """Offline evidence review: keep every cached file and the original status."""
    job_dir = Path(job_dir)
    for name in ("extraction", "validation", "export"):
        folder = job_dir / name
        if folder.exists() and any(folder.rglob("*")):
            raise ValueError("已有下游提取/校验/导出成果，请先核对，不能自动复核改写全文依据")
    status_path = job_dir / "fulltext" / "status.json"
    original = status_path.read_bytes()
    document = json.loads(original.decode("utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("items"), list):
        raise ValueError("全文状态文件无效，无法复核")
    items, changes, reviewed = document["items"], [], 0
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("全文条目无效，无法复核")
        prior = str(item.get("status") or "")
        source = urlparse(str(item.get("source_url") or ""))
        if (prior == "unavailable" and (source.hostname or "").lower().endswith(".cnki.net")
                and source.path.rstrip("/").lower() == "/kcms2/article/abstract" and not source.query):
            # Diagnose the missing permanent entry offline. Keep the item gated:
            # a retry must not replay an old transfer or invent document IDs.
            if item.get("reason") != CNKI_ENTRY_MESSAGE or item.get("entry_required") is not True:
                item.update(reason=CNKI_ENTRY_MESSAGE, entry_required=True, reviewed_at=now_iso())
                changes.append({"paper_id": str(item.get("paper_id") or ""), "previous_status": prior,
                                "status": prior, "reason": CNKI_ENTRY_MESSAGE})
            continue
        if prior not in FETCHED_STATUSES | {"abstract_only"}:
            continue
        reviewed += 1
        path = _safe_cache_path(job_dir, item.get("path") or "")
        if path is None:
            verdict, reason = "unavailable", "已保存文件缺失或路径无效（待补充）"
        elif prior == "fetched_pdf":
            checked = inspect_saved(job_dir, item, item, for_reuse=False)
            if checked["status"] == "valid":
                continue
            verdict, reason = "unavailable", checked["reason"]
        else:
            text = path.read_text(encoding="utf-8", errors="replace")
            verdict, reason = revalidate_saved_html(item, text)
            if verdict == "fulltext" or (prior == "abstract_only" and verdict == "abstract"):
                continue
        item.update(status="abstract_only" if verdict == "abstract" else "unavailable",
                    evidence_level="abstract_only" if verdict == "abstract" else "unverified_cache",
                    reason=reason, reviewed_at=now_iso())
        changes.append({"paper_id": str(item.get("paper_id") or ""), "previous_status": prior,
                        "status": item["status"], "reason": reason})
    backup_name = "fulltext/backups/status-" + hashlib.sha256(original).hexdigest() + ".json"
    backup = job_dir / backup_name
    if not backup.exists():
        atomic_write_bytes(backup, original)
    counts = _write_status(job_dir, items)
    counts.update(reviewed=reviewed, changed=len(changes), fetched=counts["fetched_pdf"] + counts["fetched_html"])
    report = {"version": 1, "evidence_version": EVIDENCE_VERSION, "reviewed_at": now_iso(),
              "offline_only": True, "backup": backup_name, "counts": counts, "changes": changes,
              "note": "仅复核已保存文件；未访问网站、未重试下载。摘要和待补充项不自动重复请求。"}
    atomic_write_json(job_dir / "fulltext" / "review.json", report)
    if emit_result:
        emit("result", stage="fulltext_review", count=counts["fetched"], counts=counts,
             message=f"缓存已复核：正文/PDF {counts['fetched']} 篇，摘要 {counts['abstract_only']} 篇，待补充 {counts['unavailable']} 篇；尚未继续获取全文。",
             files=["fulltext/status.json", "fulltext/review.json"])
    return report


def _parse_only(only: object) -> list[str] | None:
    if only is None:
        return None
    if isinstance(only, (list, tuple)):
        values = [str(v).strip() for v in only]
    else:
        values = [part.strip() for part in str(only).split(",")]
    values = [v for v in values if v]
    if not values:
        raise ValueError("「--only」参数为空")
    return values


def _remote_pause(reason: str) -> bool:
    """Only remote acquisition gaps may be skipped; storage/evidence stays gated."""
    reason = str(reason or "")
    return bool(reason and not reason.startswith("local_") and reason != "material_cleanup")


def _previous_remote_pause(item: dict, paper: dict) -> FulltextPause | None:
    """Migrate an already paused remote item without repeating its failed request.

    Older status files lack a machine-readable reason. Only explicit access /
    loading messages in an attention record are recognized; ambiguous local
    verification or file errors remain paused for inspection.
    """
    if item.get("local_verification"):
        return None
    reason = str(item.get("pause_reason") or "")
    if reason and not _remote_pause(reason):
        return None
    messages = []
    if item.get("status") == "needs_attention":
        messages.append(str(item.get("reason") or ""))
    if paper.get("main_pdf_status") == "needs_attention":
        messages.append(str(paper.get("main_pdf_reason") or ""))
    if paper.get("supplement_check", {}).get("status") == "needs_attention":
        messages.append(str(paper["supplement_check"].get("reason") or ""))
    messages += [str(material.get("download_reason") or material.get("read_reason") or "")
                 for material in paper.get("materials", [])
                 if material.get("download_status") == "needs_attention"]
    message = next((value for value in messages if value), "")
    if not message:
        return None
    if re.search(r"SHA|缓存|本地|暂存|清理|大小.*不符|清单.*不|保存.*失败|文件.*冲突", message, re.I):
        return None
    if not reason:
        if re.search(r"验证码|人机验证|verification|captcha", message, re.I):
            reason = "verification"
        elif re.search(r"登录|log.?in|sign.?in", message, re.I):
            reason = "login"
        elif re.search(r"权限|订阅|access.required|paywall", message, re.I):
            reason = "access_required"
        elif re.search(r"限流|频繁|rate.limit", message, re.I):
            reason = "rate_limited"
        elif re.search(r"超时|超过1分钟|未就绪|timeout", message, re.I):
            reason = "load_timeout"
        elif re.search(r"404|页面返回错误|未能核对完整题名|尚未取得可确认的全文|尚不能确认.*结果页面", message):
            reason = "page_error"
        else:
            return None
    return FulltextPause(str(item["paper_id"]), str(item.get("source_url") or ""),
                         reason=reason, message=message)


def _run_fulltext(
    config: dict,
    job_dir: Path,
    *,
    resume: bool = False,
    limit: int | None = None,
    only: list[str] | str | None = None,
    retry_unavailable: bool = False,
    restart_cnki: bool = False,
    skip_unavailable: bool = False,
    fetcher=None,
) -> int:
    """Execute the fulltext stage; returns the process exit code (0/1)."""
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        options = _fulltext_options(config)
        only_ids = _parse_only(only)
        if limit is not None and (not isinstance(limit, int) or limit < 1):
            raise ValueError("「--limit」必须为正整数")
    except ValueError as error:
        emit("error", stage="fulltext", message=f"全文获取失败：{error}")
        return 1

    try:
        targets = load_targets(job_dir, config)
    except Exception as error:
        emit("error", stage="fulltext", message=f"全文获取失败：{error}")
        return 1

    status_path = job_dir / "fulltext" / "status.json"
    previous = _load_previous_items(status_path)
    only_set = set(only_ids) if only_ids is not None else None
    items = [dict(previous[target["paper_id"]])
             if only_set is not None and target["paper_id"] not in only_set and target["paper_id"] in previous
             else _carry_previous(target, previous.get(target["paper_id"]), job_dir) for target in targets]
    for item in items:
        if item.get("status") in {"needs_attention", "unavailable"}:
            # --only preserves unrelated statuses, but not unverified URLs.
            item["fulltext_url"] = ""
    target_by_id = {target["paper_id"]: target for target in targets}
    position = {item["paper_id"]: index for index, item in enumerate(items)}
    try:
        materials = MaterialsStore(job_dir, targets)
    except MaterialsError as error:
        emit("error", stage="fulltext", message=f"材料清单无法安全读取，已保留原任务：{error}")
        return 1

    emit(
        "stage",
        stage="fulltext",
        message=(
            f"{'继续' if resume else '开始'}全文获取：{len(items)} 篇目标（"
            + ("去重结果" if (job_dir / "dedupe" / "dedupe.json").exists() else "候选清单")
            + "）"
        ),
    )

    # --only filter
    if only_ids is not None:
        unknown = [key for key in only_ids if key not in position]
        if unknown:
            emit("stage", stage="fulltext", message=f"忽略未识别的论文标识：{','.join(unknown)}")
        matched = [key for key in only_ids if key in position]
        if not matched:
            emit("error", stage="fulltext", message="全文获取失败：指定的论文标识均不在候选清单中")
            return 1
        allowed = set(matched)
    else:
        allowed = set(position)

    explicit_retry = retry_unavailable and only_ids is not None and len(only_ids) == 1

    def skip_remote(item, target, pause):
        nonlocal fetcher
        saved = items[position[item["paper_id"]]]
        marker = {"policy": "skip_unavailable", "reason": pause.reason,
                  "message": pause.message, "skipped_at": now_iso()}
        if saved.get("status") not in FETCHED_STATUSES:
            saved.update(fulltext_url="", attempted_url=pause.url or str(saved.get("source_url") or ""),
                         status="unavailable", reason=pause.message + "（本轮已跳过，待补充）")
        saved.update(acquisition_skip=marker, pause_reason=pause.reason)
        paper = materials.paper(target)
        paper["acquisition_skip"] = dict(marker)
        if paper.get("main_pdf_status") != "downloaded":
            paper.update(main_pdf_status="missing", main_pdf_reason=pause.message + "（本轮已跳过，待补充）")
        if paper.get("supplement_check", {}).get("status") not in {"checked", "none_declared"}:
            paper["supplement_check"] = {"status": "unknown", "reason": pause.message + "（本轮已跳过，补充材料待核查）"}
        for material in paper.get("materials", []):
            if material.get("download_status") != "downloaded":
                material.update(download_status="missing", download_reason=pause.message + "（本轮已跳过，待补充）")
        materials.flush()
        _write_status(job_dir, items, materials=materials)
        if fetcher is None:
            fetcher = make_fetcher(config, job_dir)
        defer = getattr(fetcher, "defer_paper", None)
        if callable(defer):
            defer(reason=pause.reason, url=pause.url)
        emit("stage", stage="fulltext", reason=pause.reason, paper_id=item["paper_id"],
             message=f"本轮跳过 {item['paper_id']}：{pause.message}；已存材料保留，继续下一篇。")

    if skip_unavailable and resume and not explicit_retry:
        for item in items:
            if item["paper_id"] not in allowed or item.get("acquisition_skip"):
                continue
            target = target_by_id[item["paper_id"]]
            previous_pause = _previous_remote_pause(item, materials.paper(target))
            if previous_pause is not None:
                skip_remote(item, target, previous_pause)

    def eligible(item: dict) -> bool:
        status = str(item.get("status") or "pending")
        if item.get("acquisition_skip") and not explicit_retry and not item.get("local_verification"):
            return False
        if status in RETRYABLE_ON_RESUME:
            return True
        if status in GATED_ON_RESUME:
            return retry_unavailable
        return False

    eligible_items = [item for item in items if item["paper_id"] in allowed and eligible(item)]
    # Keep the paused acquisition first; complete material inventories for old
    # successes afterwards. A saved body is never permission to download it again.
    backfill = []
    if fetcher is None or callable(getattr(fetcher, "inspect_materials", None)):
        for item in items:
            if item["paper_id"] not in allowed or item.get("status") not in FETCHED_STATUSES:
                continue
            if item.get("acquisition_skip") and not explicit_retry:
                continue
            paper = materials.paper(target_by_id[item["paper_id"]])
            if not materials.paper_ready(target_by_id[item["paper_id"]]):
                backfill.append(item)

    # Quota: min(--limit, fulltext.maxPapers - already fetched)
    quota: int | None = None
    if options["max_papers"] > 0:
        fetched_so_far = sum(1 for item in items if item.get("status") in FETCHED_STATUSES)
        quota = max(0, options["max_papers"] - fetched_so_far)
    if limit is not None:
        quota = limit if quota is None else min(quota, limit)
    if quota is not None and quota < len(eligible_items):
        emit(
            "stage",
            stage="fulltext",
            message=f"本次最多获取 {quota} 篇（其余保持待处理；可放宽 --limit / fulltext.maxPapers 后续跑）",
        )
        eligible_items = eligible_items[:quota]
    eligible_items += backfill
    if limit is not None:
        eligible_items = eligible_items[:limit]

    gated = [
        item for item in items
        if item["paper_id"] in allowed and str(item.get("status")) in GATED_ON_RESUME
    ]
    if gated and not retry_unavailable:
        emit(
            "stage",
            stage="fulltext",
            message=f"跳过 {len(gated)} 篇既有待补充项（--retry-unavailable 可重试，不绕过访问限制）",
        )

    skipped = len(items) - len(eligible_items)

    def incomplete_counts():
        return {"acquisition_skipped": sum(bool(item.get("acquisition_skip")) for item in items),
                "material_incomplete": sum(not materials.paper_ready(target) for target in targets)}

    if not eligible_items:
        for target in targets:
            saved = items[position[target["paper_id"]]]
            if target["paper_id"] in allowed and saved.get("status") in FETCHED_STATUSES:
                materials.register_main(target, saved)
        materials.flush()
        counts = _write_status(job_dir, items, materials=materials)
        fetched = counts["fetched_pdf"] + counts["fetched_html"]
        emit(
            "result",
            stage="fulltext",
            message=f"材料获取阶段已结束：本轮无新增获取（{counts['total']} 篇目标中 {fetched} 篇已获取）；缺失材料仍待补充。",
            count=fetched,
            counts={
                "fetched": fetched,
                "fetched_pdf": counts["fetched_pdf"],
                "fetched_html": counts["fetched_html"],
                "abstract_only": counts["abstract_only"],
                "unavailable": counts["unavailable"],
                "needs_attention": counts["needs_attention"],
                "pending": counts["pending"],
                "skipped": skipped,
                **incomplete_counts(),
            },
            files=["fulltext/status.json", "fulltext/materials.json"],
        )
        return 0

    if fetcher is None:
        fetcher = make_fetcher(config, job_dir)
    browser_ready = False
    catalog = ReuseCatalog(job_dir, targets, load_targets)
    opts = {"fetcher": fetcher, "per_paper_timeout_sec": options["per_paper_timeout_sec"],
            "cnki_restart": restart_cnki}

    def ensure_browser():
        nonlocal browser_ready
        if not browser_ready:
            ready = fetcher.ensure_ready()
            if str((ready or {}).get("status")) != "ok":
                return ready or {"status": "error", "message": "浏览器尚未就绪。"}
            browser_ready = True
        return {"status": "ok"}

    for index, item in enumerate(eligible_items, start=1):
        target = target_by_id[item["paper_id"]]
        if explicit_retry:
            item.pop("acquisition_skip", None)
            item.pop("pause_reason", None)
            materials.paper(target).pop("acquisition_skip", None)
        collector = MaterialCollection(materials, target, fetcher, ensure_browser,
            progress=lambda message: emit("stage", stage="fulltext", message=message))

        def checkpoint(saved, target=target):
            items[position[target["paper_id"]]] = saved
            _write_status(job_dir, items, materials=materials)
            if saved.get("status") in FETCHED_STATUSES:
                materials.register_main(target, saved)
                materials.flush()

        paper_opts = {**opts, "record": target, "on_material_discovery": collector.observe, "on_main_saved": checkpoint}
        emit(
            "stage",
            stage="fulltext",
            message=f"获取全文 {index}/{len(eligible_items)}：{_short(target.get('title')) or item['paper_id']}",
        )
        # Reuse is entirely local and precedes even opening the browser. It
        # never changes a source task or uses a local candidate number as a
        # cross-task paper identifier.
        reused = ({"status": "reused", "item": item} if item.get("status") in FETCHED_STATUSES
                  else catalog.try_reuse(target, _item_skeleton(target)))
        if reused["status"] == "reused":
            checkpoint(reused["item"])
            emit("stage", stage="fulltext", message=f"已复用本地已核验全文：{_short(target.get('title')) or item['paper_id']}；未重新下载。")
        local_check = item.get("local_verification")
        if reused["status"] == "blocked" or (reused["status"] != "reused" and isinstance(local_check, dict) and local_check.get("status") != "valid"):
            message = reused.get("reason") or local_check.get("reason") or "已保存全文需先人工核查，未重新下载。"
            item.update(status="needs_attention", reason=message, pause_reason="local_fulltext_verification")
            _write_status(job_dir, items, materials=materials)
            emit("attention", stage="fulltext", reason="local_fulltext_verification", paper_id=item["paper_id"], message=message)
            return 0
        if reused["status"] != "reused":
            try:
                ready = ensure_browser()
            except Exception:
                emit("error", stage="fulltext", message="全文获取失败：浏览器连接失败，请检查本机浏览器。")
                return 1
            if str((ready or {}).get("status")) != "ok":
                emit("error", stage="fulltext", message=str((ready or {}).get("message") or "浏览器启动失败"))
                return 1
        try:
            current = items[position[item["paper_id"]]]
            if current.get("status") == "fetched_pdf":
                updated = current
                attention = collector.inspect_existing(paper_opts)
                if attention:
                    _raise_page_attention(attention, item["paper_id"], "")
            elif current.get("status") == "fetched_html" and (
                    not callable(getattr(fetcher, "inspect_materials", None))
                    or materials.paper(target).get("main_pdf_status") == "downloaded"):
                updated = current
                attention = collector.inspect_existing(paper_opts)
                if attention:
                    _raise_page_attention(attention, item["paper_id"], "")
            else:
                if current.get("status") == "fetched_html":
                    paper_opts["cached_main"] = current
                    ready = ensure_browser()
                    if ready.get("status") != "ok":
                        raise FulltextPause(item["paper_id"], reason="page_error", message=str(ready.get("message") or "PDF检查浏览器尚未就绪。"))
                updated = fetch_one(target, job_dir, paper_opts)
            checkpoint(updated)
            if updated.get("status") in FETCHED_STATUSES:
                if not collector.checked and not collector.inspected:
                    attention = collector.inspect_existing(paper_opts)
                    if attention:
                        _raise_page_attention(attention, item["paper_id"], "")
                paper = materials.paper(target)
                if paper.get("main_pdf_status") != "downloaded":
                    paper.update(main_pdf_status="missing", main_pdf_reason="已保留可确认的网页正文，本次尚未取得原版PDF；请核查原文章页。")
                materials.read_materials(target)
                materials.flush()
            else:
                paper = materials.paper(target)
                paper.update(main_pdf_status="missing", main_pdf_reason=str(updated.get("reason") or "本次未取得正文PDF。"))
                materials.flush()
        except FulltextPause as pause:
            if skip_unavailable and _remote_pause(pause.reason):
                skip_remote(item, target, pause)
                continue
            saved = items[position[item["paper_id"]]]
            saved["pause_reason"] = pause.reason
            if saved.get("status") not in FETCHED_STATUSES:
                item.update(
                fulltext_url="",
                attempted_url=pause.url or str(item.get("source_url") or ""),
                kind="none",
                status="needs_attention",
                path="",
                size=0,
                retrieved_at="",
                evidence_level="",
                reason=pause.message,
                pause_reason=pause.reason,
                )
                items[position[item["paper_id"]]] = item
            paper = materials.paper(target)
            if paper.get("main_pdf_status") != "downloaded":
                paper.update(main_pdf_status="needs_attention", main_pdf_reason=pause.message)
            materials.flush()
            _write_status(job_dir, items, materials=materials)
            emit("attention", stage="verification", reason=pause.reason, paper_id=pause.paper_id, message=pause.message)
            return 0
        except MaterialsError as error:
            items[position[item["paper_id"]]]["pause_reason"] = "local_material_verification"
            materials.flush()
            _write_status(job_dir, items, materials=materials)
            emit("attention", stage="verification", reason="local_material_verification", paper_id=item["paper_id"], message=str(error))
            return 0
        items[position[item["paper_id"]]] = updated
        _write_status(job_dir, items, materials=materials)
        catalog.register(target, updated)
        if updated.get("status") in FETCHED_STATUSES and (
                reused["status"] != "reused" or
                (collector.inspected and callable(getattr(fetcher, "inspect_materials", None)))):
            complete = getattr(fetcher, "complete_paper", None)
            if callable(complete):
                complete()  # Close only our page, after validated file and status are saved.

    materials.flush()
    counts = _write_status(job_dir, items, materials=materials)
    fetched = counts["fetched_pdf"] + counts["fetched_html"]
    emit(
        "result",
        stage="fulltext",
        message=(
            f"材料获取阶段已结束：已获取正文 {fetched} 篇（PDF {counts['fetched_pdf']} / HTML {counts['fetched_html']}）；"
            f"请逐篇核对材料清单中的PDF、补充材料与可读性。题录/摘要 {counts['abstract_only']} 篇，待补充 {counts['unavailable']} 篇"
        ),
        count=fetched,
        counts={
            "fetched": fetched,
            "fetched_pdf": counts["fetched_pdf"],
            "fetched_html": counts["fetched_html"],
            "abstract_only": counts["abstract_only"],
            "unavailable": counts["unavailable"],
            "needs_attention": counts["needs_attention"],
            "pending": counts["pending"],
            "skipped": skipped,
            **incomplete_counts(),
        },
        files=["fulltext/status.json", "fulltext/materials.json"],
    )
    return 0


def run(config, job_dir, *, resume=False, limit=None, only=None, retry_unavailable=False, restart_cnki=False, skip_unavailable=False, fetcher=None):
    job_dir = Path(job_dir)
    if restart_cnki:
        try:
            ids = _parse_only(only)
            if not resume or not retry_unavailable or limit != 1 or not ids or len(ids) != 1:
                raise ValueError("重新定位仅适用于明确选择的一篇知网文献，须同时使用 --resume --only <id> --retry-unavailable --limit 1")
            targets = [target for target in load_targets(job_dir, config) if target["paper_id"] == ids[0]]
            prior = _load_previous_items(job_dir / "fulltext" / "status.json").get(ids[0])
            if len(targets) != 1 or targets[0].get("source_key") != "cnki" or not prior or prior.get("status") not in {"pending", "needs_attention", "unavailable", "abstract_only"}:
                raise ValueError("只能重新定位当前尚未获取全文的知网单篇，已有全文不重复下载")
        except (ValueError, OSError) as error:
            emit("error", stage="fulltext", message=f"全文获取失败：{error}")
            return 1
    # Recheck legacy successes before any network access. An unverified cache
    # must not silently become extraction input on a normal resume.
    status_path = job_dir / "fulltext" / "status.json"
    if status_path.exists():
        try:
            saved = json.loads(status_path.read_text(encoding="utf-8"))
            if any(item.get("status") == "fetched_html" and item.get("evidence_version") != EVIDENCE_VERSION
                   for item in saved.get("items", []) if isinstance(item, dict)):
                if only is not None:
                    emit("error", stage="fulltext", message="旧全文缓存尚未复核，请先点击“复核已保存全文”后再重试单篇。")
                    return 1
                review_saved_fulltext(job_dir, emit_result=False)
        except (OSError, ValueError) as error:
            emit("error", stage="fulltext", message=f"全文缓存需复核，已暂停：{error}")
            return 1
    actual = fetcher if fetcher is not None else make_fetcher(config, job_dir)
    try:
        return _run_fulltext(config, job_dir, resume=resume, limit=limit, only=only,
                             retry_unavailable=retry_unavailable, restart_cnki=restart_cnki,
                             skip_unavailable=skip_unavailable, fetcher=actual)
    finally:
        close = getattr(actual, "close", None)
        if callable(close):
            close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献挖掘·全文获取阶段（受限，不绕过访问控制）")
    parser.add_argument("--config", type=Path, required=True, help="任务 run_config.json 路径")
    parser.add_argument("--output-dir", type=Path, required=True, help="任务目录（.workbench/literature/<uuid>）")
    parser.add_argument("--resume", action="store_true", help="续跑：跳过已获取项，处理未完成项")
    parser.add_argument("--limit", type=int, help="本次最多获取的篇数")
    parser.add_argument("--only", help="仅处理指定论文标识，逗号分隔（如 GSC-001,GSC-002）")
    parser.add_argument("--retry-unavailable", action="store_true", help="重试此前标为待补充（unavailable/abstract_only）的项")
    parser.add_argument("--skip-unavailable", action="store_true", help="远程登录、权限、验证或超时项登记待补充并继续；本地材料核验异常仍暂停")
    parser.add_argument("--restart-cnki", action="store_true", help="显式重新定位已选知网单篇，从正常检索页开始一次")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--review-only", action="store_true", help="仅离线复核缓存，不访问网站")
    mode.add_argument("--open-current", action="store_true", help="只显示任务已绑定的全文页面")
    args = parser.parse_args(argv)

    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError("运行配置无效")
        if args.restart_cnki and (args.review_only or args.open_current):
            raise ValueError("重新定位不能与离线复核或仅查看原页面同时使用")
        if args.review_only:
            review_saved_fulltext(args.output_dir)
            return 0
        if args.open_current:
            fetcher = make_fetcher(config, args.output_dir)
            try:
                result = fetcher.open_current()
                if not result.get("opened"):
                    raise ValueError(result.get("message") or "尚无该任务绑定的全文页面")
                emit("result", stage="fulltext_browser", opened=True, message=str(result.get("message") or "已显示原任务全文页面"))
                return 0
            finally:
                fetcher.close()
        return run(
            config,
            args.output_dir,
            resume=args.resume,
            limit=args.limit,
            only=args.only,
            retry_unavailable=args.retry_unavailable,
            restart_cnki=args.restart_cnki,
            skip_unavailable=args.skip_unavailable,
        )
    except Exception as error:
        emit("error", stage="fulltext", message=f"全文获取失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
