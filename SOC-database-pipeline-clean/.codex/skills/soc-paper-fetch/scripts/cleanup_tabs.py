"""List or close excess tabs in the persistent Chromium session.

Usage:
    python cleanup_tabs.py
    python cleanup_tabs.py --close
    python cleanup_tabs.py --close --keep-recent 5
    python cleanup_tabs.py --close --keep-domain scholar.google.com --keep-domain sciencedirect.com

The default mode is dry-run. It only reports which tabs would be closed.
Use --close to actually close tabs.
"""
from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from typing import Any

from common import CDP_URL, cdp_alive, print_json


DEFAULT_KEEP_DOMAINS = [
    "scholar.google.com",
    "accounts.google.com",
    "google.com",
    "sciencedirect.com",
    "elsevier.com",
    "link.springer.com",
]


def _get_json(path: str) -> Any:
    with urllib.request.urlopen(f"{CDP_URL}{path}", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _close_target(target_id: str) -> bool:
    encoded = urllib.parse.quote(target_id, safe="")
    with urllib.request.urlopen(f"{CDP_URL}/json/close/{encoded}", timeout=10) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    return "Target is closing" in body or resp.status == 200


def _hostname(url: str) -> str:
    try:
        return urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""


def _matches_domain(host: str, domains: list[str]) -> bool:
    host = host.lower()
    for domain in domains:
        d = domain.lower().lstrip(".")
        if host == d or host.endswith("." + d):
            return True
    return False


def cleanup(
    *,
    close: bool,
    keep_recent: int,
    keep_domains: list[str],
    close_blank: bool,
) -> dict[str, Any]:
    if not cdp_alive():
        return {"status": "down", "cdp_url": CDP_URL}

    targets = [t for t in _get_json("/json") if t.get("type") == "page"]
    protected_ids = set()

    if keep_recent > 0:
        for t in targets[:keep_recent]:
            protected_ids.add(t.get("id"))

    keep_domains = list(dict.fromkeys(keep_domains))
    kept: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    closed: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for t in targets:
        url = t.get("url") or ""
        title = t.get("title") or ""
        tid = t.get("id")
        host = _hostname(url)
        reason = ""

        if tid in protected_ids:
            reason = "recent"
        elif _matches_domain(host, keep_domains):
            reason = "protected_domain"
        elif url in ("", "about:blank") and not close_blank:
            reason = "blank"

        item = {"id": tid, "title": title, "url": url}
        if reason:
            item["reason"] = reason
            kept.append(item)
            continue

        candidates.append(item)
        if close and tid:
            try:
                if _close_target(tid):
                    closed.append(item)
                else:
                    failed.append({**item, "error": "close returned false"})
            except Exception as exc:
                failed.append({**item, "error": str(exc)})

    return {
        "status": "closed" if close else "dry_run",
        "total_pages": len(targets),
        "kept_count": len(kept),
        "candidate_count": len(candidates),
        "closed_count": len(closed),
        "failed_count": len(failed),
        "keep_recent": keep_recent,
        "keep_domains": keep_domains,
        "close_blank": close_blank,
        "kept": kept,
        "candidates": candidates,
        "closed": closed,
        "failed": failed,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--close", action="store_true", help="Actually close candidate tabs.")
    parser.add_argument(
        "--keep-recent",
        type=int,
        default=3,
        help="Keep the first N tabs reported by Chromium CDP. Default: 3.",
    )
    parser.add_argument(
        "--keep-domain",
        action="append",
        default=[],
        help="Domain to protect from closing. Can be repeated.",
    )
    parser.add_argument(
        "--no-default-keep-domains",
        action="store_true",
        help="Do not protect the default Scholar/Google/publisher domains.",
    )
    parser.add_argument(
        "--close-blank",
        action="store_true",
        help="Close about:blank tabs too. By default blank tabs are kept.",
    )
    args = parser.parse_args()

    keep_domains = [] if args.no_default_keep_domains else DEFAULT_KEEP_DOMAINS[:]
    keep_domains.extend(args.keep_domain)
    result = cleanup(
        close=args.close,
        keep_recent=max(args.keep_recent, 0),
        keep_domains=keep_domains,
        close_blank=args.close_blank,
    )
    print_json(result)


if __name__ == "__main__":
    main()
