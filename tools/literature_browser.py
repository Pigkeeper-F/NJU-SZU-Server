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
import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

import literature_extra_sources as extra_sources
import literature_pubmed


ROOT = Path(__file__).resolve().parents[1]
SOC_SCRIPTS = ROOT / "SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/scripts"
SOURCES = {
    "google-scholar": ("Google Scholar", "https://scholar.google.com/scholar"),
    "cnki": ("中国知网", "https://kns.cnki.net/kns8s/defaultresult/index"),
    "web-of-science": ("Web of Science 核心合集", "https://www.webofscience.com/wos/woscc/basic-search"),
    **extra_sources.SOURCE_INFO,
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


def _save_binding(job_dir, source, target_id, query_hash="", *, page_index=None, result_fingerprint=""):
    path = _binding_path(job_dir)
    if path is None:
        return
    data = _load_json(path, {})
    if not isinstance(data, dict):
        data = {}
    previous = data.get(source) if isinstance(data.get(source), dict) else {}
    data[source] = {"target_id": target_id, "label": SOURCES[source][0],
                    "query_hash": query_hash or previous.get("query_hash", "")}
    if page_index is not None:
        data[source].update(page_index=page_index, result_fingerprint=result_fingerprint)
    elif previous.get("target_id") == target_id and previous.get("query_hash") == data[source]["query_hash"]:
        for key in ("page_index", "result_fingerprint"):
            if key in previous:
                data[source][key] = previous[key]
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
  return {captcha:!!captcha,password,loginPrompt,accessRequired:explicitAccess,queries,results,resultContainer,noResults,
    visible_result_count:rows.filter(visible).length};
}"""


def _snapshot(page, source, limit):
    if source in extra_sources.SOURCE_INFO:
        return extra_sources.snapshot(page, source, limit)
    return page.evaluate(_SNAPSHOT_JS, {"source": source, "limit": limit})


def _normalized(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def _matches_query(snapshot, page_url, source, query):
    def comparable(value):
        normalized = _normalized(value)
        wrapper = re.fullmatch(r"title-abs-key\s*\((.*)\)", normalized, re.S) if source == "scopus" else None
        if source == "web-of-science":
            wrapper = re.fullmatch(r"ts\s*=\s*\((.*)\)", normalized, re.S)
        if wrapper:
            return wrapper.group(1).strip()
        return normalized

    expected = comparable(query)
    if not expected:
        return False
    observed = list(snapshot.get("queries") or [])
    if observed:
        # A stale URL parameter must not overrule a newer query typed by the
        # researcher into an AJAX result page.
        return any(expected == comparable(value) for value in observed)
    try:
        parsed = urlsplit(page_url)
        if source == "cnki" and parsed.hostname and parsed.hostname.endswith("cnki.net"):
            observed.extend(parse_qs(parsed.query).get("kw", []))
        if source == "google-scholar" and parsed.hostname == "scholar.google.com":
            observed.extend(parse_qs(parsed.query).get("q", []))
        if source == "pubmed" and parsed.hostname == "pubmed.ncbi.nlm.nih.gov":
            observed.extend(parse_qs(parsed.query).get("term", []))
        if source == "wanfang" and parsed.hostname == "s.wanfangdata.com.cn":
            observed.extend(parse_qs(parsed.query).get("q", []))
    except ValueError:
        pass
    return any(expected == comparable(value) for value in observed)


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


def _envelope(source, status, *, results=None, reason=None, year_from=None, year_to=None, transport="browser"):
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
            "applied_filters": applied, "deferred_rules": deferred, "transport": transport}


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
    if source in extra_sources.SOURCE_INFO:
        return extra_sources.navigate(page, source, query, year_from, year_to)
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
        if re.fullmatch(r"[0-9]+", str(row.get("pmid") or "")):
            item["pmid"] = str(row["pmid"])
        item["result_url"] = safe_url(row.get("result_url"))
        item["fulltext_links"] = [{"label": str(link.get("label") or "")[:300], "url": safe_url(link.get("url"))}
                                  for link in row.get("fulltext_links", []) if isinstance(link, dict) and safe_url(link.get("url"))]
        if not item["result_url"] and not item["doi"]:
            continue
        cleaned.append(item)
        if len(cleaned) >= limit:
            break
    return cleaned


_NEXT_SELECTORS = {
    "google-scholar": ['#gs_n a:has(.gs_ico_nav_next)', '#gs_n a[aria-label="Next"]',
                       '#gs_n a:has-text("Next")', '#gs_n a:has-text("下一页")'],
    "cnki": ['#PageNext', '.pages a:has-text("下一页")', '.pager a:has-text("下一页")',
             '.pagination a:has-text("下一页")', '.pagination button:has-text("下一页")'],
    "web-of-science": ['button[data-ta="next-page"]', 'button[aria-label="Next Page"]',
                       'button[aria-label="Next page"]', 'button[aria-label="下一页"]',
                       'app-page-controls button:has-text("Next")'],
    "wanfang": ['.bottom-pagination .next', '.small-paginate .ctrl-btn:text-is(">")',
                '.el-pagination .btn-next', '.ant-pagination-next button',
                '.pagination a:has-text("下一页")', '.pagination button:has-text("下一页")',
                '.pagination li.next a'],
    "scopus": ['button[data-testid="next-page"]', 'button[aria-label="Next page"]',
               'button[aria-label="Next Page"]', 'button[aria-label="下一页"]',
               '.pagination-next button', '[aria-label="Pagination"] button:has-text("Next")'],
    "pubmed": ['.search-results button.load-button.next-page', '.search-results button:has-text("Show more")',
               '.pagination button.next-page-btn', '.pagination a.next-page-btn'],
}

_PAGINATION_JS = r"""/* literature_pagination */ ({source}) => {
  const visible=el=>!!el && !!(el.offsetWidth||el.offsetHeight||el.getClientRects().length)
    && getComputedStyle(el).visibility!=='hidden' && getComputedStyle(el).display!=='none';
  const text=el=>(el?.innerText||el?.textContent||'').trim().replace(/\s+/g,' ');
  const first=selectors=>Array.from(document.querySelectorAll(selectors)).find(visible);
  const selectors={
    'google-scholar':'#gs_ab_md',cnki:'.pagerTitleCell,.result-count,.total-count',
    'web-of-science':'[data-ta="search-results-count"],.results-count',
    wanfang:'.total-number .mark-number,.search-result-count,.result-count,.el-pagination__total',
    scopus:'h2[data-testid="label-search-results-header"],[data-testid="results-count"],[data-testid="document-results-count"]',
    pubmed:'.results-amount .value,.results-amount'
  };
  const countText=text(first(selectors[source]||'.result-count'));
  let total=null;
  const patterns=source==='pubmed' ? [/^([\d,]+)(?:\s+results?)?$/i]
    : source==='google-scholar' ? [/(?:about|约)\s*([\d,]+)\s*(?:results?|条)/i,/^([\d,]+)\s+results?/i]
    : source==='wanfang' ? [/^([\d,]+)$/,/(?:共|找到)\s*([\d,]+)\s*(?:条|篇)/]
    : [/(?:共|找到|检索到)\s*([\d,]+)\s*(?:条|篇)/,/^([\d,]+)\s*(?:documents?|results?|records?)/i];
  for(const pattern of patterns) {const match=countText.match(pattern); if(match) {total=Number(match[1].replace(/,/g,''));break;}}
  // A pager ending at its active final number is only proof when it also
  // explicitly reports the last page; absence of a Next button alone is not.
  let end=Array.from(document.querySelectorAll('[data-testid="last-page-message"],.pagination-end,.pager-end'))
    .some(el=>visible(el)&&/end of results|last page|已到最后|没有更多|无更多结果/i.test(text(el)));
  if(source==='wanfang') {
    const pages=text(first('.small-paginate .page-number')).match(/^(\d+)\s*\/\s*(\d+)$/);
    if(pages && Number(pages[2])>0 && Number(pages[1])===Number(pages[2])) end=true;
  }
  return {total_count:Number.isSafeInteger(total)&&total>=0?total:null,explicit_end:end};
}"""


def _next_control(page, source):
    return _first_visible(page, _NEXT_SELECTORS[source])


def _control_disabled(control):
    try:
        if not control.is_enabled():
            return True
        if control.get_attribute("disabled") is not None or control.get_attribute("aria-disabled") == "true":
            return True
        return bool(control.evaluate("el => !!el.closest('[disabled],[aria-disabled=\"true\"],.disabled,.is-disabled,.ant-pagination-disabled')"))
    except Exception:
        # Unknown actionability cannot be used as evidence of the final page.
        return None


def _pagination(page, source):
    try:
        data = page.evaluate(_PAGINATION_JS, {"source": source})
    except Exception:
        data = {}
    control = _next_control(page, source)
    disabled = _control_disabled(control) if control is not None else None
    has_next = False if data.get("explicit_end") else not disabled if disabled is not None else None
    return {"has_next": has_next, "total_count": data.get("total_count")}


def _row_fingerprint(snapshot):
    rows = [{key: row.get(key) for key in ("title", "result_url", "doi", "pmid")}
            for row in snapshot.get("results") or [] if isinstance(row, dict)]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _official_result_page(page, source):
    try:
        parsed = urlsplit(page.url)
        host = (parsed.hostname or "").lower()
        domain = {"google-scholar": "scholar.google.com", "cnki": "cnki.net",
                  "web-of-science": "webofscience.com", "wanfang": "wanfangdata.com.cn",
                  "scopus": "scopus.com", "pubmed": "pubmed.ncbi.nlm.nih.gov"}[source]
        return parsed.scheme in ("https", "http") and (host == domain or host.endswith("." + domain))
    except ValueError:
        return False


def _query_consistent(snapshot, page, source, query, *, submitted=False, trusted=False):
    # A visible changed query always invalidates the prior target/page proof.
    if snapshot.get("queries"):
        return _matches_query(snapshot, page.url, source, query)
    return _matches_query(snapshot, page.url, source, query) or submitted or trusted


def _advance_page(page, source, previous, limit):
    control = _next_control(page, source)
    if control is None or _control_disabled(control) is not False:
        return None
    before = _row_fingerprint(previous)
    control.click(timeout=15_000)
    # A click can load an AJAX page or open an authentication screen.  Wait for
    # changed bibliographic rows/auth DOM; existing result nodes are insufficient.
    deadline = time.monotonic() + 15
    while True:
        current = _snapshot(page, source, limit)
        if (_auth_reason(page, current) or current.get("noResults")
                or (current.get("results") and _row_fingerprint(current) != before)):
            return current
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.2)


def _pubmed_transport(job_dir, query, *, save=None):
    """Lock a task's public transport so API offsets never become browser pages."""
    if job_dir is None:
        return None
    path = Path(job_dir) / "pubmed-transport.json"
    fingerprint = hashlib.sha256(query.encode("utf-8")).hexdigest()
    if save is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"query_hash": fingerprint, "transport": save}), encoding="utf-8")
        temporary.replace(path)
        return save
    if not path.exists():
        return None
    value = _load_json(path, {})
    if (not isinstance(value, dict) or value.get("query_hash") != fingerprint
            or value.get("transport") not in ("ncbi_eutilities", "browser_after_api_error")):
        raise ValueError("PubMed 任务传输检查点无效，请新建任务以免混用分页结果。")
    return value["transport"]


def run(source_key, query, scrape_current, limit, year_from=None, year_to=None, *, job_dir=None,
        page_index=0, full_page=False):
    """Read one proven results page, optionally advancing this job's bound tab.

    The discovery driver owns page checkpoints and aggregate target counts.
    Browser pages may contain 20/50 records; formal runs read the whole visible
    page rather than skipping everything after a ten-record API batch.
    """
    if source_key not in SOURCES:
        return {"status": "error", "reason": None, "message": "该检索来源未接通。", "source_key": source_key,
                "url": "", "results": [], "applied_filters": {}, "deferred_rules": []}
    if not isinstance(query, str) or not query.strip() or len(query) > 2000:
        return {**_envelope(source_key, "error"), "message": "检索式无效。"}
    if isinstance(page_index, bool) or not isinstance(page_index, int) or not 0 <= page_index <= 999:
        return {**_envelope(source_key, "error"), "message": "检索页码必须为 0 到 999。"}
    limit = max(1, min(int(limit), 10))
    read_limit = 200 if full_page else limit
    api_failed = False
    try:
        pubmed_transport = _pubmed_transport(job_dir, query) if source_key == "pubmed" else None
    except Exception:
        return {**_envelope(source_key, "error"), "message": "PubMed 分页传输检查点无效；请保留已有成果并新建检索任务。"}
    if source_key == "pubmed" and scrape_current and pubmed_transport is None:
        try:
            pubmed_transport = _pubmed_transport(job_dir, query, save="browser_after_api_error")
        except Exception:
            return {**_envelope(source_key, "error"), "message": "PubMed 分页传输检查点未能保存，请重试当前任务。"}
    if source_key == "pubmed" and (pubmed_transport == "ncbi_eutilities" or
                                   (not scrape_current and pubmed_transport != "browser_after_api_error")):
        api_options = {"page_index": page_index} if page_index else {}
        result = literature_pubmed.run(query, limit=limit, year_from=year_from, year_to=year_to, **api_options)
        if result.get("status") in ("ok", "no_results"):
            try:
                _pubmed_transport(job_dir, query, save="ncbi_eutilities")
            except Exception:
                return {**_envelope(source_key, "error"), "message": "PubMed 分页传输检查点未能保存，请重试当前任务。"}
            return result
        if pubmed_transport == "ncbi_eutilities" or page_index > 0:
            # API pages are fixed ten-record offsets; browser pages can have
            # another size.  Switching here would skip or duplicate records.
            return result
        try:
            _pubmed_transport(job_dir, query, save="browser_after_api_error")
        except Exception:
            return {**_envelope(source_key, "error"), "message": "PubMed 分页传输检查点未能保存，请重试当前任务。"}
        api_failed = True
    options = {"year_from": year_from, "year_to": year_to}
    if api_failed or pubmed_transport == "browser_after_api_error":
        options["transport"] = "browser_after_api_error"
    page = None
    current = None

    def response(status, *, results=None, reason=None, pagination=None):
        output = _envelope(source_key, status, results=results, reason=reason, **options)
        output.update(page_index=page_index, has_next=None, total_count=None)
        if pagination:
            output.update(pagination)
        return output

    try:
        with _runtime() as context:
            page, created = _pick_page(context, source_key, job_dir)
            page.bring_to_front()
            query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()
            bindings = _load_json(_binding_path(job_dir), {}) if job_dir is not None else {}
            binding = bindings.get(source_key, {}) if isinstance(bindings, dict) else {}
            proven_index = None
            if scrape_current or page_index:
                current = _snapshot(page, source_key, read_limit)
                reason = _auth_reason(page, current)
                if reason:
                    return response("attention", reason=reason)
                if (not created and binding.get("query_hash") == query_hash
                        and isinstance(binding.get("page_index"), int)
                        and binding.get("result_fingerprint") == _row_fingerprint(current)
                        and _official_result_page(page, source_key)
                        and _query_consistent(current, page, source_key, query, trusted=True)):
                    proven_index = binding["page_index"]
            use_bound = proven_index in (page_index, page_index - 1) if page_index else proven_index == 0
            verified = bool(current and _matches_query(current, page.url, source_key, query))
            if source_key == "scopus" and verified:
                verified = extra_sources.query_context_valid(page, source_key)
            # Keep the legacy manual first-batch behavior. Formal runs without
            # proof re-submit from page one: an identical query can be on page N.
            manual_first = (scrape_current and not full_page and not created and page_index == 0
                            and verified and binding.get("page_index", 0) == 0)
            if use_bound:
                current_index = proven_index
            elif manual_first:
                current_index = 0
            else:
                submitted = _navigate_search(page, source_key, query, year_from, year_to)
                current = _snapshot(page, source_key, read_limit)
                reason = _auth_reason(page, current)
                if reason:
                    return response("attention", reason=reason)
                verified = _matches_query(current, page.url, source_key, query)
                if source_key == "scopus":
                    verified = verified and extra_sources.query_context_valid(page, source_key)
                if not verified and not (source_key in ("web-of-science", "scopus") and submitted and not current.get("queries")):
                    return response("attention", reason="results_unrecognized")
                current_index = 0
            while current_index < page_index:
                if not _official_result_page(page, source_key):
                    return response("attention", reason="results_unrecognized")
                pagination = _pagination(page, source_key)
                if pagination["has_next"] is False:
                    return response("ok", pagination={**pagination, "has_next": False})
                advanced = _advance_page(page, source_key, current, read_limit)
                if advanced is None:
                    return response("attention", reason="results_unrecognized", pagination=pagination)
                current = advanced
                reason = _auth_reason(page, current)
                if reason:
                    return response("attention", reason=reason)
                if not _official_result_page(page, source_key) or not _query_consistent(current, page, source_key, query, trusted=True):
                    return response("attention", reason="results_unrecognized")
                current_index += 1
                # Only bibliographic fingerprints and page numbers are persisted.
                _save_binding(job_dir, source_key, _target_id(context, page), query_hash,
                              page_index=current_index, result_fingerprint=_row_fingerprint(current))
            if (full_page or page_index) and not _official_result_page(page, source_key):
                return response("attention", reason="results_unrecognized")
            if full_page and current.get("visible_result_count", 0) > read_limit:
                result = response("attention", reason="results_unrecognized")
                result["message"] = "当前数据库每页超过200条；请在官方页面将每页显示量调到200或以下，再检查并继续，避免翻页时遗漏记录。"
                return result
            raw_rows = current.get("results") or []
            if source_key == "wanfang" and raw_rows:
                raw_rows = extra_sources.resolve_result_links(page, source_key, raw_rows, read_limit)
                if any(not safe_url(row.get("result_url")) and not row.get("doi") for row in raw_rows):
                    return response("attention", reason="results_unrecognized")
            rows = _clean_results(raw_rows, read_limit)
            pagination = _pagination(page, source_key)
            if rows:
                _save_binding(job_dir, source_key, _target_id(context, page), query_hash,
                              page_index=page_index, result_fingerprint=_row_fingerprint(current))
                result = response("ok", results=rows, pagination=pagination)
                if api_failed:
                    result["deferred_rules"].append("公开 API 暂不可用，已改用同一 PubMed 官方网页；结果范围以网页实际返回为准。")
                return result
            if current.get("noResults"):
                return response("no_results" if page_index == 0 else "ok", pagination={**pagination, "has_next": False})
            return response("attention", reason="results_unrecognized", pagination=pagination)
    except Exception:
        if page is not None:
            try:
                reason = _auth_reason(page, _snapshot(page, source_key, read_limit))
                if reason:
                    return response("attention", reason=reason)
            except Exception:
                pass
        return {**response("error"),
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
