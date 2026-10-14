"""Search CNKI for a keyword and return candidate paper metadata as JSON.

Usage:
    python cnki_search.py --query "长期施肥 土壤有机碳" [--limit 20]
    python cnki_search.py --scrape-current      # just scrape whatever the
                                                 # browser is already showing

The script attaches to the already-running Chromium via CDP, so the
user's login and cookies are reused. It is intentionally forgiving about
selectors — CNKI changes its layout often, so we try several known
shapes and fall back to "all links that look like detail pages" if the
structured selectors miss.

Output is a JSON envelope:

    {
      "status": "ok" | "captcha" | "no_results" | "error",
      "query": "...",
      "url": "...",
      "results": [
        {"title": "...", "authors": "...", "source": "...", "year": "...",
         "detail_url": "https://kns.cnki.net/..."}
      ],
      "body_text_snippet": "...first few lines..."
    }
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


CNKI_SEARCH_URL = (
    "https://kns.cnki.net/kns8s/defaultresult/index?"
    "kw={kw}&korder=SU&crossids=YSTT4HG0%2CLSTPFY1C%2CJUP3MUPD%2C"
    "MPMFIG1A%2CEMRPGLPA%2CWQ0UVIAA%2CBLZOG7CK%2CPWFIRAGL%2CNLBO1Z6R%2CNN3FJMUV"
)


def _scrape_results(page, limit: int) -> list[dict[str, Any]]:
    """Pull the results grid off the current CNKI page, best-effort."""
    # Classic KNS8 result table: rows live under `.result-table-list tbody tr`
    # or `table.result-table-list tr`. Each row has a title <a> pointing at
    # a detail page. Authors, source and date are in adjacent <td>s.
    js = r"""
    (limit) => {
      const out = [];
      // Try several common containers — CNKI rewrites these regularly.
      const rowSelectors = [
        '.result-table-list tbody tr',
        'table.result-table-list tr',
        'tr[class*="result"]',
        '.search-table tr',
      ];
      let rows = [];
      for (const sel of rowSelectors) {
        const found = document.querySelectorAll(sel);
        if (found && found.length > 0) { rows = Array.from(found); break; }
      }
      // Skip header row if the first row has no title anchor.
      for (const row of rows) {
        if (out.length >= limit) break;
        const titleAnchor =
          row.querySelector('a.fz14') ||
          row.querySelector('td.name a') ||
          row.querySelector('td .name a') ||
          row.querySelector('a[href*="/kns"][href*="dbcode"]') ||
          row.querySelector('a[href*="detail"]');
        if (!titleAnchor) continue;
        const title = (titleAnchor.innerText || titleAnchor.textContent || '').trim();
        if (!title) continue;
        const tds = row.querySelectorAll('td');
        const cellText = (i) => tds[i] ? (tds[i].innerText || '').trim().replace(/\s+/g, ' ') : '';
        // Typical KNS8 cell order: checkbox, title, author, source, date, db, cited, download
        out.push({
          title,
          authors: cellText(2) || cellText(3),
          source: cellText(3) || cellText(4),
          year: cellText(4) || cellText(5),
          detail_url: titleAnchor.href,
        });
      }
      if (out.length === 0) {
        // Fallback: any anchor whose href looks like a CNKI detail page.
        const anchors = document.querySelectorAll('a[href*="dbcode"], a[href*="FileName"]');
        const seen = new Set();
        for (const a of anchors) {
          if (out.length >= limit) break;
          const href = a.href;
          if (seen.has(href)) continue;
          seen.add(href);
          const t = (a.innerText || a.textContent || '').trim();
          if (t.length < 5) continue;
          out.push({ title: t, authors: '', source: '', year: '', detail_url: href });
        }
      }
      return out;
    }
    """
    try:
        return page.evaluate(js, limit) or []
    except Exception:
        return []


def _body_snippet(page, max_len: int = 600) -> str:
    try:
        text = page.evaluate("() => document.body && document.body.innerText || ''")
    except Exception:
        text = ""
    if not text:
        return ""
    text = text.replace("\r", "").strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    joined = " | ".join(lines[:20])
    return joined[:max_len]


def run(query: str | None, scrape_current: bool, limit: int) -> dict[str, Any]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        _, context = connect_browser(p)
        page = get_or_create_page(context)
        apply_stealth(page)

        if not scrape_current:
            assert query is not None
            url = CNKI_SEARCH_URL.format(kw=urllib.parse.quote(query))
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
            human_pause(1.5, 3.0)
            # Wait for a result container if possible, but don't hard-fail.
            try:
                page.wait_for_selector(
                    ".result-table-list, table.result-table-list, .search-table",
                    timeout=15_000,
                )
            except Exception:
                pass
            human_pause(0.8, 2.0)

        body = _body_snippet(page)
        if looks_like_captcha(body):
            return {
                "status": "captcha",
                "query": query,
                "url": page.url,
                "body_text_snippet": body,
                "message": (
                    "CNKI 弹出了验证码 / 反爬拦截。请在已打开的浏览器里"
                    "手动完成验证后再重试。"
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
    parser.add_argument("--query", help="CNKI 主题检索关键词")
    parser.add_argument(
        "--scrape-current",
        action="store_true",
        help="Skip navigation — scrape whatever CNKI page is currently open.",
    )
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    if not args.query and not args.scrape_current:
        parser.error("must provide --query or --scrape-current")

    print_json(run(args.query, args.scrape_current, args.limit))


if __name__ == "__main__":
    main()
