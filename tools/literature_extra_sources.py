"""Visible bibliographic adapters for the additional registered sources.

The caller owns the persistent page and authentication.  This module neither
launches a browser nor reads credentials.  Unknown forms/results deliberately
remain unrecognized so the caller can ask the researcher to inspect the page.

Official search semantics:
  https://elsevier.libguides.com/Scopus/topical-search
  https://g.wanfangdata.com.cn/
  https://pubmed.ncbi.nlm.nih.gov/help/
"""
from __future__ import annotations

import json
import re
from urllib.parse import urlencode, urlsplit


SOURCE_INFO = {
    "wanfang": ("万方", "https://g.wanfangdata.com.cn/"),
    "scopus": ("Scopus", "https://www.scopus.com/pages/home?display=basic#basic"),
    "pubmed": ("PubMed", "https://pubmed.ncbi.nlm.nih.gov/"),
}

# The observed homepage and results search box vary in placeholder punctuation
# and spacing. Use the same visible input selectors for waiting, filling and
# reading the submitted query; a filled homepage field is not a results page.
WANFANG_SEARCH_FIELDS = (
    'input#search-input', 'input#searchInput', 'input.search-input', '.search-input input',
    '.search-box input', '.searchBox input', 'input[placeholder="海量资源, 等你发现"]',
    'input[placeholder="海量资源，等你发现"]', 'input[placeholder^="海量资源"]',
    'input[placeholder*="检索"]', 'textarea[placeholder*="检索"]', 'input[placeholder*="搜索"]',
)


_SNAPSHOT_JS = r"""/* literature_extra_snapshot */ ({source,limit}) => {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g,' ');
  const first = (root, selectors) => {
    for(const selector of selectors) {
      const el=Array.from(root.querySelectorAll(selector)).find(visible); if(el) return el;
    } return null;
  };
  const texts = selectors => Array.from(document.querySelectorAll(selectors)).filter(visible).map(text).join(' ');
  const head=(document.body?.innerText || '').slice(0,4500);
  const captcha=Array.from(document.querySelectorAll('iframe[src*="captcha"],iframe[src*="recaptcha"],.geetest_panel,.verifybox,#captcha,.captcha,#challenge-running,.cf-turnstile')).some(visible)
    || /人机验证|滑动验证|请完成验证|访问验证|unusual traffic|verify you are human|are you a robot|verify your identity|checking your browser/i.test(head.slice(0,1600));
  const password=Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const accessRequired=/您所在的机构未订购|没有访问权限|无访问权限|不在授权范围|机构没有订购|your institution does not have|institutional access is required|not entitled|subscription required|access is not available|you do not have access|not authorized to access|access denied/i.test(head);
  const loginPrompt=/请先登录|请登录后|登录后方可|登录后检索|sign in to access|sign in to search|log in to access|please sign in|please log in|access through your institution|institutional sign in/i.test(head);
  const querySelectors=source==='pubmed'
    ? 'input#id_term,textarea#id_term,input[name="term"],textarea[name="term"]'
    : source==='scopus'
    ? '#basic-panel input[id^="autosuggest-"],input[id^="autosuggest-"],#searchterm1,input[name="searchterm1"],textarea[name="searchterm1"],input[data-testid="search-input"],input[aria-label="Search documents"],textarea[aria-label="Search documents"]'
    : __WANFANG_SEARCH_FIELDS__;
  const queries=Array.from(document.querySelectorAll(querySelectors)).filter(visible)
    .map(el=>el.value || text(el)).filter(Boolean);
  const summary=texts(source==='scopus' ? '.search-query,.query-text,[data-testid="search-query"]' : '.search-condition,.search-query,.query-text');
  if(summary) queries.push(summary);
  let rows=[], resultContainer=false, noResults=false;
  if(source==='pubmed') {
    // PubMed's visible Show more control appends a new results chunk.  Reading
    // only the last nonempty chunk avoids returning the first page repeatedly.
    const chunks=Array.from(document.querySelectorAll('.search-results-chunk'))
      .filter(chunk=>visible(chunk) && chunk.querySelector('article.full-docsum'));
    rows=Array.from((chunks.at(-1) || document).querySelectorAll('article.full-docsum'));
    resultContainer=!!first(document,['.search-results-chunk','.search-results','.results-amount']);
    noResults=/no results were found|no results found|your search.*did not retrieve any results/i.test(texts('.no-results,.no-results-message,.search-results p,.search-results .error-message'));
  } else if(source==='scopus') {
    for(const selector of ['tr[class*="TableItems_resultsRow"]','[data-testid="search-result"]','[data-testid="document-result"]','tr.searchArea','li.searchArea','.search-result-item','[data-scid="document-results-list-item"]']) {
      rows=Array.from(document.querySelectorAll(selector)).filter(visible); if(rows.length) break;
    }
    if(!rows.length) {
      const seen=new Set();
      for(const link of document.querySelectorAll('a[href*="/pages/publications/"],a[data-testid="document-title"],a.ddmDocTitle,a.docTitle,a[href*="/record/display.uri"]')) {
        const row=link.closest('tr,li,article,[data-testid="search-result"],.search-result-item');
        if(visible(link) && visible(row) && !seen.has(row)) {seen.add(row); rows.push(row);}
      }
    }
    resultContainer=!!first(document,['tr[class*="TableItems_resultsRow"]','[data-testid="search-results"]','[data-testid="document-results-list"]','#searchResForm','.search-results','.document-results']);
    noResults=/no documents (?:were )?found|no results found|your search did not match any documents|no documents match/i.test(texts('[data-testid="no-results"],.no-results,.zero-results,.search-results-error,.errorMessage'))
      || /\b0\s+documents? found\b/i.test(texts('h2'));
  } else if(source==='wanfang') {
    // The actual 2026 Wanfang /paper result page also lists patents under its
    // All tab.  Only visible paper resource cards are bibliographic candidates.
    rows=Array.from(document.querySelectorAll('div.normal-list.periodical-list,div.normal-list.thesis-list,div.normal-list.conference-list')).filter(visible);
    for(const selector of rows.length ? [] : ['.normal-list .normal-list-item','.normal-list .list-item','.search-result-list .search-result-item','.result-list .result-item','.search-result-item','.record-item']) {
      rows=Array.from(document.querySelectorAll(selector)).filter(visible); if(rows.length) break;
    }
    if(!rows.length) {
      const seen=new Set();
      for(const link of document.querySelectorAll('a[href*="d.wanfangdata.com.cn/periodical/"],a[href*="d.wanfangdata.com.cn/thesis/"],a[href*="d.wanfangdata.com.cn/conference/"]')) {
        const row=link.closest('.normal-list-item,.list-item,.result-item,.search-result-item,.record-item,article,li');
        if(visible(link) && visible(row) && !seen.has(row)) {seen.add(row); rows.push(row);}
      }
    }
    resultContainer=!!first(document,['.normal-list','.search-result-list','.result-list','.search-results']);
    noResults=/未找到相关|没有找到相关|暂无检索结果|检索结果为\s*0|共\s*0\s*条|0\s*条结果|无相关检索结果/i.test(texts('.no-result,.no-results,.no-data,.empty-result,.result-count,.search-result-count,.empty-tip'));
  }
  const results=[];
  for(const row of rows) {
    if(results.length>=limit || !visible(row)) continue;
    let a,authors='',venue='',year='',snippet='',pmid='';
    if(source==='pubmed') {
      a=first(row,['a.docsum-title']);
      authors=text(first(row,['.docsum-authors.full-authors','.docsum-authors']));
      const citation=text(first(row,['.docsum-journal-citation.full-journal-citation','.docsum-journal-citation']));
      year=citation.match(/\b(?:18|19|20)\d{2}\b/)?.[0] || '';
      venue=text(first(row,['.docsum-journal-citation.short-journal-citation'])) || citation;
      snippet=text(first(row,['.full-view-snippet','.docsum-snippet']));
      pmid=text(first(row,['.docsum-pmid'])).replace(/^PMID:\s*/i,'').match(/^\d+$/)?.[0] || '';
      if(!pmid) pmid=(a?.getAttribute('href') || '').match(/^\/(\d+)\/?$/)?.[1] || '';
    } else if(source==='scopus') {
      a=first(row,['a[href*="/pages/publications/"]','a[data-testid="document-title"]','a.ddmDocTitle','a.docTitle','a[href*="/record/display.uri"]','h3 a']);
      authors=text(first(row,['div[data-testid="author-list"]','[data-testid="authors"]','.ddmAuthorList','.author-list','.authors','.author']));
      venue=text(first(row,['div[data-component="document-source"] a','[data-testid="source-title"]','.ddmSourceTitle','.source-title','.publication-title']));
      year=text(first(row,['div[data-testid="document-publication-year"]','[data-testid="publication-year"]','.ddmPubYr','.publication-year','.year']));
      snippet=text(first(row,['[data-testid="abstract"]','.abstract','.snippet']));
    } else {
      a=first(row,['.title a','a.title','.record-title a','.ajust span.title','a[href*="d.wanfangdata.com.cn/periodical/"]','a[href*="d.wanfangdata.com.cn/thesis/"]','a[href*="d.wanfangdata.com.cn/conference/"]']);
      const byline=Array.from(row.querySelectorAll('.author-area .authors')).filter(visible).map(text);
      authors=byline.length ? byline.filter(value=>!/^(?:18|19|20)\d{2}\s*年/.test(value)).join('; ')
        : text(first(row,['.authors','.author','.author-name','.text-authors']));
      venue=text(first(row,['span.periodical-title','.source','.journal','.source-title','.periodical-name']));
      year=text(first(row,['.year','.date','.publish-year','.publication-date']))
        || byline.find(value=>/^(?:18|19|20)\d{2}\s*年/.test(value))?.match(/(?:18|19|20)\d{2}/)?.[0] || '';
      snippet=text(first(row,['div.abstract-area','.abstract','.summary','.snippet']));
    }
    const title=text(a); if(!title) continue;
    if(source==='wanfang') {
      const resource=text(first(row,['.essay-type','.resource-type']));
      if(/专利|标准|法规|patent|standard/i.test(resource)) continue;
      const knownPaper=/(?:periodical|thesis|conference)-list/.test(row.className || '')
        || /期刊|学位|会议/.test(resource)
        || /^https:\/\/d\.wanfangdata\.com\.cn\/(?:periodical|thesis|conference)\//.test(a?.href || '');
      if(!knownPaper) continue;
    }
    const doiLink=first(row,['a[href*="doi.org/"]']);
    const doi=doiLink ? doiLink.href.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'')
      : (text(row).match(/\b10\.\d{4,9}\/[^\s<>"']+/i)?.[0] || '');
    const fulltext_links=Array.from(row.querySelectorAll('a[href$=".pdf"],a.full-text,a[data-testid="full-text-link"],a[href*="pmc.ncbi.nlm.nih.gov/articles/"]'))
      .filter(visible).map(link=>({label:text(link),url:link.href}));
    const result={title,authors,byline:authors,venue,year,result_url:a?.href || '',snippet,doi,pmid,fulltext_links};
    if(source==='wanfang' && a?.tagName==='SPAN') {
      // A visible title position is sufficient to click later.  Never read or
      // build a detail URL from Wanfang's hidden opaque identifier span.
      result._title_index=Array.from(document.querySelectorAll('span.title')).indexOf(a);
    }
    results.push(result);
  }
  return {captcha,password,loginPrompt,accessRequired,queries,results,resultContainer,noResults,
    visible_result_count:rows.filter(visible).length};
}""".replace('__WANFANG_SEARCH_FIELDS__', json.dumps(','.join(WANFANG_SEARCH_FIELDS), ensure_ascii=False))


def snapshot(page, source, limit):
    if source not in SOURCE_INFO:
        raise ValueError("该检索来源未接通。")
    return page.evaluate(_SNAPSHOT_JS, {"source": source, "limit": max(1, min(int(limit), 200))})


def _wanfang_detail_url(value):
    try:
        parsed = urlsplit(str(value or ""))
        if (parsed.scheme == "https" and parsed.hostname == "d.wanfangdata.com.cn"
                and not parsed.username and not parsed.password
                and re.match(r"^/(?:periodical|thesis|conference)/", parsed.path)):
            return value
    except (TypeError, ValueError):
        pass
    return ""


def resolve_result_links(page, source, rows, limit=10):
    """Resolve Wanfang's visible span titles only after frozen query checks.

    The real site opens a detail popup from span.title rather than rendering an
    anchor.  Read the actual resulting URL; do not reconstruct opaque URLs from
    hidden IDs.  Only popups created by our title click are closed afterwards.
    A same-tab variant is restored to its search page before the next record.
    Failed resolutions remain empty for the caller to report unrecognized DOM.
    """
    if source != "wanfang":
        return rows
    resolved = []
    maximum = max(1, min(int(limit), 200))
    for original in rows[:maximum]:
        row = dict(original)
        index = row.pop("_title_index", None)
        if row.get("result_url") or not isinstance(index, int) or index < 0:
            resolved.append(row)
            continue
        titles = page.locator("span.title")
        if index >= titles.count():
            resolved.append(row)
            continue
        title = titles.nth(index)
        if not title.is_visible() or _normalized(title.inner_text()) != _normalized(row.get("title")):
            resolved.append(row)
            continue
        popup = None
        previous = page.url
        try:
            with page.expect_popup(timeout=8_000) as result:
                title.click()
            popup = result.value
            if not _wanfang_detail_url(popup.url):
                try:
                    popup.wait_for_load_state("domcontentloaded", timeout=15_000)
                except Exception:
                    pass
            row["result_url"] = _wanfang_detail_url(popup.url)
        except Exception:
            if page.url != previous:
                row["result_url"] = _wanfang_detail_url(page.url)
        finally:
            if popup is not None:
                try:
                    popup.close()
                except Exception:
                    pass
            if page.url != previous:
                try:
                    page.go_back(wait_until="domcontentloaded", timeout=30_000)
                except Exception:
                    # Stop resolving if the bound results page cannot be restored.
                    resolved.append(row)
                    resolved.extend(dict(item) for item in rows[len(resolved):maximum])
                    return resolved
        resolved.append(row)
    return resolved


def _first_visible(page, selectors):
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(min(locator.count(), 10)):
            candidate = locator.nth(index)
            if candidate.is_visible():
                return candidate
    return None


def _normalized(value):
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _wait(page, selector):
    try:
        page.wait_for_selector(selector, timeout=15_000)
    except Exception:
        # The caller diagnoses login, verification, permissions, or unknown DOM.
        pass


def _named_button(page, selectors, names):
    # CSS :text-is checks direct text nodes, unlike a button's accessible name.
    # Wanfang's observed button wraps both its icon and label in child spans.
    for name in names:
        locator = page.get_by_role("button", name=name, exact=True)
        for index in range(min(locator.count(), 10)):
            button = locator.nth(index)
            if button.is_visible():
                return button
    # Preserve compatible older markup, but never select a longer action such
    # as "AI增强检索" merely because it contains the word "检索".
    allowed = {_normalized(name) for name in names}
    for selector in selectors:
        locator = page.locator(selector)
        for index in range(min(locator.count(), 10)):
            button = locator.nth(index)
            if button.is_visible() and _normalized(button.inner_text()) in allowed:
                return button
    return None


def _submit(page, field, query, buttons, *, button_names=()):
    if field is None:
        return False
    button = _named_button(page, buttons, button_names) if button_names else _first_visible(page, buttons)
    if button is None:
        return False
    field.fill(query)
    if _normalized(field.input_value()) != _normalized(query):
        return False
    button.click()
    return True


def _scopus_document_mode(page):
    return bool(page.evaluate(r"""/* scopus_document_mode */ () => {
      const visible=el=>!!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text=el=>(el?.innerText || el?.textContent || '').trim().replace(/\s+/g,' ');
      const active=Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"],a[aria-current="page"],.search-tabs .active')).filter(visible).map(text);
      if(active.some(value=>/^(?:Authors?|Organizations?|作者|机构)$/i.test(value))) return false;
      const basic=Array.from(document.querySelectorAll('#basic[aria-selected="true"],#s[aria-selected="true"]')).find(visible);
      if(basic && /^(?:Documents?|文献)$/i.test(text(basic))) return true;
      if(active.some(value=>/^(?:Documents?|文献)$/i.test(value))) return true;
      return Array.from(document.querySelectorAll('h1,h2,legend')).filter(visible)
        .some(el=>/^(?:Search documents|Document search|文献检索)$/i.test(text(el)));
    }"""))


def _scopus_fields(page):
    return page.evaluate(r"""/* scopus_search_field */ () => {
      const visible=el=>!!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text=el=>(el?.innerText || el?.textContent || '').trim().replace(/\s+/g,' ');
      const selectors=['#basic-panel select[data-testid="select-search-within"]','select[data-testid="select-search-within"]','select#field1','select[name="field1"]','[data-testid="search-field-dropdown"]','[aria-label="Search within"]','[aria-label="Search field"]'];
      for(const selector of selectors) {
        const el=Array.from(document.querySelectorAll(selector)).find(visible);
        if(el) return el.tagName==='SELECT' ? text(el.selectedOptions?.[0]) : text(el);
      } return '';
    }""")


def _is_title_abstract_keywords(value):
    value = _normalized(value).replace("&", "and")
    return bool(re.fullmatch(r"(?:article\s+)?title\s*,?\s*abstract\s*,?\s*(?:and\s+)?keywords(?:\s*\(title-abs-key\))?|题名[、，,\s]*摘要[、，,\s]*(?:和)?关键词", value))


def query_context_valid(page, source):
    """Scopus query text alone cannot distinguish an author/document search.

    A caller resuming a manually changed page must require the visible basic
    Documents + Title/Abstract/Keywords controls, or re-submit through navigate.
    Result pages without these controls need this run's actual submit proof.
    """
    return source != "scopus" or (
        _scopus_document_mode(page) and _is_title_abstract_keywords(_scopus_fields(page)))


def _balanced_expression(value):
    depth = 0
    quoted = False
    escaped = False
    for character in value:
        if escaped:
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif not quoted and character == "(":
            depth += 1
        elif not quoted and character == ")":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and not quoted


def _submit_scopus(page, query):
    if not _scopus_document_mode(page):
        return False
    if not _is_title_abstract_keywords(_scopus_fields(page)):
        picker = _first_visible(page, [
            '#basic-panel select[data-testid="select-search-within"]', 'select[data-testid="select-search-within"]',
            'select#field1', 'select[name="field1"]', '[data-testid="search-field-dropdown"]',
            '[aria-label="Search within"]', '[aria-label="Search field"]',
        ])
        if picker is None:
            return False
        # The observed 2026 native select uses TITLE_ABS_KEY as its option value.
        # This differs from the advanced expression TITLE-ABS-KEY(...). Other
        # layouts must expose a visible exact field option after opening them.
        try:
            picker.select_option(value="TITLE_ABS_KEY")
        except Exception:
            picker.click()
            option = _first_visible(page, [
                '[role="option"]:text-is("Article title, Abstract, Keywords")',
                '[role="option"]:text-is("Article title, abstract, keywords")',
                '[role="option"]:text-is("Title, Abstract, Keywords")',
            ])
            if option is None:
                return False
            option.click()
        if not _is_title_abstract_keywords(_scopus_fields(page)):
            return False
    wrapped = re.fullmatch(r"\s*TITLE-ABS-KEY\s*\((.*)\)\s*", query, re.I | re.S)
    if wrapped:
        query = wrapped.group(1).strip()
        if not query or not _balanced_expression(query):
            return False
    if re.search(r"\b(?:TITLE-ABS-KEY|TITLE_ABS_KEY|TITLE|AUTH(?:LASTNAME|FIRST)?|AFFIL|ABS|KEY|DOCTYPE|PUBYEAR|SRCTITLE|SUBJAREA|INDEXTERMS|EXACTKEYWORD)[\s(=]", query, re.I):
        # Advanced field expressions must not be silently treated as free text
        # in the basic Title/Abstract/Keywords form.
        return False
    field = _first_visible(page, [
        '#basic-panel input[id^="autosuggest-"]',
        'input[id^="autosuggest-"]',
        'input#searchterm1', 'textarea#searchterm1', 'input[name="searchterm1"]',
        'textarea[name="searchterm1"]', 'input[data-testid="search-input"]',
        'input[aria-label="Search documents"]', 'textarea[aria-label="Search documents"]',
    ])
    submitted = _submit(page, field, query, [
        'button#search', 'button#search-button', 'button[data-testid="search-button"]',
        'button[type="submit"]:has-text("Search")', 'button:text-is("Search")',
        'button:text-is("检索")',
    ])
    if submitted:
        _wait(page, 'a[href*="/pages/publications/"],a.ddmDocTitle,a.docTitle,[data-testid="document-title"],[data-testid="no-results"],.no-results,input[type="password"]')
    return submitted


def navigate(page, source, query, year_from=None, year_to=None):
    """Submit the frozen query on a fixed official page; never bypass auth."""
    del year_from, year_to  # Existing workflow performs documented year post-filtering.
    if source not in SOURCE_INFO or not isinstance(query, str) or not query.strip() or len(query) > 2000:
        return False
    url = SOURCE_INFO[source][1]
    if source == "pubmed":
        # NLM documents term= as its public, bookmarkable search parameter.
        url += "?" + urlencode({"term": query})
    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    if source == "pubmed":
        _wait(page, 'article.full-docsum,.no-results,#id_term,input[type="password"]')
        return True
    if source == "scopus":
        _wait(page, '#basic-panel input[id^="autosuggest-"],#searchterm1,[data-testid="search-input"],input[type="password"]')
        return _submit_scopus(page, query)
    _wait(page, ','.join((*WANFANG_SEARCH_FIELDS, 'input[type="password"]')))
    field = _first_visible(page, WANFANG_SEARCH_FIELDS)
    submitted = _submit(page, field, query, [
        'button.search-btn', 'button.search-button', '.search-box button[type="submit"]',
        'button:text-is("检索")', 'button:text-is("搜索")', '.search-btn:text-is("检索")',
        '.search-btn:text-is("搜索")',
    ], button_names=("检索", "搜索"))
    if submitted:
        # Generic homepage recommendation containers are not search results.
        # Wait for the same visible paper cards used by snapshot(), or an
        # explicit empty/auth page, instead of any .result-list container.
        _wait(page, 'div.normal-list.periodical-list,div.normal-list.thesis-list,div.normal-list.conference-list,'
                    '.normal-list .normal-list-item,.normal-list .list-item,.search-result-list .search-result-item,'
                    '.result-list .result-item,.search-result-item,.record-item,'
                    '.no-result,.no-results,input[type="password"]')
    return submitted
