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
from urllib.parse import parse_qs, quote, urlencode, urlsplit, urlunsplit

import literature_extra_sources as extra_sources
import literature_pubmed
import literature_native_queries as native_queries
from literature_source_access import ACCESS_STATE_JS as _ACCESS_STATE_JS


ROOT = Path(__file__).resolve().parents[1]
SOC_SCRIPTS = ROOT / "SOC-database-pipeline-clean/.codex/skills/soc-paper-fetch/scripts"
SOURCES = {
    "google-scholar": ("Google Scholar", "https://scholar.google.com/scholar"),
    "cnki": ("中国知网", "https://kns.cnki.net/kns8s/defaultresult/index"),
    "web-of-science": ("Web of Science 核心合集", "https://www.webofscience.com/wos/woscc/basic-search"),
    **extra_sources.SOURCE_INFO,
}
_AUTH_KEYS = re.compile(r"token|ticket|session|password|passwd|authorization|saml|signature|auth|^sid$|^code$|^state$|^key$|^v$", re.I)
_AUTH_PATH = re.compile(r"(?:^|[/_.-])(?:login|signin|sign-in|authorize|oauth|saml|sso|callback)(?:$|[/_.-])", re.I)
_SCOPUS_CONTEXT_PROOF = "documents-title-abstract-keywords-v1"
MAX_QUERY_CHARS = 32768  # Same search-expression bound as literature-config.js.


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
            # Current CNKI result anchors may identify an article solely by v.
            # Keep this opaque *navigation* value only on the observed public
            # article endpoint. It is not a stable bibliographic identifier.
            # Elsewhere v retains its historical redaction behavior.
            if (parsed.hostname.lower() == "kns.cnki.net"
                    and parsed.path == "/kcms2/article/abstract" and set(pairs) == {"v"}):
                values = pairs["v"]
                if (parsed.scheme != "https" or parsed.port not in (None, 443)
                        or len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9._~+/=-]{1,8192}", values[0])):
                    return ""
                return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(pairs, doseq=True), ""))
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


def _save_binding(job_dir, source, target_id, query_hash="", *, page_index=None, result_fingerprint="",
                  scopus_context_proven=None, scholar_position=None, native_query_proof=None):
    path = _binding_path(job_dir)
    if path is None:
        return
    data = _load_json(path, {})
    if not isinstance(data, dict):
        data = {}
    previous = data.get(source) if isinstance(data.get(source), dict) else {}
    data[source] = {"target_id": target_id, "label": SOURCES[source][0],
                    "query_hash": query_hash or previous.get("query_hash", "")}
    same_context = previous.get("target_id") == target_id and previous.get("query_hash") == data[source]["query_hash"]
    if isinstance(native_query_proof, dict) and native_query_proof.get("version") == native_queries.PROOF:
        data[source]["native_query_proof"] = dict(native_query_proof)
    if source == "scopus" and (scopus_context_proven is True or
            (scopus_context_proven is None and same_context
             and previous.get("document_context_proof") == _SCOPUS_CONTEXT_PROOF)):
        data[source]["document_context_proof"] = _SCOPUS_CONTEXT_PROOF
    if page_index is not None:
        data[source].update(page_index=page_index, result_fingerprint=result_fingerprint)
    elif previous.get("target_id") == target_id and previous.get("query_hash") == data[source]["query_hash"]:
        for key in ("page_index", "result_fingerprint"):
            if key in previous:
                data[source][key] = previous[key]
    if source == "google-scholar":
        position = _clean_scholar_position(scholar_position)
        if position is None and scholar_position is None and same_context and (
                page_index is None or page_index == previous.get("page_index")):
            position = _clean_scholar_position(previous.get("scholar_position"))
        if position is not None and position["start"] // position["page_size"] == data[source].get("page_index"):
            data[source]["scholar_position"] = position
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
  const wosTimeout524 = source === 'web-of-science' && Array.from(document.querySelectorAll('#cf-error-details,.cf-error-details,h1'))
    .some(el => visible(el) && /\berror\s+code\s*:?\s*524\b/i.test(text(el)));
  const captcha = Array.from(document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="captcha"],.geetest_panel,.verifybox,#captcha,.captcha')).some(visible)
    || /人机验证|滑动验证|请完成(?:安全)?验证|安全验证|滑块|拖动到最右|访问验证|验证码|unusual traffic|verify you are human|are you a robot|access denied.*bot/i.test(head.slice(0,1600));
  const password = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const explicitAccess = /您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|access is not available|you do not have access|not authorized to access/i.test(head);
  const loginPrompt = /请先登录|请登录后|登录后方可|请通过机构登录|需要机构登录|sign in to access|sign in to search|log in to access|please sign in|please log in|access through your institution|institutional sign in|access web of science/i.test(head);
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
  const wosTitle = row => first(row,['a[data-ta="summary-record-title-link"]','a.summary-title','h3 a','.title a','a[href*="/full-record/"]']);
  const loadedTitleCount = source === 'web-of-science'
    ? rows.filter(row => visible(row) && visible(wosTitle(row)) && text(wosTitle(row))).length : null;
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
      a=wosTitle(row); title=visible(a) ? text(a) : '';
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
    service_error:wosTimeout524 ? 'wos_timeout_524' : null,
    visible_result_count:rows.filter(visible).length,loaded_title_count:loadedTitleCount};
}"""


def _snapshot(page, source, limit):
    arguments = {"source": source, "limit": limit}
    current = (extra_sources.snapshot(page, source, limit) if source in extra_sources.SOURCE_INFO
               else page.evaluate(_SNAPSHOT_JS, arguments))
    access = page.evaluate(_ACCESS_STATE_JS, arguments)
    # Keep the common safety signals consistent across every browser source.
    # Only booleans cross this boundary; page text and redirect tokens do not.
    return {**current, **{key: bool(current.get(key) or access.get(key))
                         for key in ("rateLimited", "accessBlocked", "resultsLoading")}}


def _normalized(text):
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def _scopus_comparable(value):
    """Canonicalize visible parenthesis spacing, never query meaning.

    Spaces inside quoted or exact-brace phrases remain significant. Escaped
    delimiters do not change phrase/parenthesis state. Invalid delimiters must
    not become a query proof, even if both displayed strings are identical.
    """
    raw = str(value or "").strip()
    output, mode, escaped, pending_space, depth = [], None, False, False, 0
    first_outer_close = None
    for index, character in enumerate(raw):
        if escaped:
            output.append(character.casefold())
            escaped = False
            continue
        if mode is not None:
            output.append(character.casefold())
            if character == "\\":
                escaped = True
            elif character == ('"' if mode == "quote" else "}"):
                mode = None
            continue
        if character.isspace():
            pending_space = True
            continue
        if character == ")":
            if depth == 0:
                return None
            depth -= 1
            pending_space = False
            output.append(character)
            if depth == 0 and first_outer_close is None:
                first_outer_close = index
            continue
        if character == "}":
            return None
        if pending_space and output and output[-1] != "(":
            output.append(" ")
        pending_space = False
        output.append(character.casefold())
        if character == "\\":
            escaped = True
        elif character == '"':
            mode = "quote"
        elif character == "{":
            mode = "brace"
        elif character == "(":
            depth += 1
    if mode is not None or escaped or depth:
        return None
    normalized = "".join(output)
    wrapper = re.match(r"title-abs-key\s*\(", normalized)
    if wrapper and first_outer_close == len(raw) - 1:
        return normalized[wrapper.end():-1]
    return normalized


def _matches_query(snapshot, page_url, source, query):
    def comparable(value):
        if source == "scopus":
            return _scopus_comparable(value)
        normalized = _normalized(value)
        wrapper = None
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


def _clean_scholar_position(value):
    """Persist only non-sensitive native cursor fields, never a URL or query."""
    if not isinstance(value, dict) or type(value.get("version")) is not int or value.get("version") != 1:
        return None
    start = value.get("start")
    if (isinstance(start, bool) or not isinstance(start, int) or start < 0 or start % 10
            or type(value.get("page_size")) is not int or value.get("page_size") != 10
            or value.get("sort") != "relevance"):
        return None
    for key in ("year_from", "year_to"):
        year = value.get(key)
        if year is not None and (isinstance(year, bool) or not isinstance(year, int) or year < 1):
            return None
    return {"version": 1, "start": start, "page_size": 10,
            "year_from": value.get("year_from"), "year_to": value.get("year_to"), "sort": "relevance"}


def _scholar_position(page, snapshot, query, year_from, year_to, *, anchor_position=None):
    """A native position is proof only together with the frozen search scope."""
    try:
        parsed = urlsplit(page.url)
        if (parsed.scheme != "https" or parsed.hostname != "scholar.google.com" or parsed.port not in (None, 443)
                or parsed.path != "/scholar" or parsed.username or parsed.password):
            return None
        values = parse_qs(parsed.query, keep_blank_values=True)
        if (values.get("q") != [query]
                or not _matches_query(snapshot, page.url, "google-scholar", query)):
            return None
        for key, year in (("as_ylo", year_from), ("as_yhi", year_to)):
            if values.get(key) != ([str(year)] if year is not None else None):
                return None
        if (values.get("scisbd") not in (None, ["0"])
                or values.get("as_sdt") not in (None, ["0,5"])
                or values.get("as_vis") not in (None, ["0"])
                or any(key in values for key in ("cites", "related", "cluster", "lr", "as_occt",
                    "as_sauthors", "as_publication", "as_q", "as_epq", "as_oq", "as_eq"))):
            return None
        starts = values.get("start", ["0"])
        if len(starts) != 1 or not re.fullmatch(r"\d+", starts[0]):
            return None
        start = int(starts[0])
        if values.get("num") != ["10"]:
            # Native Next links can omit the default num=10. A missing value
            # is usable only adjacent to an already verified ten-row anchor;
            # it must never normalize an explicit size or lost year filter.
            anchor = _clean_scholar_position(anchor_position)
            count = snapshot.get("visible_result_count")
            if ("num" in values or anchor is None
                    or anchor["year_from"] != year_from or anchor["year_to"] != year_to
                    or start not in (anchor["start"], anchor["start"] + 10)
                    or type(count) is not int or not 1 <= count <= 10
                    or len(snapshot.get("results") or []) != count):
                return None
        return _clean_scholar_position({"version": 1, "start": start, "page_size": 10,
            "year_from": year_from, "year_to": year_to, "sort": "relevance"})
    except (TypeError, ValueError):
        return None


def _scholar_saved_position(binding, query_hash, year_from, year_to):
    position = _clean_scholar_position(binding.get("scholar_position"))
    if (position is None or binding.get("query_hash") != query_hash
            or position["year_from"] != year_from or position["year_to"] != year_to
            or type(binding.get("page_index")) is not int
            or position["start"] // 10 != binding.get("page_index")):
        return None
    return position


def _scholar_explicit_scope_conflict(page, year_from, year_to):
    """Missing legacy URL fields are unknown; explicit conflicting filters are not."""
    try:
        parsed = urlsplit(page.url)
        if (parsed.scheme != "https" or parsed.hostname != "scholar.google.com" or parsed.port not in (None, 443)
                or parsed.path != "/scholar" or parsed.username or parsed.password):
            return False
        values = parse_qs(parsed.query, keep_blank_values=True)
        for key, year in (("as_ylo", year_from), ("as_yhi", year_to)):
            if key in values and values[key] != ([str(year)] if year is not None else None):
                return True
        return bool(any(key in values and values[key] != [expected]
                        for key, expected in (("num", "10"), ("scisbd", "0"), ("as_sdt", "0,5"), ("as_vis", "0")))
                    or any(key in values for key in ("cites", "related", "cluster", "lr", "as_occt",
                        "as_sauthors", "as_publication", "as_q", "as_epq", "as_oq", "as_eq")))
    except (TypeError, ValueError):
        return False


def _navigate_scholar_checkpoint(page, query, position):
    values = {"q": query, "hl": "en", "num": 10, "start": position["start"]}
    if position["year_from"] is not None:
        values["as_ylo"] = position["year_from"]
    if position["year_to"] is not None:
        values["as_yhi"] = position["year_to"]
    page.goto(SOURCES["google-scholar"][1] + "?" + urlencode(values),
              wait_until="domcontentloaded", timeout=60_000)
    return True


def _auth_reason(page, snapshot):
    if snapshot.get("service_error") == "wos_timeout_524":
        return None  # An explicit upstream timeout is not a login/challenge.
    if snapshot.get("captcha"):
        return "verification"
    if snapshot.get("rateLimited"):
        return "rate_limited"
    if snapshot.get("accessBlocked"):
        return "access_blocked"
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
    "rate_limited": "来源提示访问频繁或请求次数受限，已停止该来源请求并保留断点。请按来源提示等待，恢复后在原任务检查并继续；不会自动刷新或换词重试。",
    "access_blocked": "来源拒绝或限制了当前访问，已停止该来源请求并保留断点。请在原页面核对提示，访问恢复后检查并继续；不会自动刷新或换词重试。",
    "access_required": "当前会话没有所需数据库访问权限。请使用学校机构授权或授权网络登录后，回工作台检查并继续。",
    "results_unrecognized": "尚不能确认本次检索的结果页面。请查看该任务的官方页面，确认检索式和结果已加载后再继续。",
}
_WOS_REVIEW_MESSAGE = "Web of Science 官方页面尚不能确认可用检索会话、表单或结果。请在原任务窗口核对机构访问和页面提示，再点“检查并继续”；已有结果保留。"
_WOS_TIMEOUT_MESSAGE = "Web of Science 服务端响应超时（524），已有结果保留。无需反复登录，请稍后在原任务中点击“检查并继续”。"
_WOS_LOADING_MESSAGE = "WOS结果页面已打开，但文献列表尚未加载。请在原页面确认文献题名出现后再检查并继续；已有候选保留。"
_WOS_PROOF_MESSAGE = "WOS原结果页面的检索式或页码尚不能与本任务待处理页对应。请在原页面核对检索式和页码后检查并继续；原页面与已有候选保留。"

_WOS_PICKER_SELECTORS = (
    '[data-ta="search-field-dropdown"]', '[data-ta="search-field"]',
    'mat-select[aria-label*="Search field"]', 'button[aria-label*="Search field"]',
)
_WOS_FIELD_SELECTORS = (
    'textarea[data-ta="search-criteria-input"]', 'input[data-ta="search-criteria-input"]',
    '[data-ta="search-criteria-input"] textarea', '[data-ta="search-criteria-input"] input',
    'textarea#search-option', 'input#search-option',
    'textarea[aria-label*="Search"]', 'textarea[placeholder*="Search"]',
    'textarea[placeholder*="search"]', 'input[aria-label*="Search"]', 'input[placeholder*="Search"]',
)
_WOS_BUTTON_SELECTORS = (
    'button[data-ta="run-search"]', 'button[data-ta="search-button"]',
    'button[data-ta="submit-search"]', 'button[type="submit"]',
    'button:has-text("Search")', 'button:has-text("检索")',
)


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
        "web-of-science": ':is(app-record,app-summary-record,.summary-record,[data-ta="summary-record"]) :is(a[data-ta="summary-record-title-link"],a.summary-title,h3 a,.title a,a[href*="/full-record/"]),app-no-results,[data-ta="no-results"],input[type="password"]',
    }
    try:
        page.wait_for_selector(selectors[source], timeout=15_000)
    except Exception:
        # A redirect to SSO or a changed layout is classified from foreground DOM.
        pass


def _wos_form_ready(page):
    """Only the existing visible fielded-search controls prove readiness."""
    return (_first_visible(page, _WOS_PICKER_SELECTORS) is not None
            and _first_visible(page, _WOS_FIELD_SELECTORS) is not None
            and _first_visible(page, _WOS_BUTTON_SELECTORS) is not None)


def _submit_wos(page, query):
    # The official Core Collection basic-search URL is fixed.  No fabricated
    # undocumented URL search parameters or copied session identifiers are used.
    if extra_sources.native_query_notice("web-of-science", query):
        return False  # A compound native expression must never become Topic text.
    current = _snapshot(page, "web-of-science", 10)
    if current.get("service_error") or _auth_reason(page, current):
        return False  # An access challenge can appear while the form is loading.
    topic = re.fullmatch(r"\s*TS\s*=\s*\((.*)\)\s*", query, re.I | re.S)
    # A persistent profile may remember Author/Title from a previous search.
    # Confirm Topic for every query, including ordinary unprefixed expressions.
    picker = _first_visible(page, _WOS_PICKER_SELECTORS)
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
    field = _first_visible(page, _WOS_FIELD_SELECTORS)
    if field is None:
        return False
    field.fill(query)
    if _normalized(field.input_value()) != _normalized(query):
        return False
    button = _first_visible(page, _WOS_BUTTON_SELECTORS)
    if button is None:
        return False
    button.click()
    _wait_results(page, "web-of-science")
    return True


def _navigate_search(page, source, query, year_from, year_to):
    if extra_sources.native_query_notice(source, query):
        return False  # Also protect direct/internal calls before any navigation.
    if source in extra_sources.SOURCE_INFO:
        return extra_sources.navigate(page, source, query, year_from, year_to)
    if source == "google-scholar":
        common, _ = _dependencies()
        del common
        scholar = importlib.import_module("google_scholar_search")
        url = scholar.build_search_url(query, year_from, year_to)
        parts = urlsplit(url)
        values = parse_qs(parts.query, keep_blank_values=True)
        values["num"] = ["10"]  # Stable offsets are required for safe checkpoint recovery.
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(values, doseq=True), ""))
    elif source == "cnki":
        # CNKI's visible input preserves form-encoded '+' as literal text.
        # Percent-encode spaces and actual plus signs distinctly so the page's
        # displayed query remains identical to the researcher's frozen rule.
        url = SOURCES[source][1] + "?" + urlencode({"kw": query, "korder": "SU"}, quote_via=quote)
    else:
        url = SOURCES[source][1]
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    except Exception:
        if source != "web-of-science" or not _official_result_page(page, source):
            raise
        # A global-to-regional transfer can time out while its official page
        # already has usable controls. Read foreground evidence once; unknown
        # sessions remain recoverable and no guessed transfer/API is called.
        current = _snapshot(page, source, 10)
        if current.get("service_error") or _auth_reason(page, current) or not _wos_form_ready(page):
            return False
        return _submit_wos(page, query)
    if source == "web-of-science":
        current = _snapshot(page, source, 10)
        if current.get("service_error") or _auth_reason(page, current):
            return False
        try:
            page.wait_for_selector('textarea,input[type="password"],input[data-ta="search-criteria-input"]', timeout=15_000)
        except Exception:
            pass
        return _submit_wos(page, query)
    # The caller waits for result/authentication state on this exact page.
    # A container selector alone can be an empty AJAX shell.
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
  let cnkiPages={};
  if(source==='cnki') {
    // KNS removes Next on its final page but retains the visible N / total
    // page marker. Result counts and the mere absence of Next are not proof.
    const marks=Array.from(document.querySelectorAll('.countPageMark')).filter(visible);
    if(marks.length) {
      const match=marks.length===1 && text(marks[0]).match(/^(\d+)\s*\/\s*(\d+)$/);
      const current=match?Number(match[1]):null,last=match?Number(match[2]):null;
      if(Number.isSafeInteger(current)&&Number.isSafeInteger(last)&&current>0&&current<=last) {
        cnkiPages={page_number:current,total_pages:last,pagination_conflict:end&&current!==last};
        end=current===last;
      } else {cnkiPages={pagination_conflict:true};end=false;}
    }
  }
  return {total_count:Number.isSafeInteger(total)&&total>=0?total:null,explicit_end:end,...cnkiPages};
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
    result = {"has_next": has_next, "total_count": data.get("total_count")}
    if source == "cnki":
        current, last = data.get("page_number"), data.get("total_pages")
        if current is not None:
            result.update(page_number=current, total_pages=last)
        # Conflicting page controls may be an incomplete AJAX transition.
        if (data.get("pagination_conflict") or (data.get("explicit_end") and disabled is False)
                or (current is not None and current < last and disabled is True)):
            result["has_next"] = None
        elif has_next is False:
            result["end_evidence"] = ({"kind": "page_count", "selector": ".countPageMark",
                "page_number": current, "total_pages": last} if current is not None else
                {"kind": "disabled_next" if disabled is True else "explicit_end"})
    return result


def _source_pagination(page, source, snapshot, pagination):
    """Distinguish a database's display cap from the scientific result end.

    Scholar documents a maximum of 1,000 displayed records for one query.
    Its reported hit count is approximate: it cannot override an explicitly
    disabled Next control below that cap. Flag the documented source cap only
    once the actual displayed range reaches it and the source reports more.
    The current page remains successful so its rows can be checkpointed first.
    https://scholar.google.com/intl/us/scholar/help.html
    """
    if source != "google-scholar":
        return pagination
    total = pagination.get("total_count")
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return pagination
    try:
        parsed = urlsplit(page.url)
        if not _official_result_page(page, source):
            return pagination
        starts = parse_qs(parsed.query).get("start", ["0"])
        if len(starts) != 1 or not re.fullmatch(r"\d+", starts[0]):
            return pagination
        start = int(starts[0])
    except (TypeError, ValueError):
        return pagination
    visible_count = snapshot.get("visible_result_count")
    if isinstance(visible_count, bool) or not isinstance(visible_count, int) or visible_count < 0:
        visible_count = len(snapshot.get("results") or [])
    observed_end = start + visible_count
    if observed_end >= 1000 and total > observed_end:
        return {**pagination, "has_next": True, "source_limit_reached": True,
                "source_limit_message": "Google Scholar 报告的命中数仍多于已取回结果，但当前结果已到来源显示上限或无法继续翻页。该来源单个检索式最多显示1000条；请缩小或拆分检索式后新建检索，不能将此标记为全部检索完成。"}
    return pagination


def _row_fingerprint(snapshot):
    rows = [{key: row.get(key) for key in ("title", "result_url", "doi", "pmid")}
            for row in snapshot.get("results") or [] if isinstance(row, dict)]
    return hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def _official_result_page(page, source):
    try:
        parsed = urlsplit(page.url)
        host = (parsed.hostname or "").lower()
        if parsed.scheme not in ("https", "http") or parsed.username or parsed.password:
            return False
        if source == "web-of-science" and host == "webofscience.clarivate.cn":
            return True
        domain = {"google-scholar": "scholar.google.com", "cnki": "cnki.net",
                  "web-of-science": "webofscience.com", "wanfang": "wanfangdata.com.cn",
                  "scopus": "scopus.com", "pubmed": "pubmed.ncbi.nlm.nih.gov"}[source]
        return host == domain or host.endswith("." + domain)
    except ValueError:
        return False


class _WosRecovery(Exception):
    def __init__(self, output):
        super().__init__("WOS official page needs review")
        self.output = output


def _wos_page_alive(page):
    if page is None:
        return False
    try:
        if getattr(page, "is_closed", lambda: False)():
            return False
        context = getattr(page, "context", None)
        browser = getattr(context, "browser", None) if context is not None else None
        return browser is None or browser.is_connected()
    except Exception:
        return False


@contextmanager
def _wos_recovery(source, bound_page, response):
    """Classify WOS exceptions before the Playwright runtime disconnects.

    A navigation can replace its JS execution context while the official tab
    remains alive. That is reviewable; a closed tab/disconnected browser is an
    environment error. Neither exception text nor transfer URLs are exported.
    """
    try:
        yield
    except Exception:
        page = bound_page()
        if source != "web-of-science" or not _wos_page_alive(page):
            raise
        try:
            current = _snapshot(page, source, 10)
            reason = _auth_reason(page, current)
        except Exception:
            current = {}
            reason = None
        if reason:
            raise _WosRecovery(response("attention", reason=reason)) from None
        if _official_result_page(page, source):
            raise _WosRecovery(response("attention", reason="results_unrecognized", service_error=current.get("service_error"))) from None
        raise


def _query_consistent(snapshot, page, source, query, *, submitted=False, trusted=False):
    # A visible changed query always invalidates the prior target/page proof.
    if snapshot.get("queries"):
        return _matches_query(snapshot, page.url, source, query)
    return _matches_query(snapshot, page.url, source, query) or submitted or trusted


def _scopus_context_checks(page):
    """Only explicit visible contradictions invalidate an actual submit proof.

    A results page may no longer expose its basic search controls. Their
    absence is not evidence of a different field; an Authors tab or an actual
    non-Title/Abstract/Keywords selection is. No DOM text is exported.
    """
    field = extra_sources._scopus_fields(page)
    wrong_mode = bool(page.evaluate(r"""/* scopus_visible_mode_conflict */ () => {
      const visible=el=>!!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text=el=>(el?.innerText || el?.textContent || '').trim().replace(/\s+/g,' ');
      return Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"],a[aria-current="page"],.search-tabs .active,#basic[aria-selected="true"],#s[aria-selected="true"]'))
        .filter(visible).some(el=>/^(?:Authors?|Organizations?|作者|机构)$/i.test(text(el)));
    }"""))
    return {"visible_document_context_valid": bool(extra_sources.query_context_valid(page, "scopus")),
            "visible_context_conflict": wrong_mode or bool(field and not extra_sources._is_title_abstract_keywords(field))}


def _scopus_attention(current, page, query, *, submitted, bound_proven, context_checks):
    """Explain the failing gate using booleans, never query/DOM/auth contents."""
    current = current or {}
    checks = {"official_page": bool(page and _official_result_page(page, "scopus")),
              "visible_query_present": bool(current.get("queries")),
              "query_matches": bool(page and _matches_query(current, page.url, "scopus", query)),
              "submitted_document_context_proven": bool(submitted),
              "bound_document_context_proven": bool(bound_proven),
              "visible_document_context_valid": bool(context_checks.get("visible_document_context_valid")),
              "visible_context_conflict": bool(context_checks.get("visible_context_conflict")),
              "bibliographic_records_loaded": bool(current.get("results")),
              "explicit_no_results": bool(current.get("noResults"))}
    if not checks["official_page"]:
        message = "尚不能确认当前是 Scopus 官方结果页面，已暂停；请查看本任务绑定的官方页面。"
    elif checks["visible_query_present"] and not checks["query_matches"]:
        message = "Scopus 页面显示的检索式与本任务冻结检索式不一致，已暂停；请核对完整检索式后再继续。"
    elif checks["visible_context_conflict"]:
        message = "Scopus 当前可见检索模式或字段与 Documents／Title, Abstract, Keywords 不一致，已暂停。"
    elif not (checks["submitted_document_context_proven"] or checks["bound_document_context_proven"]):
        message = "尚未取得本任务在 Scopus Documents／Title, Abstract, Keywords 的提交或页面绑定证明，已暂停；不能仅凭结果数量继续。"
    elif not checks["visible_query_present"]:
        message = "Scopus 结果页尚未显示可核对的检索式，已暂停；请待检索式和文献记录加载后再继续。"
    elif not (checks["bibliographic_records_loaded"] or checks["explicit_no_results"]):
        message = "Scopus 检索式已核对，但文献记录尚未加载或无法识别，已暂停；结果总数不等于题录已读取。"
    else:
        message = "Scopus 结果页仍有判据未能确认，已暂停；已有结果保留，请查看本任务的官方页面。"
    return message, checks


def _wos_summary_index(page):
    """Read only the observed official summary URL's one-based page number."""
    if not _official_result_page(page, "web-of-science"):
        return None
    match = re.fullmatch(r"/wos/woscc/summary/[^/]+/[^/]+/([1-9][0-9]*)/?", urlsplit(page.url).path)
    return int(match.group(1)) - 1 if match else None


def _wos_result_context(page, current):
    return (_official_result_page(page, "web-of-science")
            and (current.get("resultContainer") or _wos_summary_index(page) is not None))


def _wos_records_ready(current, limit, *, full_page=False):
    rows = current.get("results") or []
    if not rows or current.get("resultsLoading"):
        return False
    visible = current.get("visible_result_count", len(rows))
    loaded = current.get("loaded_title_count", len(rows))
    if not isinstance(visible, int) or not isinstance(loaded, int):
        return False
    # A sample can stop after ten titles on a native fifty-record page. Formal
    # collection must not advance past any still-empty visible record component.
    needed = visible if full_page else min(limit, visible)
    return needed > 0 and loaded >= needed and len(rows) >= needed


def _source_records_ready(current, limit, *, full_page=False):
    """Do not advance past visible records whose title has not arrived yet."""
    rows = current.get("results") or []
    if not rows or current.get("resultsLoading"):
        return False
    visible = current.get("visible_result_count", len(rows))
    if isinstance(visible, bool) or not isinstance(visible, int) or visible <= 0:
        return False
    needed = visible if full_page else min(limit, visible)
    return len(rows) >= needed


def _wait_source_records(page, source, current, limit, *, full_page=False):
    """Bounded, read-only wait; never retry a request or navigate a login page."""
    deadline = time.monotonic() + 15
    while True:
        if (_auth_reason(page, current) or current.get("service_error")
                or (current.get("noResults") and not current.get("resultsLoading"))
                or _source_records_ready(current, limit, full_page=full_page)
                or (full_page and current.get("visible_result_count", 0) > limit)):
            return current
        if time.monotonic() >= deadline:
            return {**current, "_source_loading_pending": True}
        time.sleep(0.2)
        current = _snapshot(page, source, limit)


def _wait_wos_records(page, current, limit, *, full_page=False):
    """Wait on this exact tab without navigating, submitting, or paging it."""
    deadline = time.monotonic() + 15
    while True:
        if (_auth_reason(page, current) or current.get("service_error")
                or (current.get("noResults") and not current.get("resultsLoading"))
                or _wos_records_ready(current, limit, full_page=full_page)
                or (full_page and current.get("visible_result_count", 0) > limit)):
            return current
        if time.monotonic() >= deadline:
            return {**current, "_wos_loading_pending": True}
        time.sleep(0.2)
        current = _snapshot(page, "web-of-science", limit)


def _advance_page(page, source, previous, limit):
    if source == "web-of-science" and not _wos_records_ready(previous, limit, full_page=limit > 10):
        return None
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
        if (_auth_reason(page, current) or current.get("service_error")
                or (current.get("noResults") and not current.get("resultsLoading"))
                or (current.get("results") and _row_fingerprint(current) != before
                    and (_wos_records_ready(current, limit, full_page=limit > 10) if source == "web-of-science"
                         else _source_records_ready(current, limit, full_page=limit > 10)))):
            return current
        if time.monotonic() >= deadline:
            if source == "web-of-science" and not _wos_records_ready(current, limit, full_page=limit > 10):
                return {**current, "_wos_loading_pending": True}
            if not _source_records_ready(current, limit, full_page=limit > 10):
                return {**current, "_source_loading_pending": True}
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
    if not isinstance(query, str) or not query.strip() or len(query) > MAX_QUERY_CHARS:
        return {**_envelope(source_key, "error"), "message": f"检索式必须为1到{MAX_QUERY_CHARS}字符；原式未自动截断。"}
    if isinstance(page_index, bool) or not isinstance(page_index, int) or page_index < 0:
        return {**_envelope(source_key, "error"), "message": "检索页码必须为非负整数。"}
    native_notice = extra_sources.native_query_notice(source_key, query)
    if native_notice:
        # Dedicated positive-proof path; native expressions never enter the
        # basic submitters below. Unknown layouts continue to fail closed.
        return native_queries.run(sys.modules[__name__], source_key, query, limit, year_from, year_to,
                                  job_dir=job_dir, page_index=page_index, full_page=full_page)
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
    submitted = False
    scopus_context_proven = False
    scopus_context_checks = {}
    recovery = None
    scholar_modern_position = False

    def response(status, *, results=None, reason=None, pagination=None, service_error=None):
        output = _envelope(source_key, status, results=results, reason=reason, **options)
        if source_key == "web-of-science" and status == "attention" and reason == "results_unrecognized":
            error = service_error or (current or {}).get("service_error")
            output["message"] = (_WOS_TIMEOUT_MESSAGE if error == "wos_timeout_524" else
                                 _WOS_LOADING_MESSAGE if (current or {}).get("_wos_loading_pending") else _WOS_REVIEW_MESSAGE)
        if source_key == "scopus" and status == "attention" and reason == "results_unrecognized":
            output["message"], output["diagnostics"] = _scopus_attention(current, page, query,
                submitted=submitted, bound_proven=scopus_context_proven, context_checks=scopus_context_checks)
        output.update(page_index=page_index, has_next=None, total_count=None)
        if status == "attention" and source_key != "scopus" and (current or {}).get("_source_loading_pending"):
            output["message"] = "当前来源文献列表尚未完整加载，已保留原页面和断点。请确认题录出现后检查并继续；未将空白或加载中的页面视为检索完成。"
        if recovery is not None:
            output["recovery"] = dict(recovery)
        if pagination:
            output.update(pagination)
        return output

    try:
        with _runtime() as context, _wos_recovery(source_key, lambda: page, response):
            page, created = _pick_page(context, source_key, job_dir)
            page.bring_to_front()
            query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()
            bindings = _load_json(_binding_path(job_dir), {}) if job_dir is not None else {}
            binding = bindings.get(source_key, {}) if isinstance(bindings, dict) else {}
            if not isinstance(binding, dict):
                binding = {}
            scholar_saved = (_scholar_saved_position(binding, query_hash, year_from, year_to)
                             if source_key == "google-scholar" else None)
            scholar_anchor = scholar_saved
            proven_index = None
            recheck_auth = False
            inspect_bound_wos = source_key == "web-of-science" and not created
            if scrape_current or page_index or not created:
                current = _snapshot(page, source_key, read_limit)
                recheck_service = bool(source_key == "web-of-science" and scrape_current
                                       and current.get("service_error") == "wos_timeout_524")
                if source_key == "web-of-science" and current.get("service_error") and not recheck_service:
                    return response("attention", reason="results_unrecognized")
                reason = _auth_reason(page, current)
                if inspect_bound_wos and not current.get("service_error") and _wos_result_context(page, current):
                    # An existing summary is user state, even if its search
                    # form is also visible. Never restart it to cure empty rows.
                    if reason:
                        return response("attention", reason=reason)
                    current = _wait_wos_records(page, current, read_limit, full_page=full_page)
                    reason = _auth_reason(page, current)
                    if reason:
                        return response("attention", reason=reason)
                    if current.get("service_error") or current.get("_wos_loading_pending"):
                        return response("attention", reason="results_unrecognized")
                # Institution SSO can finish in another tab while this target
                # still displays its old login form. Only an explicit resume
                # may re-probe the frozen official search with the shared
                # persistent session. Never refresh an unresolved CAPTCHA.
                recheck_auth = bool(scrape_current and reason in ("login", "access_required"))
                if reason and not recheck_auth:
                    return response("attention", reason=reason)
                if (source_key != "web-of-science" and not recheck_auth
                        and binding.get("query_hash") == query_hash
                        and (current.get("resultContainer") or current.get("resultsLoading"))):
                    current = _wait_source_records(page, source_key, current, read_limit, full_page=full_page)
                    reason = _auth_reason(page, current)
                    if reason:
                        return response("attention", reason=reason)
                    if current.get("_source_loading_pending"):
                        return response("attention", reason="results_unrecognized")
                if source_key == "google-scholar" and not recheck_auth:
                    observed_position = _scholar_position(page, current, query, year_from, year_to,
                        anchor_position=scholar_anchor)
                    same_query = binding.get("query_hash") == query_hash
                    if same_query and _scholar_explicit_scope_conflict(page, year_from, year_to):
                        recovery = {"mode": "context_changed", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": False,
                            "message": "Scholar当前页面的年份、排序、每页数量或额外筛选与原批次冲突，未沿用旧页码；已有结果保留，请核对后继续。"}
                        return response("attention", reason="results_unrecognized")
                    if (same_query and binding.get("scholar_position") is not None and scholar_saved is None):
                        recovery = {"mode": "context_changed", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": False,
                            "message": "Scholar断点的年份、排序或每页数量与本次配置不一致，已有结果保留，请核对后继续。"}
                        return response("attention", reason="results_unrecognized")
                    if (scholar_saved is not None and _official_result_page(page, source_key)
                            and (current.get("results") or current.get("noResults")) and observed_position is None):
                        recovery = {"mode": "context_changed", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": False,
                            "message": "Scholar当前检索词、年份、排序或每页数量已变化，未沿用旧页码；请核对原批次后继续。"}
                        return response("attention", reason="results_unrecognized")
                    if observed_position is not None and same_query and not created:
                        observed_index = observed_position["start"] // 10
                        same_saved_page = observed_index == binding.get("page_index")
                        fingerprint_matches = binding.get("result_fingerprint") == _row_fingerprint(current)
                        if same_saved_page and binding.get("result_fingerprint") and not fingerprint_matches:
                            recovery = {"mode": "rows_changed", "target_page": page_index + 1,
                                "position_verified": True, "continuity_verified": False,
                                "message": "Scholar保存页的题录已变化，可能发生重新排序；已有结果保留，核对连续性后再继续，不能直接跳过。"}
                            return response("attention", reason="results_unrecognized")
                        allowed = (page_index, page_index - 1) if page_index else (0,)
                        if observed_index in allowed:
                            if not (current.get("results") or current.get("noResults")):
                                recovery = {"mode": "awaiting_page", "target_page": page_index + 1,
                                    "position_verified": True, "continuity_verified": False,
                                    "message": "Scholar已位于待恢复页，但文献列表尚未加载；保留页面，加载后检查并继续。"}
                                return response("attention", reason="results_unrecognized")
                            proven_index = observed_index
                            scholar_modern_position = True
                            scholar_anchor = observed_position
                            recovery = {"mode": "resume_current" if observed_index == page_index else "resume_previous",
                                "target_page": page_index + 1, "position_verified": True,
                                "continuity_verified": bool(same_saved_page and fingerprint_matches),
                                "message": f"Scholar已核对原批次页位，正从第{observed_index + 1}页续接至第{page_index + 1}页；已有题录复用。"}
                if source_key == "scopus" and not recheck_auth:
                    scopus_context_checks = _scopus_context_checks(page)
                scopus_binding_valid = source_key != "scopus" or (
                    not scopus_context_checks.get("visible_context_conflict") and
                    (binding.get("document_context_proof") == _SCOPUS_CONTEXT_PROOF
                     or scopus_context_checks.get("visible_document_context_valid")))
                if (not recheck_auth and not current.get("service_error") and not created and binding.get("query_hash") == query_hash
                        and isinstance(binding.get("page_index"), int)
                        and binding.get("result_fingerprint") == _row_fingerprint(current)
                        and _official_result_page(page, source_key)
                        and _query_consistent(current, page, source_key, query, trusted=True)
                        and scopus_binding_valid
                        and (source_key != "google-scholar" or scholar_saved is None)):
                    proven_index = binding["page_index"]
                    if source_key == "scopus":
                        scopus_context_proven = True
                    if source_key == "google-scholar" and recovery is None:
                        recovery = {"mode": "legacy_binding", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": True,
                            "message": "Scholar沿旧断点题录指纹继续；旧记录缺少完整页位元数据，未声称年份和排序已独立核对。"}
                if inspect_bound_wos and not recheck_auth and not current.get("service_error") and _wos_result_context(page, current):
                    observed_index = _wos_summary_index(page)
                    if observed_index is not None:
                        proven_index = observed_index
                    allowed = (page_index, page_index - 1) if page_index else (0,)
                    if not _matches_query(current, page.url, source_key, query) or proven_index not in allowed:
                        result = response("attention", reason="results_unrecognized")
                        result["message"] = _WOS_PROOF_MESSAGE
                        return result
            use_bound = proven_index in (page_index, page_index - 1) if page_index else proven_index == 0
            verified = bool(current and _matches_query(current, page.url, source_key, query))
            if source_key == "scopus" and verified:
                verified = scopus_context_checks.get("visible_document_context_valid", False)
            # Keep the legacy manual first-batch behavior. Formal runs without
            # proof re-submit from page one: an identical query can be on page N.
            # A homepage search box can still contain the frozen query after a
            # failed click. Only actual bibliographic rows or an explicit zero
            # result on the official source can be read without re-submitting.
            manual_result_page = bool(current and not current.get("service_error") and (current.get("results") or current.get("noResults"))
                                      and _official_result_page(page, source_key))
            manual_first = (scrape_current and not full_page and not created and page_index == 0
                            and not recheck_auth and manual_result_page and verified
                            and binding.get("page_index", 0) == 0 and source_key != "scopus")
            if use_bound:
                current_index = proven_index
            elif manual_first:
                current_index = 0
            else:
                scholar_restore = bool(source_key == "google-scholar" and scholar_saved is not None
                    and binding.get("page_index") in ((page_index, page_index - 1) if page_index else (0,)))
                if scholar_restore:
                    recovery = {"mode": "checkpoint_url", "target_page": page_index + 1,
                        "position_verified": False, "continuity_verified": False,
                        "message": f"Scholar正在恢复到已保存的第{binding['page_index'] + 1}页，并核对题录锚点后续接第{page_index + 1}页。"}
                    submitted = _navigate_scholar_checkpoint(page, query, scholar_saved)
                elif (source_key == "web-of-science" and not created and current is not None
                        and not recheck_auth and not current.get("service_error") and _official_result_page(page, source_key)
                        and _wos_form_ready(page)):
                    # A regional official form already reached in this task is
                    # preferable to restarting its failing global transfer.
                    submitted = _submit_wos(page, query)
                else:
                    if source_key == "google-scholar" and page_index:
                        recovery = {"mode": "replay_from_first", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": False,
                            "message": f"Scholar旧断点缺少可核对页位，正在从首页重新定位至第{page_index + 1}页；已有候选保留并去重，连续性仍需核对。"}
                    submitted = _navigate_search(page, source_key, query, year_from, year_to)
                current = _snapshot(page, source_key, read_limit)
                if source_key == "web-of-science" and _wos_result_context(page, current):
                    current = _wait_wos_records(page, current, read_limit, full_page=full_page)
                elif source_key != "web-of-science":
                    current = _wait_source_records(page, source_key, current, read_limit, full_page=full_page)
                if source_key == "web-of-science" and current.get("service_error"):
                    return response("attention", reason="results_unrecognized")
                reason = _auth_reason(page, current)
                if reason:
                    return response("attention", reason=reason)
                if current.get("_wos_loading_pending") or current.get("_source_loading_pending"):
                    return response("attention", reason="results_unrecognized")
                verified = _matches_query(current, page.url, source_key, query)
                if source_key == "scopus":
                    scopus_context_checks = _scopus_context_checks(page)
                    # navigate() only returns a Scopus submit proof after the
                    # actual Documents/field/input checks. Do not demand those
                    # homepage controls again on the resulting document page.
                    scopus_context_proven = bool(submitted and verified and _official_result_page(page, source_key)
                        and not scopus_context_checks.get("visible_context_conflict")
                        and (current.get("results") or current.get("noResults")))
                    if not scopus_context_proven:
                        return response("attention", reason="results_unrecognized")
                if not verified and not (source_key == "web-of-science" and submitted and not current.get("queries")):
                    return response("attention", reason="results_unrecognized")
                current_index = binding["page_index"] if scholar_restore else 0
                if source_key == "google-scholar":
                    restored_position = _scholar_position(page, current, query, year_from, year_to,
                        anchor_position=scholar_anchor)
                    if scholar_restore:
                        if (restored_position != scholar_saved
                                or binding.get("result_fingerprint") != _row_fingerprint(current)):
                            recovery.update(mode="rows_changed", position_verified=restored_position == scholar_saved,
                                message="Scholar恢复页的题录与原断点不一致，可能重新排序；已保留旧结果，请核对连续性后继续。")
                            return response("attention", reason="results_unrecognized")
                        recovery.update(position_verified=True, continuity_verified=True)
                    scholar_modern_position = restored_position is not None
                    if scholar_modern_position:
                        scholar_anchor = restored_position
            while current_index < page_index:
                if not _official_result_page(page, source_key):
                    return response("attention", reason="results_unrecognized")
                pagination = _source_pagination(page, source_key, current, _pagination(page, source_key))
                if pagination.get("source_limit_reached"):
                    result = response("attention", reason="results_unrecognized", pagination=pagination)
                    result["message"] = pagination["source_limit_message"]
                    return result
                if pagination["has_next"] is False:
                    result = response("attention", reason="results_unrecognized")
                    result["message"] = "尚未恢复到原待处理页，当前页面已显示末页。已有题录与断点保留，请核对结果数量和页序变化；不能据此认定原批次检索完成。"
                    return result
                advanced = _advance_page(page, source_key, current, read_limit)
                if advanced is None:
                    return response("attention", reason="results_unrecognized", pagination=pagination)
                current = advanced
                if current.get("_source_loading_pending"):
                    return response("attention", reason="results_unrecognized")
                if source_key == "web-of-science" and (current.get("service_error") or current.get("_wos_loading_pending")):
                    return response("attention", reason="results_unrecognized")
                reason = _auth_reason(page, current)
                if reason:
                    return response("attention", reason=reason)
                if not _official_result_page(page, source_key) or not _query_consistent(current, page, source_key, query, trusted=True):
                    return response("attention", reason="results_unrecognized")
                if source_key == "google-scholar" and scholar_modern_position:
                    advanced_position = _scholar_position(page, current, query, year_from, year_to,
                        anchor_position=scholar_anchor)
                    if advanced_position is None or advanced_position["start"] // 10 != current_index + 1:
                        recovery = {"mode": "context_changed", "target_page": page_index + 1,
                            "position_verified": False, "continuity_verified": False,
                            "message": "Scholar翻页后的原生页位或检索条件无法核对，未跳过该页；请在原页面检查并继续。"}
                        return response("attention", reason="results_unrecognized")
                    scholar_anchor = advanced_position
                if source_key == "scopus":
                    scopus_context_checks = _scopus_context_checks(page)
                    if scopus_context_checks.get("visible_context_conflict"):
                        return response("attention", reason="results_unrecognized")
                current_index += 1
                # Only bibliographic fingerprints and page numbers are persisted.
                _save_binding(job_dir, source_key, _target_id(context, page), query_hash,
                              page_index=current_index, result_fingerprint=_row_fingerprint(current),
                              scopus_context_proven=scopus_context_proven if source_key == "scopus" else None,
                              scholar_position=_scholar_position(page, current, query, year_from, year_to,
                                  anchor_position=scholar_anchor)
                              if source_key == "google-scholar" else None)
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
            pagination = _source_pagination(page, source_key, current, _pagination(page, source_key))
            if rows:
                _save_binding(job_dir, source_key, _target_id(context, page), query_hash,
                              page_index=page_index, result_fingerprint=_row_fingerprint(current),
                              scopus_context_proven=scopus_context_proven if source_key == "scopus" else None,
                              scholar_position=_scholar_position(page, current, query, year_from, year_to,
                                  anchor_position=scholar_anchor)
                              if source_key == "google-scholar" else None)
                result = response("ok", results=rows, pagination=pagination)
                if api_failed:
                    result["deferred_rules"].append("公开 API 暂不可用，已改用同一 PubMed 官方网页；结果范围以网页实际返回为准。")
                return result
            if current.get("noResults"):
                if source_key == "scopus":
                    _save_binding(job_dir, source_key, _target_id(context, page), query_hash,
                                  page_index=page_index, result_fingerprint=_row_fingerprint(current),
                                  scopus_context_proven=scopus_context_proven)
                return response("no_results" if page_index == 0 else "ok", pagination={**pagination, "has_next": False})
            return response("attention", reason="results_unrecognized", pagination=pagination)
    except _WosRecovery as paused:
        return paused.output
    except Exception:
        if page is not None and source_key != "web-of-science":
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
    config = _load_json(Path(job_dir) / "run_config.json", {})
    query = config.get("sourceQueries", {}).get(source_key) or config.get("query", "")
    native_notice = extra_sources.native_query_notice(source_key, query)
    with _runtime() as context:
        page, created = _pick_page(context, source_key, job_dir)
        if created:
            if source_key == "web-of-science" or native_notice:
                page.goto(SOURCES[source_key][1], wait_until="domcontentloaded", timeout=60_000)
            else:
                _navigate_search(page, source_key, query, config.get("publicationYearFrom"), config.get("publicationYearTo"))
        page.bring_to_front()
    return {"opened": True, "source": source_key, "label": SOURCES[source_key][0],
            "message": ("已打开该任务的官方入口；请进入高级／专业检索页，粘贴原式并核对后导出题录导入。当前未自动提交检索式。"
                        if native_notice else "已打开该任务的官方检索页面，请在页面中完成登录或验证。")}


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
