"""Download one paper's PDF by driving the persistent browser.

Usage:
    python download_pdf.py --url "<detail-or-pdf-url>" --out-id 61
    python download_pdf.py --url "..." --out-id 62 --click-selector "a#pdfDown"
    python download_pdf.py --current-page --out-id 63   # try to download the
                                                         # PDF of whatever is
                                                         # already open
    python download_pdf.py --url "..." \
        --out-path "<full path>"                         # save outside the
                                                         # numbered corpus

Strategy (in order):

1. Navigate to the URL (unless --current-page), with polite delays.
2. If the browser immediately landed on a PDF response, save its bytes
   directly via the same authenticated context.
3. Otherwise, try a sequence of known "download PDF" selectors (CNKI,
   ScienceDirect, Springer, Wiley, MDPI generic). Optionally use an
   explicit --click-selector passed by Codex after inspecting the page.
4. The click is wrapped in `expect_download`, which handles the case
   where the publisher triggers an actual file download.
5. If no download event fires but a new tab opens with a PDF, fetch
   that tab's URL bytes via the authenticated session.
6. Validate the result: must be > 50 KB and start with `%PDF`. Anything
   else is deleted and reported as a failure.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

from common import (
    apply_stealth,
    connect_browser,
    get_or_create_page,
    human_pause,
    looks_like_captcha,
    papers_dir,
    print_json,
)

# Ordered by likelihood. Each entry is a CSS selector or XPath-ish
# text-based locator. We stop on the first match.
PDF_BUTTON_SELECTORS: list[str] = [
    # CNKI variants
    "a#pdfDown",
    "a[name='pdfDown']",
    "li.btn-dlpdf a",
    "a.btn-dlpdf",
    "a:has-text('PDF下载')",
    "a:has-text('PDF 下载')",
    "a:has-text('下载PDF')",
    "li:has-text('PDF下载') a",
    # ScienceDirect
    "a.accessbar-utility-button",
    "a.PdfDropDownMenu-download-link",
    "a#pdfLink",
    "a:has-text('Download PDF')",
    "a:has-text('View PDF')",
    # Springer / Nature
    "a[data-track-action='download pdf']",
    "a[data-test='pdf-link']",
    "a.c-pdf-download__link",
    # Wiley
    "a.pdf-download",
    "a[title='PDF']",
    # MDPI / Frontiers / PLOS
    "a.UD_Listings_ArticlePDF",
    "a[data-testid='article-pdf-download']",
    "a[aria-label*='PDF']",
]


def _save_bytes(out_path: Path, blob: bytes) -> dict[str, Any]:
    if not blob:
        return {"status": "empty", "path": str(out_path)}
    if blob[:4] != b"%PDF":
        return {
            "status": "not_a_pdf",
            "path": str(out_path),
            "size": len(blob),
            "head": blob[:16].decode("latin-1", errors="replace"),
        }
    out_path.write_bytes(blob)
    size = out_path.stat().st_size
    if size < 50 * 1024:
        out_path.unlink(missing_ok=True)
        return {"status": "too_small", "size": size}
    return {"status": "saved", "path": str(out_path), "size": size}


def _is_pdf_response(response) -> bool:
    if response is None:
        return False
    ctype = (response.headers or {}).get("content-type", "").lower()
    return "pdf" in ctype


def _download_via_context(context, url: str) -> bytes:
    """Fetch a URL using the authenticated browser context (carries cookies)."""
    api = context.request
    resp = api.get(url, timeout=120_000)
    if not resp.ok:
        raise RuntimeError(f"GET {url} -> {resp.status}")
    return resp.body()


def _click_any(page, selectors: list[str]) -> str | None:
    """Click the first matching selector; returns the one that worked."""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() == 0:
                continue
            loc.scroll_into_view_if_needed(timeout=2_000)
            human_pause(0.4, 1.2)
            loc.click(timeout=3_000)
            return sel
        except Exception:
            continue
    return None


def _try_download_click(
    page, context, selectors: list[str]
) -> tuple[bytes | None, str | None]:
    """Click a download selector and return the downloaded bytes + which
    selector worked. Returns (None, None) if no selector matches."""
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() == 0:
                continue
            loc.scroll_into_view_if_needed(timeout=2_000)
            human_pause(0.5, 1.5)

            # Some download buttons open in a new tab, some fire a file
            # download. We handle both by racing an `expect_popup` and an
            # `expect_download`.
            try:
                with page.expect_download(timeout=15_000) as dl_info:
                    loc.click(timeout=5_000)
                dl = dl_info.value
                tmp = Path(dl.path())
                blob = tmp.read_bytes() if tmp and tmp.exists() else b""
                return blob, sel
            except Exception:
                # Fall through: maybe it opened a popup instead.
                pass

            # Check if a new page was opened.
            human_pause(1.0, 2.0)
            all_pages = context.pages
            if all_pages:
                newest = all_pages[-1]
                if newest != page and newest.url:
                    try:
                        blob = _download_via_context(context, newest.url)
                        newest.close()
                        return blob, sel
                    except Exception:
                        pass
        except Exception:
            continue
    return None, None


def run(
    url: str | None,
    out_id: int | None,
    click_selector: str | None,
    use_current_page: bool,
    out_path_override: str | None = None,
) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    if out_path_override:
        out_path = Path(out_path_override)
        out_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        assert out_id is not None
        out_path = papers_dir() / f"{out_id}.pdf"
    if out_path.exists():
        return {
            "status": "already_exists",
            "out_id": out_id,
            "path": str(out_path),
            "size": out_path.stat().st_size,
        }

    with sync_playwright() as p:
        _, context = connect_browser(p)
        page = get_or_create_page(context)
        apply_stealth(page)

        response = None
        if not use_current_page:
            assert url is not None
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            except Exception as exc:
                return {"status": "nav_error", "url": url, "error": str(exc)}
            human_pause(1.2, 2.8)

        body = ""
        try:
            body = page.evaluate("() => document.body && document.body.innerText || ''")
        except Exception:
            pass
        if looks_like_captcha(body):
            return {
                "status": "captcha",
                "url": page.url,
                "message": (
                    "页面触发了验证码 / 反爬拦截。请在打开的浏览器里手动"
                    "完成验证后让我重试。"
                ),
            }

        # Case 1: the navigation response itself was a PDF — easy path.
        if _is_pdf_response(response):
            try:
                blob = _download_via_context(context, page.url)
            except Exception as exc:
                return {"status": "direct_pdf_fetch_failed", "error": str(exc)}
            result = _save_bytes(out_path, blob)
            result["via"] = "direct_pdf_response"
            result["url"] = page.url
            result["out_id"] = out_id
            return result

        # Case 2: user/Codex provided an explicit selector.
        selector_queue = list(PDF_BUTTON_SELECTORS)
        if click_selector:
            selector_queue = [click_selector] + selector_queue

        blob, winning_sel = _try_download_click(page, context, selector_queue)
        if blob:
            result = _save_bytes(out_path, blob)
            result["via"] = f"click:{winning_sel}"
            result["url"] = page.url
            result["out_id"] = out_id
            return result

        # Case 3: nothing worked — surface a snippet for Codex to debug.
        snippet = re.sub(r"\s+", " ", (body or ""))[:800]
        return {
            "status": "no_pdf_button_found",
            "url": page.url,
            "out_id": out_id,
            "tried_selectors": len(selector_queue),
            "body_text_snippet": snippet,
            "message": (
                "Couldn't find a PDF download button on this page. Inspect "
                "the page in the browser, find the right selector, and rerun "
                "with --click-selector '<selector>'."
            ),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", help="URL to navigate to before downloading")
    parser.add_argument(
        "--current-page",
        action="store_true",
        help="Skip navigation — download from whatever tab is already open",
    )
    parser.add_argument("--out-id", type=int, help="Numeric id: saved as papers/{id}.pdf")
    parser.add_argument(
        "--out-path",
        help=(
            "Full output path override. When set, --out-id is ignored and the "
            "PDF is saved to this exact path instead of the numbered corpus."
        ),
    )
    parser.add_argument(
        "--click-selector",
        help="Optional CSS selector for the PDF download button, inserted first",
    )
    args = parser.parse_args()

    if not args.url and not args.current_page:
        parser.error("must provide --url or --current-page")
    if args.out_id is None and not args.out_path:
        parser.error("must provide --out-id or --out-path")

    result = run(
        args.url,
        args.out_id,
        args.click_selector,
        args.current_page,
        args.out_path,
    )
    print_json(result)
    # Non-zero exit on failure makes it easy to detect from shell.
    if result.get("status") != "saved" and result.get("status") != "already_exists":
        sys.exit(1)


if __name__ == "__main__":
    main()
