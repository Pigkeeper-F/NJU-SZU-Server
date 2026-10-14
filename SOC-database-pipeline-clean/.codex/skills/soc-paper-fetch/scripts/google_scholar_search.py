"""Search Google Scholar through the persistent browser and return candidates.

Google Scholar is used as a discovery surface, not as a bulk downloader. The
script performs one visible browser search, scrapes the rendered result page,
and reports title links plus any right-column full-text/PDF links Scholar shows.

Usage:
    python google_scholar_search.py --query "soil organic carbon manure" --limit 10
    python google_scholar_search.py --scrape-current --limit 10
"""
from __future__ import annotations

import argparse
import urllib.parse
from typing import Any

from common import (
    apply_stealth,
    connect_browser,
    get_or_create_page,
    human_pause,
    looks_like_captcha,
    print_json,
)


SCHOLAR_BASE_URL = "https://scholar.google.com/scholar"


def build_search_url(query: str) -> str:
    params = urllib.parse.urlencode({"q": query, "hl": "en"})
    return f"{SCHOLAR_BASE_URL}?{params}"


def _body_snippet(page, max_len: int = 800) -> str:
    try:
        text = page.evaluate("() => document.body && document.body.innerText || ''")
    except Exception:
        text = ""
    lines = [ln.strip() for ln in text.replace("\r", "").splitlines() if ln.strip()]
    return " | ".join(lines[:30])[:max_len]


def _scrape_results(page, limit: int) -> list[dict[str, Any]]:
    js = r"""
    (limit) => {
      const out = [];
      const rows = Array.from(document.querySelectorAll('.gs_r.gs_or.gs_scl'));
      for (const row of rows) {
        if (out.length >= limit) break;
        const titleAnchor = row.querySelector('.gs_rt a');
        const titleNode = row.querySelector('.gs_rt');
        const title = ((titleAnchor || titleNode)?.innerText || '')
          .replace(/^\[[^\]]+\]\s*/, '')
          .trim();
        if (!title) continue;
        const byline = (row.querySelector('.gs_a')?.innerText || '').trim();
        const snippet = (row.querySelector('.gs_rs')?.innerText || '').trim();
        const fullTextLinks = Array.from(row.querySelectorAll('.gs_or_ggsm a'))
          .map(a => ({
            label: (a.innerText || a.textContent || '').trim(),
            url: a.href || ''
          }))
          .filter(x => x.url);
        out.push({
          title,
          result_url: titleAnchor ? titleAnchor.href : '',
          byline,
          snippet,
          fulltext_links: fullTextLinks,
        });
      }
      return out;
    }
    """
    try:
        return page.evaluate(js, limit) or []
    except Exception:
        return []


def run(query: str | None, scrape_current: bool, limit: int) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        _, context = connect_browser(p)
        page = get_or_create_page(context)
        apply_stealth(page)

        if not scrape_current:
            assert query is not None
            page.goto(build_search_url(query), wait_until="domcontentloaded", timeout=60_000)
            human_pause(2.0, 4.0)
            try:
                page.wait_for_selector(".gs_r, #gs_res_ccl_mid", timeout=15_000)
            except Exception:
                pass
            human_pause(1.0, 2.0)

        body = _body_snippet(page)
        if looks_like_captcha(body) or "unusual traffic" in body.lower():
            return {
                "status": "captcha",
                "query": query,
                "url": page.url,
                "body_text_snippet": body,
                "message": (
                    "Google Scholar requires a manual verification. Complete it "
                    "in the open browser, then rerun the command."
                ),
            }

        results = _scrape_results(page, limit)
        return {
            "status": "ok" if results else "no_results",
            "query": query,
            "url": page.url,
            "count": len(results),
            "results": results,
            "body_text_snippet": body,
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", help="Google Scholar query")
    parser.add_argument(
        "--scrape-current",
        action="store_true",
        help="Skip navigation and scrape the current Scholar result page.",
    )
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()

    if not args.query and not args.scrape_current:
        parser.error("must provide --query or --scrape-current")

    print_json(run(args.query, args.scrape_current, args.limit))


if __name__ == "__main__":
    main()
