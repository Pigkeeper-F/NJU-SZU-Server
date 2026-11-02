"""Conservative native advanced/professional search, using visible DOM only.

The layouts below are semantic contracts, not a claim of live site validation.
An unknown editor, a truncated query, or a missing execution summary pauses.
No basic-search fallback, hidden API, challenge retry, or credential access.
"""
from __future__ import annotations

import hashlib
import re
import time
from urllib.parse import urljoin, urlsplit

from literature_source_access import submission_allowed
from literature_native_diagnostics import native_failure, diagnose_native_failure


PROOF = "native-visible-expression-v1"
EDITOR_SELECTOR = "textarea"
BUTTON_SELECTOR = 'button,input[type="submit"],input[type="button"],[role="button"]'
ENTRY_SELECTOR = 'a,button,[role="tab"],li[name="majorSearch"],li[name="gradeSearch"]'
YEAR_SELECTOR = 'select,input[type="number"],input[type="date"],input[type="text"]'

# Return only control labels, the visible query/years and proof booleans. Never
# return body text, login inputs, cookies, hidden application state or URLs.
PROBE_JS = r'''/* literature_native_probe */ ({source}) => {
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g,' ');
  const all = selector => Array.from(document.querySelectorAll(selector));
  const attr = (el,key) => el.getAttribute(key) || '';
  const name = el => [attr(el,'aria-label'),attr(el,'placeholder'),
    ...all('label').filter(x=>attr(x,'for') && attr(x,'for')===attr(el,'id')).map(text),
    ...attr(el,'aria-labelledby').split(/\s+/).filter(Boolean).map(id=>text(all('[id]').find(x=>attr(x,'id')===id)))].join(' ').trim();
  const nativeLabel = source==='web-of-science' ? /^(?:query builder|查询构建器)$/i
    : source==='scopus' ? /^(?:advanced search|advanced query|高级检索|高级搜索)$/i : /^专业检索$/;
  const active = all('[role="tab"][aria-selected="true"],a[aria-current="page"],.active,.is-active,.selected,.cur,.on')
    .filter(visible).some(el=>nativeLabel.test(text(el)));
  const heading = all('h1,h2,h3,legend').filter(visible).some(el=>nativeLabel.test(text(el)));
  const areas = all('textarea');
  const eligible = areas.map((el,index)=>({el,index,label:name(el)})).filter(x=>visible(x.el)
    && !x.el.disabled && !x.el.readOnly && !/basic|普通检索|反馈|comment|feedback/i.test(x.label));
  let candidates=[];
  if(source==='web-of-science') {
    candidates=eligible.filter(x=>/^Enter or edit your query here/i.test(attr(x.el,'placeholder'))
      || ((active||heading) && /query preview|查询预览/i.test(x.label)));
  } else if(source==='scopus') {
    candidates=eligible.filter(x=>(active||heading) && /advanced|query|高级|检索式/i.test(x.label));
  } else if(active||heading) {
    // In the explicit professional pane a single visible textarea is a native
    // expression editor. Never identify it from a header/navigation link alone.
    candidates=eligible;
  }
  let editor=null,button=null,years=[];
  const buttons=all('button,input[type="submit"],input[type="button"],[role="button"]');
  const controls=all('select,input[type="number"],input[type="date"],input[type="text"]');
  if(candidates.length===1) {
    const {el,index,label}=candidates[0];
    editor={index,label,value:el.value||'',maxLength:Number(el.maxLength)>0?Number(el.maxLength):null};
    // The nearest container with this editor and exactly one final Search
    // control avoids WOS's separate 'Add to query' and unrelated site search.
    let scope=el.parentElement;
    for(let depth=0;scope && depth<7;depth++,scope=scope.parentElement) {
      if(scope===document.body) break;
      const choices=buttons.filter(b=>visible(b) && scope.contains(b)
        && /^(?:Search|检索|搜索)$/i.test(text(b)||b.value||attr(b,'aria-label'))
        && !b.disabled && attr(b,'aria-disabled')!=='true');
      if(choices.length===1) {button={index:buttons.indexOf(choices[0]),label:text(choices[0])||choices[0].value||attr(choices[0],'aria-label')};break;}
      if(choices.length>1) break;
    }
  }
  const yearControls=controls.map((el,index)=>({el,index,label:name(el)})).filter(x=>visible(x.el)&&!x.el.disabled);
  for(const [role,pattern] of [['from',/起始年|开始年|起始时间|开始时间|start year|from year|year from/i],
                              ['to',/终止年|结束年|截止年|结束时间|截止时间|end year|to year|year to/i]]) {
    const found=yearControls.filter(x=>pattern.test(x.label));
    if(found.length===1) {const x=found[0];years.push({role,index:x.index,value:x.el.value||'',label:x.label,
      tag:(x.el.tagName||'').toLowerCase(),options:Array.from(x.el.options||[]).map(o=>({label:text(o),value:o.value}))});}
  }
  // Some Chinese professional forms label a two-select row once as 发表时间.
  if(years.length!==2) {
    const labels=all('label,span,div').filter(visible).filter(el=>/^(?:发表时间|发表年份|出版年份)[:：]?$/.test(text(el)));
    const pairs=[];
    for(const label of labels) {
      const parent=label.parentElement;if(!parent||parent===document.body)continue;
      const found=yearControls.filter(x=>parent.contains(x.el)&&(x.el.tagName||'').toLowerCase()==='select');
      if(found.length===2) pairs.push(found);
    }
    if(pairs.length===1) years=pairs[0].map((x,i)=>({role:i?'to':'from',index:x.index,value:x.el.value||'',label:x.label,
      tag:'select',options:Array.from(x.el.options||[]).map(o=>({label:text(o),value:o.value}))}));
  }
  if(source==='cnki') {
    const pair=['datebox0','datebox1'].map(id=>yearControls.find(x=>attr(x.el,'id')===id));
    if(pair.every(Boolean) && pair[0].el.parentElement===pair[1].el.parentElement
      && /发表时间/.test(text(pair[0].el.parentElement))) {
      years=pair.map((x,i)=>({role:i?'to':'from',index:x.index,value:x.el.value||'',
        label:'发表时间',tag:'cnki-date',options:[]}));
    }
  }
  const entries=all('a,button,[role="tab"],li[name="majorSearch"],li[name="gradeSearch"]');
  const entryPatterns=source==='web-of-science' ? [/^query builder$/i,/^advanced search$/i]
    :source==='scopus'?[/^(?:edit in )?advanced search$/i]:[/^专业检索$/,/^高级检索$/];
  let entry=null;
  if(!editor) for(const pattern of entryPatterns) {
    const found=entries.filter(el=>visible(el)&&pattern.test(text(el))&&!el.disabled&&attr(el,'aria-selected')!=='true');
    if(found.length===1){entry={index:entries.indexOf(found[0]),label:text(found[0]),href:attr(found[0],'href'),target:attr(found[0],'target')};break;}
    if(found.length>1)break;
  }
  const summaries=all('[data-ta="search-query"],[data-testid="search-query"],.search-query,.query-text,.searchResultQuery,.search-condition,.search-condition-list,.search-expression,#search-query')
    .filter(visible).filter(el=>!['TEXTAREA','INPUT'].includes(el.tagName) && !el.isContentEditable
      && !el.querySelector('textarea,input,[contenteditable="true"]')).map(text).filter(Boolean);
  const dateSummaries=all('.search-condition,.search-condition-list,[data-testid="date-filter"],[data-ta="timespan"],.search-year,.year-range')
    .filter(visible).map(text).filter(Boolean);
  const syntaxError=all('[role="alert"],.error-message,.search-error,.mat-error').filter(visible)
    .some(el=>/invalid query|syntax|检索式.*(?:错误|无效)|语法错误/i.test(text(el)));
  const currentPages=all('[aria-current="page"],.pagination .active,.pager .active,input[aria-label="Page number"],[data-ta="page-number"]')
    .filter(visible).map(el=>String(el.value||text(el))).filter(v=>/^\d+$/.test(v));
  let pageNumber=currentPages.length===1?Number(currentPages[0]):null;
  if(source==='cnki') {
    const marks=all('.countPageMark').filter(visible).map(text).filter(v=>/^\d+\s*\/\s*\d+$/.test(v));
    if(marks.length===1) pageNumber=Number(marks[0].split('/')[0]);
  }
  const menus=all('.headsch > a.nxgp-title').filter(visible).filter(el=>/^检索$/.test(text(el)));
  const menu=source==='cnki' && !editor && !entry && menus.length===1 ? '.headsch > a.nxgp-title' : null;
  return {editor,button,years,entry,menu,summaries,dateSummaries,syntaxError,pageNumber,modeVerified:!!editor};
}'''


def probe(page, source):
    result = page.evaluate(PROBE_JS, {"source": source})
    return result if isinstance(result, dict) else {}


def canonical(value):
    # Ignore formatting only. Preserve whitespace inside quoted phrases.
    value = re.sub(r"^\s*(?:检索表达式(?:[（(][^）)]*[）)])?|检索式|search query|query)\s*[:：]\s*", "", str(value), flags=re.I)
    output, quoted = [], None
    for char in value.strip():
        if char in "\"'" and (quoted is None or quoted == char):
            quoted = None if quoted else char
        if quoted or not char.isspace():
            output.append(char.casefold())
    return "".join(output)


def _year(value):
    found = re.fullmatch(r"\s*(\d{4})(?:年|[-/]\d{1,2}[-/]\d{1,2})?\s*", str(value))
    return int(found.group(1)) if found else None


def _embedded_years(source, query, year_from, year_to):
    if year_from is None and year_to is None:
        return True
    if source == "web-of-science":
        dates = re.findall(r"\bDOP\s*=\s*(\d{4})-\d{2}-\d{2}/(\d{4})-\d{2}-\d{2}\b", query, re.I)
        return len(dates) == 1 and (year_from is None or int(dates[0][0]) == year_from) and (year_to is None or int(dates[0][1]) == year_to)
    if source == "scopus":
        lower = re.findall(r"\bPUBYEAR\s+AFT\s+(\d{4})\b", query, re.I)
        upper = re.findall(r"\bPUBYEAR\s+BEF\s+(\d{4})\b", query, re.I)
        return (year_from is None or lower == [str(year_from - 1)]) and (year_to is None or upper == [str(year_to + 1)])
    return False


def _visible_years(state, year_from, year_to):
    date_rows = [row for row in state.get("years", []) if row.get("tag") == "cnki-date"]
    if date_rows:
        from literature_cnki_dates import bounds_match
        return bounds_match({row.get("role"): row.get("value") for row in date_rows}, year_from, year_to)
    values = {row.get("role"): _year(row.get("value")) for row in state.get("years", [])}
    if (year_from is None or values.get("from") == year_from) and (year_to is None or values.get("to") == year_to):
        return True
    for summary in state.get("dateSummaries", []):
        match = re.fullmatch(r"\s*(?:发表时间|发表年份|出版年份|Publication Years?|Timespan)\s*[:：]?\s*(\d{4})\s*(?:年)?\s*[-–—至/]\s*(\d{4})\s*年?\s*", summary, re.I)
        if match and (year_from is None or int(match[1]) == year_from) and (year_to is None or int(match[2]) == year_to):
            return True
    return False


def result_proof(state, source, query, year_from, year_to):
    explicit_years = {row.get("role"): _year(row.get("value")) for row in state.get("years", [])}
    conflict = any(target is not None and role in explicit_years and explicit_years[role] != target
                   for role, target in (("from", year_from), ("to", year_to)))
    return (not conflict and not state.get("syntaxError") and any(canonical(item) == canonical(query) for item in state.get("summaries", []))
            and (_embedded_years(source, query, year_from, year_to) or _visible_years(state, year_from, year_to)))


def _official(source, url):
    parsed = urlsplit(str(url or ""))
    domain = {"cnki": "cnki.net", "wanfang": "wanfangdata.com.cn", "scopus": "scopus.com", "web-of-science": "webofscience.com"}[source]
    host = (parsed.hostname or "").lower()
    return parsed.scheme in ("http", "https") and not parsed.username and not parsed.password and (
        host == domain or host.endswith("." + domain) or (source == "web-of-science" and host == "webofscience.clarivate.cn"))


def _result_scope(source, url):
    # This configured source is Core Collection, not All Databases. Do not
    # borrow an identical expression executed in another WOS collection.
    return _official(source, url) and (source != "web-of-science" or urlsplit(url).path.startswith("/wos/woscc/"))


def find_editor(page, source, *, required_year_roles=(), navigate=True):
    """At most two explicit advanced-mode navigation clicks, never a search."""
    seen = set()
    for step in range(3):
        if not _official(source, page.url) or not submission_allowed(page, source):
            return {}
        state = probe(page, source)
        if state.get("menu"):
            page.locator(state["menu"]).hover(timeout=5000)
            state = probe(page, source)
        # Professional panes can expose their editor before the publication
        # controls finish loading. Wait for two matching visible-control
        # snapshots, including the required dates, rather than that first DOM.
        deadline, previous = time.monotonic() + 5, None
        while True:
            if not _official(source, page.url) or not submission_allowed(page, source):
                return {}
            ready = (state.get("editor") and state.get("button") and all(
                sum(row.get("role") == role for row in state.get("years", [])) == 1
                for role in required_year_roles))
            signature = [state.get(key) for key in ("editor", "button", "years")]
            if ready and signature == previous:
                return state
            if not state.get("editor") and state.get("entry"):
                break
            if time.monotonic() >= deadline:
                return {} if ready else state
            previous = signature if ready else None
            time.sleep(0.1)
            state = probe(page, source)
        entry = state.get("entry")
        if not navigate or step == 2 or not entry or entry.get("label") in seen:
            return state
        href = entry.get("href", "")
        if href and not href.startswith("javascript:") and not _official(source, urljoin(page.url, href)):
            return state
        seen.add(entry["label"])
        if not submission_allowed(page, source):
            return {}
        if entry.get("target") == "_blank" and href and not href.startswith("javascript:"):
            # Follow the visible official link in the task's bound tab so the
            # next verification does not accidentally inspect its old opener.
            page.goto(urljoin(page.url, href), wait_until="domcontentloaded", timeout=30_000)
        else:
            page.locator(ENTRY_SELECTOR).nth(entry["index"]).click(timeout=10_000)
        # A bounded condition wait reads this same foreground page only.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not submission_allowed(page, source):
                return {}
            next_state = probe(page, source)
            if next_state.get("editor") or next_state.get("entry") != entry:
                break
            time.sleep(0.1)
    return {}


def submit(page, source, query, year_from=None, year_to=None, *, failure_out=None,
           submission_out=None, before_click_snapshot=None):
    """Returns only a submit proof, not success. Result verification is separate."""
    def fail(code=None, state=None, **details):
        failure = (native_failure(code, phase="submit", details=details) if code
                   else diagnose_native_failure(state, phase="form", require_years=True, years_match=False))
        if isinstance(failure_out, dict):
            failure_out.update(failure)
        return False
    if not _result_scope(source, page.url) or not submission_allowed(page, source):
        return fail("native_source_scope_unverified")
    embedded_years = _embedded_years(source, query, year_from, year_to)
    required_roles = (() if embedded_years else tuple(role for role, target in
        (("from", year_from), ("to", year_to)) if target is not None))
    state = find_editor(page, source, required_year_roles=required_roles)
    editor, button = state.get("editor"), state.get("button")
    if not editor or not button:
        return fail(state=state)
    if editor.get("maxLength") and len(query) > editor["maxLength"]:
        return fail("native_query_length_exceeded")
    if not embedded_years:
        # Only labelled native year controls are writable; unknown widgets pause.
        for role, target in (("from", year_from), ("to", year_to)):
            if target is None:
                continue
            matches = [row for row in state.get("years", []) if row.get("role") == role]
            if len(matches) != 1:
                return fail("native_year_controls_missing")
            row = matches[0]
            if source == "cnki" and row.get("tag") == "cnki-date":
                from literature_cnki_dates import set_year_bound
                if not set_year_bound(page, role, target):
                    return fail("native_year_bounds_unverified")
                continue
            if _year(row.get("value")) == target:
                continue
            if row.get("tag") != "select":
                return fail("native_year_bounds_unverified")
            options = [option for option in row.get("options", []) if _year(option.get("label")) == target]
            if len(options) != 1 or not submission_allowed(page, source):
                return fail("native_year_bounds_unverified")
            page.locator(YEAR_SELECTOR).nth(row["index"]).select_option(value=options[0]["value"])
        state = find_editor(page, source, required_year_roles=required_roles, navigate=False)
        if not _visible_years(state, year_from, year_to):
            return fail("native_year_bounds_unverified")
    current = probe(page, source)
    if (current.get("editor") != state.get("editor") or current.get("button") != state.get("button")
            or not current.get("button") or current["button"].get("label") != button.get("label")
            or not current.get("editor") or current["editor"].get("index") != editor["index"]
            or current["editor"].get("label") != editor.get("label") or not _result_scope(source, page.url)
            or not submission_allowed(page, source)):
        return fail("native_navigation_unverified")
    # Visible calendar widgets add buttons to the global selector list. The
    # final Search was uniquely re-identified in the editor's own scope above;
    # use its current index, never the pre-calendar index.
    button = current["button"]
    page.locator(EDITOR_SELECTOR).nth(editor["index"]).fill(query)
    filled = probe(page, source)
    if (not filled.get("editor") or filled["editor"].get("index") != editor["index"]
            or filled["editor"].get("value") != query or filled.get("button") != button
            or (not embedded_years and not _visible_years(filled, year_from, year_to))
            or not _result_scope(source, page.url) or not submission_allowed(page, source)):
        return fail("native_query_write_unverified")
    if isinstance(submission_out, dict) and before_click_snapshot is not None:
        before_snapshot = before_click_snapshot()
        if (source == "cnki" and (before_snapshot.get("results") or before_snapshot.get("noResults"))) or not submission_allowed(page, source):
            return fail("native_navigation_unverified")
        submission_out.update(before_state=filled, before_snapshot=before_snapshot, clicked_normally=False)
    page.locator(BUTTON_SELECTOR).nth(button["index"]).click(timeout=15_000)
    if isinstance(submission_out, dict):
        submission_out["clicked_normally"] = True
    return True


def _proof_key(query, year_from, year_to):
    return hashlib.sha256(f"{query}\n{year_from}\n{year_to}".encode("utf-8")).hexdigest()


def run(api, source, query, limit, year_from, year_to, *, job_dir, page_index, full_page):
    """Native page transaction. Unknown/resorted cursors never replay page one."""
    read_limit = 200 if full_page else max(1, min(int(limit), 10))
    page = None
    verified_form = False
    proof_key = _proof_key(query, year_from, year_to)

    def response(status="attention", *, reason="results_unrecognized", rows=None, pagination=None, message=None, failure=None):
        result = api._envelope(source, status, reason=reason, results=rows, year_from=year_from, year_to=year_to)
        result.update(page_index=page_index, has_next=None, total_count=None,
            diagnostics={"native_query_required": True, "advanced_form_verified": verified_form})
        if status in ("ok", "no_results"):
            result["applied_filters"] = {key: value for key, value in (("publicationYearFrom", year_from), ("publicationYearTo", year_to)) if value is not None}
            result["deferred_rules"] = []
            result["diagnostics"]["native_execution_verified"] = True
        if message:
            result["message"] = message
        elif reason == "results_unrecognized":
            result["message"] = "高级／专业检索的编辑器、执行式、年份或当前页尚未完整核实，已保留原式和断点。请在本任务官方页面核对后继续，或导出题录后导入；未降级普通检索，也未视为检索完成。"
        if failure and reason == "results_unrecognized":
            result["message"] = failure["message"]
            result["diagnostics"].update(failure.get("diagnostics", {}))
        if pagination:
            result.update(pagination)
        return result

    path = api._binding_path(job_dir)
    bindings = api._load_json(path, {}) if path else {}
    binding = bindings.get(source, {}) if isinstance(bindings, dict) else {}
    native = binding.get("native_query_proof", {}) if isinstance(binding, dict) else {}
    if not isinstance(native, dict):
        native = {}
    receipt = native.get("cnki_receipt")

    def execution_matches(state, snapshot, index):
        if result_proof(state, source, query, year_from, year_to):
            return True
        if source == "cnki" and receipt:
            from literature_cnki_receipt import validate_receipt
            return validate_receipt(receipt, query, year_from, year_to,
                current_snapshot=snapshot, current_state=state,
                result_fingerprint=api._row_fingerprint(snapshot), expected_page_index=index)
        return False
    if page_index and (native.get("version") != PROOF or native.get("key") != proof_key):
        return response()  # A legacy basic binding cannot authorize native replay.
    try:
        with api._runtime() as context:
            if native.get("version") == PROOF and native.get("key") == proof_key:
                # _pick_page creates a tab and changes its binding if the old
                # target vanished. A native continuation must retain that old
                # cursor as evidence instead of overwriting it with a blank tab.
                present = False
                for candidate in context.pages:
                    try:
                        if api._target_id(context, candidate) == binding.get("target_id"):
                            present = True
                            break
                    except Exception:
                        continue
                if not present:
                    return response()
            page, created = api._pick_page(context, source, job_dir)
            page.bring_to_front()
            if created:
                if page_index:
                    return response()
                page.goto(api.SOURCES[source][1], wait_until="domcontentloaded", timeout=60_000)
            current = api._snapshot(page, source, read_limit)
            reason = api._auth_reason(page, current)
            if reason:
                return response(reason=reason)
            if current.get("service_error") or not _official(source, page.url):
                return response()
            state = probe(page, source)
            fingerprint = api._row_fingerprint(current)
            known = (native.get("version") == PROOF and native.get("key") == proof_key
                     and binding.get("result_fingerprint") == fingerprint
                     and execution_matches(state, current, binding.get("page_index")))
            if known:
                verified_form = True
                current_index = binding.get("page_index")
                if current_index not in ((page_index, page_index - 1) if page_index else (0,)):
                    return response()
            elif page_index or native.get("key") == proof_key:
                return response()  # Changed rows or missing result proof require review.
            else:
                # Do not silently replace a manually modified results page.
                if current.get("results") or current.get("noResults"):
                    return response()
                failure = {}
                submission = {}
                verified_form = submit(page, source, query, year_from, year_to, failure_out=failure,
                    submission_out=submission, before_click_snapshot=lambda: api._snapshot(page, source, read_limit))
                if not verified_form:
                    reason = api._auth_reason(page, api._snapshot(page, source, read_limit))
                    return response(reason=reason or "results_unrecognized", failure=failure)
                current = api._snapshot(page, source, read_limit)
                current = (api._wait_wos_records(page, current, read_limit, full_page=full_page) if source == "web-of-science"
                           else api._wait_source_records(page, source, current, read_limit, full_page=full_page))
                state = probe(page, source)
                current_index = 0
                if source == "cnki":
                    from literature_cnki_receipt import create_receipt
                    receipt = create_receipt(query, year_from, year_to,
                        before_state=submission.get("before_state"), before_snapshot=submission.get("before_snapshot"),
                        after_state=state, after_snapshot=current, clicked_normally=submission.get("clicked_normally") is True,
                        result_fingerprint=api._row_fingerprint(current))
            reason = api._auth_reason(page, current)
            if reason:
                return response(reason=reason)
            if (current.get("service_error") or current.get("_source_loading_pending") or current.get("_wos_loading_pending")
                    or current.get("resultsLoading") or not _result_scope(source, page.url)
                    or not execution_matches(state, current, current_index)):
                return response(failure=diagnose_native_failure(state, phase="result", require_years=True,
                    query_matches=any(canonical(item)==canonical(query) for item in state.get("summaries", [])),
                    years_match=_embedded_years(source, query, year_from, year_to) or _visible_years(state, year_from, year_to)))
            # Visible native page number, when present, must agree even for a
            # fresh submission; results can never be borrowed from page N.
            if state.get("pageNumber") is not None and state["pageNumber"] != current_index + 1:
                return response()
            if current_index < page_index:
                previous_pagination = api._pagination(page, source)
                if not submission_allowed(page, source):
                    return response()
                if previous_pagination.get("has_next") is False:
                    # A prior run may have committed this last page before its
                    # terminal controls were understood. Reconfirm that exact
                    # saved page; never invent a next page or replay the query.
                    if (source != "cnki" or not known or not full_page
                            or current_index != page_index - 1
                            or state.get("pageNumber") != current_index + 1
                            or not previous_pagination.get("end_evidence")
                            or previous_pagination.get("page_number", current_index + 1) != current_index + 1):
                        return response()
                    checked = api._snapshot(page, source, read_limit)
                    checked_state = probe(page, source)
                    reason = api._auth_reason(page, checked)
                    if reason:
                        return response(reason=reason)
                    if (checked.get("service_error") or checked.get("resultsLoading")
                            or checked.get("_source_loading_pending") or not _result_scope(source, page.url)
                            or api._row_fingerprint(checked) != fingerprint
                            or checked_state.get("pageNumber") != current_index + 1
                            or not execution_matches(checked_state, checked, current_index)
                            or checked.get("visible_result_count", 0) > read_limit):
                        return response()
                    rows = api._clean_results(checked.get("results") or [], read_limit)
                    if not rows:
                        return response()
                    result = response("ok", reason=None, rows=rows, pagination=previous_pagination)
                    result["terminal_page_verified"] = {"source": source, "page_index": current_index,
                        "result_fingerprint": fingerprint, "pagination": previous_pagination["end_evidence"]}
                    return result
                previous_snapshot, previous_state = current, state
                current = api._advance_page(page, source, current, read_limit)
                if not current:
                    return response()
                reason = api._auth_reason(page, current)
                if reason:
                    return response(reason=reason)
                state = probe(page, source)
                if source == "cnki" and receipt:
                    from literature_cnki_receipt import advance_receipt
                    receipt = advance_receipt(receipt, query, year_from, year_to,
                        before_snapshot=previous_snapshot, before_state=previous_state,
                        after_snapshot=current, after_state=state, clicked_normally=True,
                        result_fingerprint=api._row_fingerprint(current), expected_page_index=page_index)
                if (current.get("_source_loading_pending") or current.get("_wos_loading_pending") or current.get("resultsLoading")
                        or not execution_matches(state, current, page_index)
                        or not _result_scope(source, page.url)
                        or (state.get("pageNumber") is not None and state["pageNumber"] != page_index + 1)):
                    return response()
            if full_page and current.get("visible_result_count", 0) > read_limit:
                return response()
            raw_rows = current.get("results") or []
            if source == "wanfang" and raw_rows:
                raw_rows = api.extra_sources.resolve_result_links(page, source, raw_rows, read_limit)
                if any(not api.safe_url(row.get("result_url")) and not row.get("doi") for row in raw_rows):
                    return response()
            rows = api._clean_results(raw_rows, read_limit)
            if not rows and not current.get("noResults"):
                return response()
            # Save the native proof alongside the normal page/fingerprint cursor.
            api._save_binding(job_dir, source, api._target_id(context, page), hashlib.sha256(query.encode("utf-8")).hexdigest(),
                page_index=page_index, result_fingerprint=api._row_fingerprint(current),
                native_query_proof={"version": PROOF, "key": proof_key, **({"cnki_receipt": receipt} if receipt else {})})
            pagination = api._pagination(page, source)
            if source == "cnki" and pagination.get("page_number", page_index + 1) != page_index + 1:
                pagination = {**pagination, "has_next": None}
                pagination.pop("end_evidence", None)
            return response("ok" if rows or page_index else "no_results", reason=None, rows=rows,
                            pagination=({**pagination, "has_next": False} if not rows else pagination))
    except Exception:
        if page is not None:
            try:
                reason = api._auth_reason(page, api._snapshot(page, source, read_limit))
                if reason:
                    return response(reason=reason)
            except Exception:
                pass
        return response(message="高级／专业检索页面未能完成验证，已停止本次来源操作并保留断点。请检查绑定页面，或导出题录后导入。")
