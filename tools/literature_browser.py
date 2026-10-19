"""Visible database searches in the existing persistent, researcher-owned browser.

No credentials or challenge solutions are read.  Authentication pages are left
open for the researcher; only bibliographic result DOM is returned to callers.
The local target-id binding survives authentication redirects and never stores
the current page URL, cookies, or page text.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
from contextlib import contextmanager
from pathlib import Path
import re
import sys
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
SOC_SCRIPTS = ROOT / "SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/scripts"
SOURCES = {
    "google-scholar": ("Google Scholar", "https://scholar.google.com/scholar"),
    "cnki": ("中国知网", "https://kns.cnki.net/kns8s/defaultresult/index"),
    "web-of-science": ("Web of Science 核心合集", "https://www.webofscience.com/wos/woscc/basic-search"),
}
_AUTH_KEYS = re.compile(r"token|ticket|session|password|passwd|authorization|saml|signature|auth|^code$|^state$|^key$|^v$", re.I)
_AUTH_PATH = re.compile(r"(?:^|[/_.-])(?:login|signin|sign-in|authorize|oauth|saml|sso|callback)(?:$|[/_.-])", re.I)


def _dependencies():
    if str(SOC_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SOC_SCRIPTS))
    return importlib.import_module("common"), importlib.import_module("browser")


def ensure_browser():
    """Idempotently start/reuse the original persistent profile launcher."""
    _, browser = _dependencies()
    result = browser.launch()
    if result.get("status") not in ("launched", "already_running"):
        raise RuntimeError("本机检索浏览器未启动。")


@contextmanager
def _runtime():
    from playwright.sync_api import sync_playwright
    ensure_browser()
    common, _ = _dependencies()
    with sync_playwright() as playwright:
        _, context = common.connect_browser(playwright)
        yield context
    # The CDP connection may close; the persistent context/browser must not.


def safe_url(value: Any) -> str:
    """Bibliographic links only; never serialize authentication URLs/tokens."""
    try:
        parsed = urlsplit(str(value or ""))
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return ""
        if _AUTH_PATH.search(parsed.path) or re.search(r"(?:^|\.)(?:login|auth|sso|passport)(?:\.|$)", parsed.hostname, re.I):
            return ""
        pairs = parse_qs(parsed.query, keep_blank_values=True)
        # Authentication parameters make the entire link unsuitable for export.
        if any(_AUTH_KEYS.search(key) for key in pairs):
            if any(_AUTH_KEYS.search(key) and key.lower() != "v" for key in pairs):
                return ""
            pairs = {key: vals for key, vals in pairs.items() if not _AUTH_KEYS.search(key)}
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(pairs, doseq=True), ""))
    except (ValueError, TypeError):
        return ""


def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return default


def _binding_path(job_dir: str | Path | None) -> Path | None:
    return Path(job_dir) / "browser-tabs.json" if job_dir is not None else None


def _target_id(context, page) -> str:
    session = context.new_cdp_session(page)
    try:
        return str(session.send("Target.getTargetInfo")["targetInfo"]["targetId"])
    finally:
        session.detach()


def _save_binding(job_dir, source, target_id, query_hash=""):
    path = _binding_path(job_dir)
    if path is None:
        return
    data = _load_json(path, {})
    if not isinstance(data, dict):
        data = {}
    previous = data.get(source) if isinstance(data.get(source), dict) else {}
    data[source] = {"target_id": target_id, "label": SOURCES[source][0],
                    "query_hash": query_hash or previous.get("query_hash", "")}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _pick_page(context, source, job_dir):
    path = _binding_path(job_dir)
    bindings = _load_json(path, {}) if path else {}
    wanted = bindings.get(source, {}).get("target_id") if isinstance(bindings, dict) else None
    if wanted:
        for page in context.pages:
            try:
                if _target_id(context, page) == wanted:
                    return page, False
            except Exception:
                continue
    page = context.new_page()
    _save_binding(job_dir, source, _target_id(context, page))
    return page, True


# Only visible foreground DOM is inspected; raw body text is never returned or
# written to disk.  Queries and structured result data are separated here.
_SNAPSHOT_JS = r"""/* literature_snapshot */ ({source, limit}) => {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g, ' ');
  const first = (node, selectors) => { for (const sel of selectors) { const el = node.querySelector(sel); if (el) return el; } return null; };
  const visibleText = selectors => Array.from(document.querySelectorAll(selectors)).filter(visible).map(text).join(' ');
  const head = (document.body?.innerText || '').slice(0, 4500);
  const low = head.toLowerCase();
  const captcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="captcha"],.geetest_panel,.verifybox,#captcha,.captcha')).some(visible)
    || /人机验证|滑动验证|请完成验证|访问验证|验证码|unusual traffic|verify you are human|are you a robot|access denied.*bot/i.test(head.slice(0,1600));
  const password = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const explicitAccess = /您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|access is not available|you do not have access|not authorized to access/i.test(head);
  const loginPrompt = /请先登录|请登录后|登录后方可|sign in to access|sign in to search|log in to access|please sign in|please log in|access through your institution|institutional sign in|access web of science|选择机构|机构登录/i.test(head);
  const querySelectors = source === 'google-scholar' ? '#gs_hdr_tsi,input[name="q"]' : source === 'cnki'
    ? '#txt_SearchText,#txt_search,input[name="kw"],input[name="txt_1_value1"],.search-input'
    : '[data-ta="search-criteria-input"],#search-option,textarea[placeholder],input[aria-label*="Search"],input[placeholder*="Search"]';
  const queries = Array.from(document.querySelectorAll(querySelectors)).filter(visible).map(el => el.value || text(el)).filter(Boolean);
  const querySummary = visibleText('[data-ta="search-query"],.search-query,.query-text,.search-history-query,.searchResultQuery,.search-condition,.search-condition-list');
  if (querySummary) queries.push(querySummary);
  let rows = [], resultContainer = false, noResults = false;
  if (source === 'google-scholar') {
    rows = Array.from(document.querySelectorAll('.gs_r.gs_or.gs_scl'));
    resultContainer = !!document.querySelector('#gs_res_ccl_mid,#gs_res_ccl');
    noResults = /did not match any articles|no results found|找不到和您查询|没有找到与您/i.test(visibleText('#gs_res_ccl_mid,#gs_res_ccl'));
  } else if (source === 'cnki') {
    for (const sel of ['.result-table-list tbody tr','table.result-table-list tr','.search-table tr']) {
      rows = Array.from(document.querySelectorAll(sel)); if (rows.length) break;
    }
    resultContainer = !!document.querySelector('.result-table-list,.search-table,.result-list');
    noResults = /未找到|没有找到|暂无检索结果|检索结果为\s*0|共\s*0\s*条|0\s*条结果/i.test(visibleText('.no-result,.no-results,.no-data,.nodata,.result-tip,.result-blank,.result-count,.pagerTitleCell,.search-result')); 
  } else {
    for (const sel of ['app-record','app-summary-record','.summary-record','[data-ta="summary-record"]']) {
      rows = Array.from(document.querySelectorAll(sel)); if (rows.length) break;
    }
    resultContainer = !!document.querySelector('app-records-list,app-record-list,app-search-results,.records-list,[data-ta="search-results"]');
    noResults = /no records found|no results found|did not return any results|your search found no records|未找到记录|没有找到记录|检索结果为\s*0/i.test(visibleText('.no-results,app-no-results,[data-ta="no-results"],.no-records,.search-results-error,.empty-results'));
  }
  const results=[];
  for (const row of rows) {
    if (results.length >= limit || !visible(row)) continue;
    let a, title, authors='', byline='', venue='', year='', snippet='';
    if (source === 'google-scholar') {
      a = row.querySelector('.gs_rt a'); title=text(a || row.querySelector('.gs_rt')).replace(/^\[[^\]]+\]\s*/, '');
      byline=text(row.querySelector('.gs_a')); snippet=text(row.querySelector('.gs_rs'));
    } else if (source === 'cnki') {
      a = first(row,['a.fz14','td.name a','td .name a','a[href*="dbcode"]','a[href*="detail"]']); title=text(a);
      const cells=row.querySelectorAll('td');
      authors=text(row.querySelector('.author') || cells[2]); venue=text(row.querySelector('.source') || cells[3]);
      year=text(row.querySelector('.date') || cells[4]); snippet=text(row.querySelector('.abstract,.snippet'));
    } else {
      a=first(row,['a[data-ta="summary-record-title-link"]','a.summary-title','h3 a','.title a','a[href*="/full-record/"]']); title=text(a);
      authors=text(first(row,['[data-ta="summary-record-authors"]','.summary-authors','.authors']));
      venue=text(first(row,['[data-ta="summary-record-source"]','.summary-source','.source-title','.publication-title']));
      year=text(first(row,['[data-ta="summary-record-pubdate"]','.published-info','.summary-pubdata','.summary-record-pub-data','.publication-date']));
      snippet=text(row.querySelector('.abstract,.summary-abstract,.snippet'));
    }
    if (!title) continue;
    const fulltext_links=Array.from(row.querySelectorAll(source==='google-scholar' ? '.gs_or_ggsm a' : 'a[href$=".pdf"],a[href*="download"],a[data-ta*="full-text"],a.full-text'))
      .map(link=>({label:text(link),url:link.href})).filter(link=>link.url);
    const doiAnchor=row.querySelector('a[href*="doi.org/"]');
    const doiMatch=text(row).match(/\b10\.\d{4,9}\/[^\s<>"']+/i);
    results.push({title,authors,byline:byline||authors,venue,year,result_url:a?.href||'',snippet,fulltext_links,
      doi:doiAnchor ? doiAnchor.href.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'') : (doiMatch?.[0] || '')});
  }
  return {captcha:!!captcha,password,loginPrompt,accessRequired:explicitAccess,queries,results,resultContainer,noResults};
}"""


def _snapshot(page, source, limit):
    return page.evaluate(_SNAPSHOT_JS, {"source": source, "limit": limit})


def _normalized(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def _matches_query(snapshot, page_url, source, query):
    expected = _normalized(query)
    if not expected:
        return False
    observed = list(snapshot.get("queries") or [])
    if observed:
        # A stale URL parameter must not overrule a newer query typed by the
        # researcher into an AJAX result page.
        return any(expected == _normalized(value) for value in observed)
    try:
        parsed = urlsplit(page_url)
        if source == "cnki" and parsed.hostname and parsed.hostname.endswith("cnki.net"):
            observed.extend(parse_qs(parsed.query).get("kw", []))
        if source == "google-scholar" and parsed.hostname == "scholar.google.com":
            observed.extend(parse_qs(parsed.query).get("q", []))
    except ValueError:
        pass
    return any(expected == _normalized(value) for value in observed)


def _auth_reason(page, snapshot):
    if snapshot.get("captcha"):
        return "verification"
    if snapshot.get("accessRequired"):
        return "access_required"
    try:
        parsed = urlsplit(page.url)
        auth_url = bool(_AUTH_PATH.search(parsed.path) or re.search(r"(?:^|\.)(?:login|auth|sso|passport)(?:\.|$)", parsed.hostname or "", re.I))
        legacy_access = (parsed.hostname or "").lower() in ("webofknowledge.com", "www.webofknowledge.com")
        clarivate_auth = (parsed.hostname or "").lower() in ("access.clarivate.com", "login.clarivate.com", "auth.clarivate.com")
    except ValueError:
        auth_url = True
        legacy_access = clarivate_auth = False
    # A navigation bar 'Sign in' is not a mandatory login requirement.
    if auth_url or clarivate_auth or snapshot.get("password") or (snapshot.get("loginPrompt") and not snapshot.get("results")):
        return "login"
    if legacy_access and not snapshot.get("results"):
        return "access_required"
    return None


_MESSAGES = {
    "login": "需要登录。请在该任务已打开的官方页面中完成个人或机构登录，然后回工作台检查并继续。",
    "verification": "需要人工验证。请在该任务已打开的页面中完成验证码，再回工作台检查并继续。",
    "access_required": "当前会话没有所需数据库访问权限。请使用学校机构授权或授权网络登录后，回工作台检查并继续。",
    "results_unrecognized": "尚不能确认本次检索的结果页面。请查看该任务的官方页面，确认检索式和结果已加载后再继续。",
}


def _envelope(source, status, *, results=None, reason=None, year_from=None, year_to=None):
    applied = {}
    deferred = []
    if source == "google-scholar" and status in ("ok", "no_results"):
        if year_from is not None:
            applied["publicationYearFrom"] = year_from
        if year_to is not None:
            applied["publicationYearTo"] = year_to
    elif year_from is not None or year_to is not None:
        deferred.append("发表年份范围由结果后筛执行；未在数据库 UI 中设置年份过滤。")
    return {"status": status, "reason": reason, "message": _MESSAGES.get(reason, ""),
            "source_key": source, "url": SOURCES[source][1], "results": results or [],
            "applied_filters": applied, "deferred_rules": deferred}


def _first_visible(page, selectors):
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(min(locator.count(), 10)):
            item = locator.nth(index)
            if item.is_visible():
                return item
    return None


def _wait_results(page, source):
    selectors = {
        "google-scholar": '.gs_r,#gs_res_ccl_mid,#gs_captcha_ccl',
        "cnki": '.result-table-list,.search-table,.no-result,.no-data,input[type="password"]',
        "web-of-science": 'app-record,app-summary-record,.summary-record,app-no-results,[data-ta="no-results"],input[type="password"]',
    }
    try:
        page.wait_for_selector(selectors[source], timeout=15_000)
    except Exception:
        # A redirect to SSO or a changed layout is classified from foreground DOM.
        pass


def _submit_wos(page, query):
    # The official Core Collection basic-search URL is fixed.  No fabricated
    # undocumented URL search parameters or copied session identifiers are used.
    topic = re.fullmatch(r"\s*TS\s*=\s*\((.*)\)\s*", query, re.I | re.S)
    # A persistent profile may remember Author/Title from a previous search.
    # Confirm Topic for every query, including ordinary unprefixed expressions.
    picker = _first_visible(page, [
        '[data-ta="search-field-dropdown"]', '[data-ta="search-field"]',
        'mat-select[aria-label*="Search field"]', 'button[aria-label*="Search field"]',
    ])
    if picker is None:
        return False

    def is_topic(control):
        return bool(re.fullmatch(r"(?:topic(?:\s*\(ts\))?|主题)(?:\s*[▾▼⌄])?", _normalized(control.inner_text()), re.I))

    if not is_topic(picker):
        picker.click()
        option = _first_visible(page, ['mat-option:has-text("Topic")', '[role="option"]:has-text("Topic")',
                                       '[role="option"]:has-text("主题")'])
        if option is None:
            return False
        option.click()
        # Selecting an option is insufficient if the UI did not actually apply it.
        if not is_topic(picker):
            return False
    if topic:
        # Basic search uses a field picker, unlike advanced-search TS= syntax.
        query = topic.group(1).strip()
    field = _first_visible(page, [
        'textarea[data-ta="search-criteria-input"]', 'input[data-ta="search-criteria-input"]',
        '[data-ta="search-criteria-input"] textarea', '[data-ta="search-criteria-input"] input',
        'textarea#search-option', 'input#search-option',
        'textarea[aria-label*="Search"]', 'textarea[placeholder*="Search"]',
        'textarea[placeholder*="search"]', 'input[aria-label*="Search"]',
        'input[placeholder*="Search"]',
    ])
    if field is None:
        return False
    field.fill(query)
    if _normalized(field.input_value()) != _normalized(query):
        return False
    button = _first_visible(page, [
        'button[data-ta="run-search"]', 'button[data-ta="search-button"]',
        'button[data-ta="submit-search"]', 'button[type="submit"]',
        'button:has-text("Search")', 'button:has-text("检索")',
    ])
    if button is None:
        return False
    button.click()
    _wait_results(page, "web-of-science")
    return True


def _navigate_search(page, source, query, year_from, year_to):
    if source == "google-scholar":
        common, _ = _dependencies()
        del common
        scholar = importlib.import_module("google_scholar_search")
        url = scholar.build_search_url(query, year_from, year_to)
    elif source == "cnki":
        url = SOURCES[source][1] + "?" + urlencode({"kw": query, "korder": "SU"})
    else:
        url = SOURCES[source][1]
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    if source == "web-of-science":
        try:
            page.wait_for_selector('textarea,input[type="password"],input[data-ta="search-criteria-input"]', timeout=15_000)
        except Exception:
            pass
        return _submit_wos(page, query)
    _wait_results(page, source)
    return True


def _clean_results(rows, limit):
    cleaned = []
    for row in rows:
        if not isinstance(row, dict) or not str(row.get("title") or "").strip():
            continue
        item = {key: str(row.get(key) or "").strip()[:5000] for key in
                ("title", "authors", "byline", "venue", "year", "doi", "snippet")}
        item["result_url"] = safe_url(row.get("result_url"))
        item["fulltext_links"] = [{"label": str(link.get("label") or "")[:300], "url": safe_url(link.get("url"))}
                                  for link in row.get("fulltext_links", []) if isinstance(link, dict) and safe_url(link.get("url"))]
        if not item["result_url"] and not item["doi"]:
            continue
        cleaned.append(item)
        if len(cleaned) >= limit:
            break
    return cleaned


def run(source_key, query, scrape_current, limit, year_from=None, year_to=None, *, job_dir=None):
    """Search/continue exactly this job's source tab in the persistent browser."""
    if source_key not in SOURCES:
        return {"status": "error", "reason": None, "message": "该检索来源未接通。", "source_key": source_key,
                "url": "", "results": [], "applied_filters": {}, "deferred_rules": []}
    if not isinstance(query, str) or not query.strip() or len(query) > 2000:
        return {**_envelope(source_key, "error"), "message": "检索式无效。"}
    limit = max(1, min(int(limit), 10))
    options = {"year_from": year_from, "year_to": year_to}
    page = None
    try:
        with _runtime() as context:
            page, created = _pick_page(context, source_key, job_dir)
            page.bring_to_front()
            submitted = False
            if not scrape_current or created:
                submitted = _navigate_search(page, source_key, query, year_from, year_to)
            snapshot = _snapshot(page, source_key, limit)
            reason = _auth_reason(page, snapshot)
            if reason:
                return _envelope(source_key, "attention", reason=reason, **options)
            verified = _matches_query(snapshot, page.url, source_key, query)
            if scrape_current and not created and not verified:
                # SSO often returns to basic search. Re-submit the frozen query
                # through that UI; do not scrape a different manually-run query.
                submitted = _navigate_search(page, source_key, query, year_from, year_to)
                snapshot = _snapshot(page, source_key, limit)
                reason = _auth_reason(page, snapshot)
                if reason:
                    return _envelope(source_key, "attention", reason=reason, **options)
                verified = _matches_query(snapshot, page.url, source_key, query)
            if not verified and not (source_key == "web-of-science" and submitted):
                return _envelope(source_key, "attention", reason="results_unrecognized", **options)
            rows = _clean_results(snapshot.get("results") or [], limit)
            if rows:
                fingerprint = hashlib.sha256(query.encode("utf-8")).hexdigest()
                _save_binding(job_dir, source_key, _target_id(context, page), fingerprint)
                return _envelope(source_key, "ok", results=rows, **options)
            if snapshot.get("noResults"):
                return _envelope(source_key, "no_results", **options)
            return _envelope(source_key, "attention", reason="results_unrecognized", **options)
    except Exception:
        if page is not None:
            try:
                # Navigation can time out after SSO has opened. Keep the task
                # resumable without exporting the redirect from the exception.
                reason = _auth_reason(page, _snapshot(page, source_key, limit))
                if reason:
                    return _envelope(source_key, "attention", reason=reason, **options)
            except Exception:
                pass
        # Exception text can contain SSO redirect URLs; deliberately fixed text.
        return {**_envelope(source_key, "error", **options),
                "message": "检索浏览器操作未完成。请检查本机检索浏览器是否可用，再继续该任务。"}


def _check_open_source(source, job_dir):
    if source not in SOURCES:
        raise ValueError("该检索来源未接通。")
    config = _load_json(Path(job_dir) / "run_config.json", {})
    checkpoint = _load_json(Path(job_dir) / "discovery-state.json", {})
    sources = config.get("sources", []) if isinstance(config, dict) else []
    selected = [value.get("key") if isinstance(value, dict) else value for value in sources]
    if source not in selected or checkpoint.get("pending_source") != source:
        raise ValueError("该任务没有等待此来源的人工处理。")


def open_source(source_key, *, job_dir):
    """Foreground the waiting task tab, preserving its official login page."""
    _check_open_source(source_key, job_dir)
    with _runtime() as context:
        page, created = _pick_page(context, source_key, job_dir)
        if created:
            config = _load_json(Path(job_dir) / "run_config.json", {})
            query = config.get("sourceQueries", {}).get(source_key) or config.get("query", "")
            if source_key == "web-of-science":
                page.goto(SOURCES[source_key][1], wait_until="domcontentloaded", timeout=60_000)
            else:
                _navigate_search(page, source_key, query, config.get("publicationYearFrom"), config.get("publicationYearTo"))
        page.bring_to_front()
    return {"opened": True, "source": source_key, "label": SOURCES[source_key][0],
            "message": "已打开该任务的官方检索页面，请在页面中完成登录或验证。"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--open-source", required=True, choices=tuple(SOURCES))
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    try:
        _check_open_source(args.open_source, args.output_dir)
        _, browser = _dependencies()
        launch = browser.launch()
        if launch.get("status") not in ("launched", "already_running"):
            raise RuntimeError("浏览器未启动")
        result = open_source(args.open_source, job_dir=args.output_dir)
        code = 0
    except Exception:
        result = {"opened": False, "error": "无法打开该任务的检索页面，请检查任务等待状态和本机浏览器环境。"}
        code = 1
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
