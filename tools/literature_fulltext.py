"""Full-text acquisition stage (restricted) for the literature-mining pipeline.

Stage CLI (docs/literature-mining-stage2-design.md §2.4.3):

    python -u tools/literature_fulltext.py --config C --output-dir D
            [--resume] [--limit N] [--only id1,id2] [--retry-unavailable]

Behaviour:

- Input: prefers canonical groups from ``dedupe/dedupe.json``; falls back to the
  cumulative ``candidates.json`` (deduplicated by ``canonical_id`` when present,
  else ``candidate_id``; ``auto_excluded_duplicate`` records are skipped).
- Target priority per paper (§2.4.3): (1) direct PDF in ``fulltext_links`` ->
  (2) ``result_url`` ending in ``.pdf`` -> (3) ``result_url`` page navigation
  (HTML text preferred). If every candidate fails the paper is ``unavailable``
  (displayed as 待补充) with a reason.
- Output (§3.5): ``fulltext/status.json`` + ``fulltext/files/<paper_id>.pdf|.txt``.
- Human-in-the-loop: captcha -> ``attention(stage="verification")`` + exit 0;
  the human completes the challenge in the persistent browser and the driver
  resumes the stage with ``--resume``. Captchas are never bypassed.
- Red line: no bypass of access restrictions. Paywalls, unreachable pages and
  missing legal entry points are recorded as ``unavailable`` (待补充) with a
  reason; no login simulation, no mirror scraping, no retry-bypass.
- Retry policy (implementation decision; the design text is read as "resume
  skips fetched_*; retrying unavailable items is opt-in"): items already
  ``fetched_pdf``/``fetched_html`` whose file still exists are always kept and
  never re-downloaded; ``pending``/``needs_attention`` items are attempted;
  ``unavailable``/``abstract_only`` items are retried only with
  ``--retry-unavailable``. The ``--resume`` flag is kept for CLI symmetry and
  only changes the opening progress message.
- Reuse (A-tier, design §5.2/§9.4): ``SOC-database-pipeline-clean/.codex/skills/
  soc-paper-fetch/scripts`` is imported via ``sys.path`` (same pattern as
  ``literature_search.py``): ``browser.launch``, ``common.connect_browser`` /
  ``get_or_create_page`` / ``apply_stealth`` / ``looks_like_captcha``, and
  ``download_pdf.run(..., out_path_override=<job>/fulltext/files/<id>.pdf)``.
  The persistent CDP Chromium (with whatever login state the human established)
  is shared with the discover stage.
- V2 (per-paper connection overhead): first version calls ``download_pdf.run``
  once per paper, and each call starts its own Playwright driver process and
  attaches once to CDP 9222 (fixed cost per paper, dominated by ``page.goto``).
  Two lightweight paths avoid that cost entirely without touching the SOC
  contract: (a) items whose target file already exists on disk are settled by a
  plain ``Path.exists()`` check with zero browser calls; (b) a run where nothing
  is eligible never launches the browser at all. A future batch-friendly
  optimisation (hoisting one ``sync_playwright``/CDP connection across papers by
  inlining the selector loop) is deliberately not done in this stage to keep the
  A-tier ``download_pdf`` reuse untouched.

Events: NDJSON on stdout (``stage``/``attention``/``error``/``result``, §2.2);
one run ends with exactly one of ``result`` (exit 0), ``attention`` (exit 0) or
``error`` (exit 1).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SOC_FETCH = ROOT / "SOC-database-pipeline-clean" / ".codex" / "skills" / "soc-paper-fetch" / "scripts"

STATUS_ORDER = ["fetched_pdf", "fetched_html", "abstract_only", "unavailable", "needs_attention", "pending"]
FETCHED_STATUSES = {"fetched_pdf", "fetched_html"}
RETRYABLE_ON_RESUME = {"pending", "needs_attention"}
GATED_ON_RESUME = {"unavailable", "abstract_only"}

MIN_PDF_BYTES = 50 * 1024  # %PDF magic + >=50KB, same thresholds as SOC download_pdf
HTML_MIN_TEXT_CHARS = 300
HTML_MIN_FULLTEXT_CHARS = 2000

POLICY_TEXT = "HTML 正文优先、PDF 备选；无法合法获取标为待补充，不绕过访问控制。"

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


class CaptchaPause(Exception):
    """Raised when the persistent browser hits a captcha; the stage pauses."""

    def __init__(self, paper_id: str, url: str = "") -> None:
        super().__init__("captcha")
        self.paper_id = paper_id
        self.url = url


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
        os.replace(tmp_name, path)
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


def _collect_links(record: dict) -> list[dict]:
    links: list[dict] = []
    for link in record.get("fulltext_links") or []:
        if not isinstance(link, dict):
            continue
        url = safe_url(link.get("url"))
        if url:
            links.append({"label": str(link.get("label") or "")[:100], "url": url})
    return links


def _record_result_url(record: dict) -> str:
    """result_url of a raw candidate record, tolerant of normalized targets."""
    return safe_url(record.get("result_url") or record.get("source_url"))


def candidate_urls(record: dict) -> list[tuple[str, str]]:
    """Ordered (kind, url) attempt chain for one record, deduplicated.

    Accepts both raw candidate records (``result_url``) and normalized targets
    (``source_url``) so ``classify_target`` and ``fetch_one`` share one logic.
    """
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(kind: str, url: str) -> None:
        if url and url not in seen:
            seen.add(url)
            out.append((kind, url))

    links = _collect_links(record)
    for link in links:
        if _url_looks_pdf(link["url"]):
            add("pdf", link["url"])
    result_url = _record_result_url(record)
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


def assess_html_text(text: str) -> tuple[str, str]:
    """Judge navigation text: ("fulltext"|"abstract"|"unavailable", reason)."""
    cleaned = (text or "").strip()
    low = cleaned.lower()
    for marker in PAYWALL_MARKERS:
        if marker.lower() in low:
            return "unavailable", "付费墙/访问受限，仅摘要可见，不绕过访问控制（待补充）"
    if len(cleaned) < HTML_MIN_TEXT_CHARS:
        return "unavailable", f"页面无可提取正文（可见文本不足 {HTML_MIN_TEXT_CHARS} 字符）（待补充）"
    if len(cleaned) < HTML_MIN_FULLTEXT_CHARS:
        return "abstract", f"页面仅含摘要级文本（不足 {HTML_MIN_FULLTEXT_CHARS} 字符），全文待补充"
    return "fulltext", ""


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

class SocBrowserFetcher:
    """Drives the persistent Chromium via the SOC soc-paper-fetch scripts."""

    def __init__(self, config: dict | None = None) -> None:
        self._soc: tuple | None = None

    def _soc_modules(self):
        if self._soc is None:
            if str(SOC_FETCH) not in sys.path:
                sys.path.insert(0, str(SOC_FETCH))
            import browser as soc_browser  # noqa: PLC0415 - SOC reuse, lazy import
            import common as soc_common  # noqa: PLC0415
            import download_pdf as soc_download_pdf  # noqa: PLC0415
            self._soc = (soc_browser, soc_common, soc_download_pdf)
        return self._soc

    def ensure_ready(self) -> dict:
        soc_browser, _, _ = self._soc_modules()
        try:
            launched = soc_browser.launch() or {}
        except Exception as exc:  # playwright / chromium missing, CDP errors
            return {"status": "error", "message": f"浏览器启动失败：{exc}"}
        if launched.get("status") not in {"already_running", "launched"}:
            return {"status": "error", "message": str(launched.get("message") or launched.get("status") or "浏览器启动失败")}
        return {"status": "ok", "detail": str(launched.get("status"))}

    def fetch_pdf(self, url: str, out_path: Path, opts: dict) -> dict:
        _, _, soc_download_pdf = self._soc_modules()
        try:
            result = soc_download_pdf.run(url, None, None, False, str(out_path))
        except Exception as exc:
            return {"status": "fetch_error", "error": f"{exc}"}
        return result if isinstance(result, dict) else {"status": "fetch_error", "error": "download_pdf 未返回结果"}

    def fetch_page(self, url: str, opts: dict) -> dict:
        _, soc_common, _ = self._soc_modules()
        try:
            from playwright.sync_api import sync_playwright  # noqa: PLC0415 - lazy import
        except Exception as exc:
            return {"status": "nav_error", "error": f"playwright 不可用：{exc}", "url": url}
        timeout_ms = max(5000, min(60000, int(opts.get("per_paper_timeout_sec") or 120) * 1000))
        try:
            with sync_playwright() as p:
                _, context = soc_common.connect_browser(p)
                page = soc_common.get_or_create_page(context)
                soc_common.apply_stealth(page)
                try:
                    response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                except Exception as exc:
                    return {"status": "nav_error", "error": str(exc), "url": url}
                try:
                    soc_common.human_pause(0.8, 1.6)
                except Exception:
                    pass
                try:
                    text = page.evaluate("() => document.body && document.body.innerText || ''")
                except Exception:
                    text = ""
                if soc_common.looks_like_captcha(text):
                    return {"status": "captcha", "url": page.url}
                content_type = ""
                if response is not None:
                    content_type = str((response.headers or {}).get("content-type", "")).lower()
                if "pdf" in content_type:
                    try:
                        blob = context.request.get(page.url, timeout=timeout_ms).body()
                    except Exception as exc:
                        return {"status": "nav_error", "error": f"PDF 响应读取失败：{exc}", "url": page.url}
                    return {"status": "pdf_page", "url": page.url, "bytes": blob}
                return {"status": "ok", "text": text, "url": page.url}
        except Exception as exc:
            return {"status": "nav_error", "error": str(exc), "url": url}


def make_fetcher(config: dict) -> SocBrowserFetcher:  # test seam
    return SocBrowserFetcher(config)


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
    return _target(
        paper_id,
        record.get("title"),
        record.get("doi"),
        safe_url(record.get("result_url")),
        _collect_links(record),
        record.get("snippet"),
    )


def _target_from_group(group: dict) -> dict | None:
    canonical_id = str(group.get("canonical_id") or "").strip()
    if not canonical_id:
        return None
    records = [r for r in group.get("records") or [] if isinstance(r, dict)]
    source = next((r for r in records if str(r.get("candidate_id") or "") == canonical_id), records[0] if records else {})
    title = group.get("title") or source.get("title")
    doi = group.get("doi") or source.get("doi")
    return _target(
        canonical_id,
        title,
        doi,
        safe_url(source.get("result_url")),
        _collect_links(source),
        source.get("snippet"),
    )


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
            for group in dedupe["groups"]:
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


def _settle_pdf(item: dict, out_path: Path, files_rel: str, url: str, size: int) -> dict:
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
    return item


def fetch_one(record: dict, out_dir: Path, opts: dict) -> dict:
    """Fetch one paper's full text; returns a §3.5 item. Raises CaptchaPause.

    ``out_dir`` is the job directory; files land in ``<job>/fulltext/files/``.
    """
    fetcher = opts["fetcher"]
    job_dir = Path(out_dir)
    files_dir = job_dir / "fulltext" / "files"
    files_dir.mkdir(parents=True, exist_ok=True)
    paper_id = str(record.get("paper_id") or "")
    stem = _sanitize_stem(paper_id)
    item = _item_skeleton(record)

    attempts = candidate_urls(record)
    if not attempts:
        if str(record.get("snippet") or "").strip():
            item.update(
                kind="abstract",
                status="abstract_only",
                evidence_level="search_result_snippet",
                reason="无合法全文入口，仅有检索片段（待补充）",
            )
        else:
            item.update(status="unavailable", reason="无合法全文入口（待补充）")
        return item

    failures: list[str] = []
    for kind, url in attempts:
        if kind == "pdf":
            file_name = f"{stem}.pdf"
            out_path = files_dir / file_name
            files_rel = f"fulltext/files/{file_name}"
            if out_path.exists() and out_path.stat().st_size >= MIN_PDF_BYTES:
                # Lightweight fast path: file already on disk, zero browser calls.
                return _settle_pdf(item, out_path, files_rel, url, out_path.stat().st_size)
            result = fetcher.fetch_pdf(url, out_path, opts)
            status = str(result.get("status") or "")
            if status == "captcha":
                raise CaptchaPause(paper_id, url)
            if status in {"saved", "already_exists"}:
                if not out_path.exists():
                    failures.append(f"PDF 保存结果缺失文件（{url}）")
                    continue
                size = out_path.stat().st_size
                if not _looks_like_valid_pdf(out_path):
                    failures.append(f"PDF 校验失败（需 %PDF 魔数且 ≥50KB）（{url}）")
                    try:
                        out_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                    continue
                return _settle_pdf(item, out_path, files_rel, url, size)
            detail = str(result.get("error") or result.get("message") or "").strip()
            failures.append(f"PDF 获取失败（{url}）：{status}{' ' + _short(detail, 120) if detail else ''}")
            continue

        # kind == "html"
        result = fetcher.fetch_page(url, opts)
        status = str(result.get("status") or "")
        if status == "captcha":
            raise CaptchaPause(paper_id, url)
        if status == "pdf_page":
            blob = result.get("bytes") or b""
            ok, why, size = validate_pdf_bytes(blob)
            if not ok:
                failures.append(f"页面返回的 PDF 校验失败（{url}）：{why}")
                continue
            file_name = f"{stem}.pdf"
            out_path = files_dir / file_name
            atomic_write_bytes(out_path, blob)
            return _settle_pdf(item, out_path, f"fulltext/files/{file_name}", str(result.get("url") or url), size)
        if status == "ok":
            text = str(result.get("text") or "")
            verdict, reason = assess_html_text(text)
            page_url = str(result.get("url") or url)
            if verdict in {"fulltext", "abstract"}:
                file_name = f"{stem}.txt"
                out_path = files_dir / file_name
                atomic_write_text(out_path, text.strip() + "\n")
                if verdict == "fulltext":
                    item.update(
                        fulltext_url=page_url,
                        kind="html",
                        status="fetched_html",
                        path=f"fulltext/files/{file_name}",
                        size=out_path.stat().st_size,
                        retrieved_at=now_iso(),
                        evidence_level="fulltext_html",
                        reason="",
                    )
                else:
                    item.update(
                        fulltext_url=page_url,
                        kind="html",
                        status="abstract_only",
                        path=f"fulltext/files/{file_name}",
                        size=out_path.stat().st_size,
                        retrieved_at=now_iso(),
                        evidence_level="abstract_only",
                        reason=reason,
                    )
                return item
            failures.append(f"页面不可用（{url}）：{reason}")
            continue
        detail = str(result.get("error") or "").strip()
        failures.append(f"页面导航失败（{url}）：{status}{' ' + _short(detail, 120) if detail else ''}")

    reason = "；".join(failures)[:600] or "全部获取路径失败"
    if "待补充" not in reason:
        reason = f"{reason}（待补充）"
    item.update(status="unavailable", reason=reason)
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
    for key in ("fulltext_url", "kind", "status", "path", "size", "retrieved_at", "evidence_level", "reason"):
        if key in prev:
            item[key] = prev[key]
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


def _write_status(job_dir: Path, items: list[dict]) -> dict:
    counts = _counts(items)
    doc = {
        "version": 1,
        "generated_at": now_iso(),
        "policy": POLICY_TEXT,
        "items": items,
        "counts": counts,
    }
    atomic_write_json(job_dir / "fulltext" / "status.json", doc)
    return counts


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


def run(
    config: dict,
    job_dir: Path,
    *,
    resume: bool = False,
    limit: int | None = None,
    only: list[str] | str | None = None,
    retry_unavailable: bool = False,
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
    items = [_carry_previous(target, previous.get(target["paper_id"]), job_dir) for target in targets]
    target_by_id = {target["paper_id"]: target for target in targets}
    position = {item["paper_id"]: index for index, item in enumerate(items)}

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

    def eligible(item: dict) -> bool:
        status = str(item.get("status") or "pending")
        if status in RETRYABLE_ON_RESUME:
            return True
        if status in GATED_ON_RESUME:
            return retry_unavailable
        return False

    eligible_items = [item for item in items if item["paper_id"] in allowed and eligible(item)]

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

    if not eligible_items:
        counts = _write_status(job_dir, items)
        fetched = counts["fetched_pdf"] + counts["fetched_html"]
        emit(
            "result",
            stage="fulltext",
            message=f"全文获取完成：无需获取（{counts['total']} 篇目标中 {fetched} 篇已获取）",
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
            },
            files=["fulltext/status.json"],
        )
        return 0

    if fetcher is None:
        fetcher = make_fetcher(config)
    try:
        ready = fetcher.ensure_ready()
    except Exception as error:
        emit("error", stage="fulltext", message=f"全文获取失败：浏览器连接失败（{error}）")
        return 1
    if str((ready or {}).get("status")) != "ok":
        emit("error", stage="fulltext", message=str((ready or {}).get("message") or "浏览器启动失败"))
        return 1

    opts = {"fetcher": fetcher, "per_paper_timeout_sec": options["per_paper_timeout_sec"]}
    for index, item in enumerate(eligible_items, start=1):
        target = target_by_id[item["paper_id"]]
        emit(
            "stage",
            stage="fulltext",
            message=f"获取全文 {index}/{len(eligible_items)}：{_short(target.get('title')) or item['paper_id']}",
        )
        try:
            updated = fetch_one(target, job_dir, opts)
        except CaptchaPause as pause:
            item.update(
                fulltext_url=pause.url or str(item.get("fulltext_url") or ""),
                kind="none",
                status="needs_attention",
                path="",
                size=0,
                retrieved_at="",
                evidence_level="",
                reason="人机验证未完成，等待人工处理后继续（待补充）",
            )
            _write_status(job_dir, items)
            emit("attention", stage="verification", message=ATTENTION_VERIFICATION_MESSAGE)
            return 0
        items[position[item["paper_id"]]] = updated
        _write_status(job_dir, items)

    counts = _write_status(job_dir, items)
    fetched = counts["fetched_pdf"] + counts["fetched_html"]
    emit(
        "result",
        stage="fulltext",
        message=(
            f"全文获取完成：已获取 {fetched} 篇（PDF {counts['fetched_pdf']} / HTML {counts['fetched_html']}），"
            f"摘要级 {counts['abstract_only']} 篇，待补充 {counts['unavailable']} 篇"
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
        },
        files=["fulltext/status.json"],
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献挖掘·全文获取阶段（受限，不绕过访问控制）")
    parser.add_argument("--config", type=Path, required=True, help="任务 run_config.json 路径")
    parser.add_argument("--output-dir", type=Path, required=True, help="任务目录（.workbench/literature/<uuid>）")
    parser.add_argument("--resume", action="store_true", help="续跑：跳过已获取项，处理未完成项")
    parser.add_argument("--limit", type=int, help="本次最多获取的篇数")
    parser.add_argument("--only", help="仅处理指定论文标识，逗号分隔（如 GSC-001,GSC-002）")
    parser.add_argument("--retry-unavailable", action="store_true", help="重试此前标为待补充（unavailable/abstract_only）的项")
    args = parser.parse_args(argv)

    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError("运行配置无效")
        return run(
            config,
            args.output_dir,
            resume=args.resume,
            limit=args.limit,
            only=args.only,
            retry_unavailable=args.retry_unavailable,
        )
    except Exception as error:
        emit("error", stage="fulltext", message=f"全文获取失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
