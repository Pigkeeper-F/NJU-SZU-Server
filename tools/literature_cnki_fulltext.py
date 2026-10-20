"""Enter one CNKI paper through the visible official search and download UI.

Only the fixed title-search entry is navigated directly.  Article and download
links are clicked in place; their transient hrefs are never replayed.  The
caller owns artifact validation/status persistence and closing a successful tab.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import quote, urlsplit

import literature_browser


ENTRY = "https://kns.cnki.net/kns8s/defaultresult/index"
ROWS = (".result-table-list tbody tr", "table.result-table-list tr", ".search-table tr")
CONTROLS = "a,button,input[type=button],input[type=submit]"
WAIT_SECONDS = 60.0
_CONTROL_LABEL_JS = "e => (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('title') || e.querySelector('img')?.alt || '').trim()"

# Returns positions in the same exact selector used by a subsequent locator.
# It does not evaluate onclick handlers, fetch hidden endpoints, or expose hrefs.
_CNKI_UI_JS = r"""/* literature_cnki_fulltext_ui */ () => {
  const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)
    && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const text = e => (e?.innerText || e?.value || '').trim();
    const queries = Array.from(document.querySelectorAll('#txt_SearchText,#txt_search,#txtSearchText,input[name="kw"],input[name="txt_SearchText"],input[name="txt_1_value1"],input.search-input,.search-input input,.search-box input[type="text"]'))
    .filter(visible).map(e=>String(e.value||'').trim()).filter(Boolean);
  let rowSelector='', rows=[];
  for (const sel of ['.result-table-list tbody tr','table.result-table-list tr','.search-table tr']) {
    const found=Array.from(document.querySelectorAll(sel));
    if(found.length) {rowSelector=sel; rows=found.map((row,index)=>({index,visible:visible(row),anchors:Array.from(row.querySelectorAll('a')).map((a,index)=>({index,visible:visible(a),text:text(a)}))})); break;}
  }
  const titles=Array.from(document.querySelectorAll('h1,.wx-tit h1,.brief h1,.title h1')).filter(visible).map(text).filter(Boolean);
  const label = e => e.getAttribute('aria-label') || text(e) || e.getAttribute('title') || e.querySelector('img')?.alt || '';
  const controls=Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).map((e,index)=>({index,text:label(e),visible:visible(e),enabled:!e.disabled&&e.getAttribute('aria-disabled')!=='true'})).filter(e=>e.visible);
  const head=(document.body?.innerText||'').slice(0,8000);
  return {queries,rowSelector,rows,titles,controls,
    generating:/正在(?:生成|准备|下载)|文件(?:生成|准备)中|下载准备中|generating (?:the )?(?:file|pdf)|preparing (?:the )?download/i.test(head)};
}"""


def _norm(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def _hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _official(url):
    parsed = urlsplit(str(url or ""))
    host = (parsed.hostname or "").lower()
    return (parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and (host == "cnki.net" or host.endswith(".cnki.net")))


def _lookup_page(url):
    parsed = urlsplit(str(url or ""))
    return parsed.scheme == "https" and parsed.hostname == "kns.cnki.net" and parsed.path.rstrip("/").lower() == "/kns8s/defaultresult/index"


def _artifact_origin(url):
    value = str(url or "")
    return _official(value[5:] if value.startswith("blob:") else value)


def _doi(value):
    value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", str(value or "").strip(), flags=re.I)
    value = re.sub(r"^doi\s*:\s*", "", value, flags=re.I)
    return value.casefold().rstrip(". ")


def _identity(snapshot, ui, record):
    expected = _norm(record.get("title"))
    titles = [_norm(snapshot.get("citation_title")), *[_norm(v) for v in ui.get("titles", [])]]
    title_ok = bool(expected and expected in titles)
    wanted_doi, actual_doi = _doi(record.get("doi")), _doi(snapshot.get("citation_doi"))
    # Conflicting DOI is stronger evidence than a copied heading.
    if wanted_doi and actual_doi and wanted_doi != actual_doi:
        return False
    return title_ok or bool(wanted_doi and actual_doi == wanted_doi)


def _exact_result(ui, title):
    queries = {_norm(v) for v in ui.get("queries", []) if str(v).strip()}
    if queries != {_norm(title)} or ui.get("rowSelector") not in ROWS:
        return []
    matches = []
    for row in ui.get("rows", []):
        if not row.get("visible"):
            continue
        for anchor in row.get("anchors", []):
            if anchor.get("visible") and _norm(anchor.get("text")) == _norm(title):
                matches.append((int(row["index"]), int(anchor["index"])))
    return matches


def _download_control(ui):
    pdf, general, caj = [], [], []
    for control in ui.get("controls", []):
        label = _norm(control.get("text"))
        if not control.get("visible") or not control.get("enabled") or re.search(r"购买|付费|支付|订阅|充值|purchase|payment|buy|subscribe", label):
            continue
        if re.fullmatch(r"(?:pdf\s*(?:下载|全文|全文下载)?|(?:下载|全文下载)\s*pdf|download\s*pdf|pdf\s*download)", label):
            pdf.append(control)
        elif re.fullmatch(r"下载|全文下载|下载全文|整篇下载|整本下载|download|download full text|full text download", label):
            general.append(control)
        elif "caj" in label and re.search(r"下载|download", label):
            caj.append(control)
    # Prefer one unambiguous PDF control; do not click both PDF and CAJ.
    chosen = pdf or general
    return (chosen[0] if len(chosen) == 1 else None), bool(caj), len(chosen) > 1


def run_cnki(fetcher, record, opts):
    """Return existing fetcher result shapes without navigating cached hrefs.

    ``cnki_flow`` contains only hashes, a target ID and a step.  An interrupted
    click is never replayed on resume; the current owned page is checked first.
    """
    from literature_fulltext_browser import _SNAPSHOT_JS

    title = str(record.get("title") or "").strip()
    if not title or len(title) > 1000:
        return {"status": "fetch_error", "error": "知网单篇定位需要完整且有效的文献题名。", "url": ""}
    if fetcher._blocked:
        return dict(fetcher._blocked)
    lookup = ENTRY + "?kw=" + quote(title, safe="") + "&korder=SU"
    fetcher._request_url = lookup
    paper_hash = _hash("\n".join(str(record.get(key) or "") for key in
                                ("source_key", "source_candidate_id", "paper_id", "id")))
    title_hash = _hash(_norm(title))
    page = None
    listeners = []
    downloads, pdf_responses, popups = [], [], []
    response_status = {}
    action = None
    popup_error = False

    def pause(reason, message=None, snapshot=None):
        result = fetcher._attention(reason, getattr(fetcher._page, "url", lookup), snapshot=snapshot)
        if message:
            result["message"] = message
            fetcher._blocked = dict(result)
        return result

    def flow_write(step):
        fetcher._binding["cnki_flow"] = {"paper_hash": paper_hash, "title_hash": title_hash,
            "target_id": fetcher._binding.get("target_id"), "step": step}
        fetcher._write_binding()

    def attach(target):
        def on_download(download):
            if action is not None:
                downloads.append(download)
        def on_response(response):
            try:
                main_navigation = response.request.is_navigation_request() and response.request.frame == target.main_frame
                if not main_navigation:
                    return
                response_status[id(target)] = int(response.status or 0)
                if action is not None and "application/pdf" in str(response.headers.get("content-type", "")).lower() and _official(response.url):
                    pdf_responses.append(response)
            except Exception:
                pass
        def on_popup(popup):
            nonlocal popup_error
            # Only a Page event emitted by the page we own qualifies.  Verify
            # opener too; context-wide pages are deliberately never enumerated.
            try:
                if action is not None and target is fetcher._page and popup.opener() is target:
                    if any(not candidate.is_closed() and candidate is not fetcher._page for _, candidate in popups):
                        # An extra popup from our single click is ours, but is
                        # not another document to process. Keep at most two
                        # transient pages and pause rather than fan out.
                        popup.close(run_before_unload=False)
                        popup_error = True
                        return
                    popups.append((target, popup))
                    attach(popup)
            except Exception:
                pass
        for event, callback in (("download", on_download), ("response", on_response), ("popup", on_popup)):
            target.on(event, callback)
            listeners.append((target, event, callback))

    def adopt_popup():
        if popup_error:
            return False
        for owner, popup in list(popups):
            try:
                if popup.opener() is not owner or popup.is_closed():
                    continue
                if not _official(popup.url):
                    if popup.url != "about:blank":
                        return False
                    continue
                if fetcher._page is popup:
                    continue
                if fetcher._page is not owner:
                    return False
                old = fetcher._page
                fetcher._page = popup
                fetcher._binding["target_id"] = literature_browser._target_id(fetcher._context, popup)
                current = fetcher._binding.get("cnki_flow", {}).get("step", "detail_pending")
                flow_write(current)
                # Persist the new ownership before closing our old locator tab.
                old.close(run_before_unload=False)
            except Exception:
                return False
        return True

    def read():
        current = fetcher._page
        snap = current.evaluate(_SNAPSHOT_JS)
        ui = current.evaluate(_CNKI_UI_JS)
        if not isinstance(snap, dict) or not isinstance(ui, dict):
            raise ValueError("Unrecognized CNKI page")
        return snap, ui

    def artifact():
        if (downloads or pdf_responses) and not _official(fetcher._page.url):
            return pause("page_error", "知网下载跳转后的页面不是可核对的官方来源，已暂停；请核对原页面。")
        if downloads or pdf_responses:
            try:
                error_snapshot = fetcher._page.evaluate(_SNAPSHOT_JS)
            except Exception:
                error_snapshot = {}
            if isinstance(error_snapshot, dict):
                error_reason = fetcher._reason(error_snapshot, response_status.get(id(fetcher._page), 0))
                if error_reason:
                    return pause(error_reason, snapshot=error_snapshot)
        for download in list(downloads):
            downloads.remove(download)
            if not _artifact_origin(getattr(download, "url", "")):
                return pause("page_error", "知网下载事件的文件来源无法核对，已暂停；未把未知文件当作全文。")
            blob = fetcher._read_download(download)
            if blob is None:
                return pause("page_error", "知网下载返回的文件未通过PDF校验（可能为CAJ或错误文件），已暂停；请在原页面核对。")
            fetcher._clear_pending()
            return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                    "url": literature_browser.safe_url(fetcher._page.url) or ENTRY}
        for response in list(pdf_responses):
            pdf_responses.remove(response)
            fetcher._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
            try:
                blob = response.body()
                from literature_fulltext_browser import MIN_PDF_BYTES, MAX_PDF_BYTES
                if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                    raise ValueError("Invalid PDF")
            except Exception:
                return pause("page_error", "知网页面响应未通过PDF内容校验，已暂停；请在原页面核对。")
            fetcher._clear_pending()
            return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                    "url": literature_browser.safe_url(fetcher._page.url) or ENTRY}
        return None

    def tick():
        # Pumps the Playwright event loop; sleeping Python alone cannot receive
        # a delayed download or a popup.  The caller's stage budget is the
        # authority once the site explicitly reports file generation.
        fetcher._page.wait_for_timeout(200)

    try:
        page = fetcher._get_page()
        target = fetcher._binding.get("target_id")
        flow = fetcher._binding.get("cnki_flow")
        resuming = (isinstance(flow, dict) and flow.get("paper_hash") == paper_hash
                    and flow.get("title_hash") == title_hash and flow.get("target_id") == target
                    and flow.get("step") in {"lookup", "detail_pending", "detail", "download_clicked"})
        step = flow["step"] if resuming else "lookup"
        action = "title" if step == "detail_pending" else "download" if step == "download_clicked" else None
        attach(page)
        start = fetcher._clock()
        if not resuming:
            flow_write("lookup")
            fetcher._pace(lookup)
            start = fetcher._clock()
            fetcher._progress("全文获取：在知网官方页面按完整题名单篇定位，核对后进入详情。")
            try:
                response = page.goto(lookup, wait_until="domcontentloaded", timeout=60_000)
                status = int(getattr(response, "status", 0) or 0)
                if status in {401, 403, 404, 429} or status >= 500:
                    snap, _ = read()
                    return pause(fetcher._reason(snap, status) or "page_error", snapshot=snap)
            except Exception as exc:
                if "timeout" not in str(exc).lower() and "timeout" not in type(exc).__name__.lower():
                    return pause("page_error")
                # A goto deadline can fire although usable DOM has arrived.
            fetcher._record_destination(page.url)
        while True:
            if not adopt_popup():
                return pause("page_error", "知网打开的页面无法确认属于本次官方单篇操作，已暂停；请核对原页面。")
            saved = artifact()
            if saved:
                return saved
            current = fetcher._page
            if not _official(current.url):
                return pause("page_error", "知网当前页面不是可核对的官方入口，已暂停；请核对原页面。")
            snap, ui = read()
            reason = fetcher._reason(snap, response_status.get(id(current), 0))
            if reason:
                return pause(reason, snapshot=snap)
            if step == "lookup":
                if _lookup_page(current.url):
                    matches = _exact_result(ui, title)
                    if len(matches) > 1:
                        return pause("page_error", "知网检索到多个完全同名结果，已暂停；请人工确认目标文献。")
                    if len(matches) == 1:
                        row_index, anchor_index = matches[0]
                        link = current.locator(ui["rowSelector"]).nth(row_index).locator("a").nth(anchor_index)
                        if not link.is_visible() or _norm(link.inner_text()) != _norm(title):
                            return pause("page_error", "知网题名结果已变化，已暂停；未点击相似文献。")
                        fetcher._pace(current.url)
                        # A dynamic table may change while waiting for the
                        # site's interval. Recheck the unique row immediately
                        # before the actual user-interface click.
                        latest_snap, latest_ui = read()
                        latest_reason = fetcher._reason(latest_snap)
                        if latest_reason:
                            return pause(latest_reason, snapshot=latest_snap)
                        if not _lookup_page(current.url) or _exact_result(latest_ui, title) != matches or not link.is_visible() or _norm(link.inner_text()) != _norm(title):
                            return pause("page_error", "知网题名结果在等待期间发生变化，已暂停；未点击相似文献。")
                        flow_write("detail_pending")
                        step = "detail_pending"
                        action = "title"
                        fetcher._progress("全文获取：已核对唯一完全同名结果，正在点击知网正常详情入口。")
                        link.click(timeout=15_000, no_wait_after=True)
                        start = fetcher._clock()
                        tick()
                        continue
                elif _identity(snap, ui, record):
                    # The researcher may finish normal navigation while paused.
                    step = "detail"
                    flow_write(step)
                    start = fetcher._clock()
                    continue
            elif step in {"detail_pending", "detail"}:
                if not _lookup_page(current.url) and _identity(snap, ui, record):
                    step = "detail"
                    if fetcher._binding.get("cnki_flow", {}).get("step") != step:
                        flow_write(step)
                    if snap.get("container_verified"):
                        evidence = {key: snap.get(key) for key in ("page_title", "citation_title", "citation_doi", "article_text", "article_html", "headings", "sections", "container", "container_verified", "origin")}
                        evidence["links"] = []
                        from literature_fulltext_evidence import assess_html
                        verdict, _ = assess_html(str(snap.get("text") or ""), current.url, evidence, title, str(record.get("doi") or ""))
                        if verdict == "fulltext":
                            fetcher._clear_pending()
                            return {"status": "ok", "url": literature_browser.safe_url(current.url) or ENTRY,
                                    "text": str(snap.get("text") or ""), "html_evidence": evidence}
                    control, caj_only, ambiguous = _download_control(ui)
                    if ambiguous:
                        return pause("page_error", "知网详情有多个无法唯一核对的下载控件，已暂停；请在原页面选择目标。")
                    if control:
                        locator = current.locator(CONTROLS).nth(int(control["index"]))
                        if not locator.is_visible() or not locator.is_enabled() or _norm(locator.evaluate(_CONTROL_LABEL_JS)) != _norm(control["text"]):
                            return pause("page_error", "知网下载控件发生变化，已暂停；未点击其他控件。")
                        fetcher._pace(current.url)
                        latest_snap, latest_ui = read()
                        latest_reason = fetcher._reason(latest_snap)
                        if latest_reason:
                            return pause(latest_reason, snapshot=latest_snap)
                        latest_control, _, _ = _download_control(latest_ui)
                        if not _official(current.url) or not _identity(latest_snap, latest_ui, record) or latest_control != control:
                            return pause("page_error", "知网详情或下载控件在等待期间发生变化，已暂停；未点击其他控件。")
                        # Record before clicking: resuming cannot duplicate a
                        # click that already reached the publisher.
                        flow_write("download_clicked")
                        step = "download_clicked"
                        action = "download"
                        fetcher._progress("全文获取：已点击当前知网详情页的下载控件，等待文件生成或真实下载；不会重复点击。")
                        locator.click(timeout=15_000, no_wait_after=True)
                        start = fetcher._clock()
                        tick()
                        continue
                    if caj_only:
                        return pause("access_required", "知网当前仅提供CAJ下载，尚未取得可核验PDF正文；请在原页面核对或补充PDF。")
            elif step == "download_clicked":
                if ui.get("generating"):
                    # No 60s navigation cutoff during an explicit generation
                    # phase. Stop/outer stage budget still controls the driver.
                    start = fetcher._clock()
            if fetcher._clock() - start >= WAIT_SECONDS:
                if step == "lookup":
                    return pause("load_timeout", "知网单篇定位超过1分钟，未能核对完整题名、检索词及唯一结果，已暂停；请在原页面核对。")
                if step == "download_clicked":
                    return pause("load_timeout", "知网下载操作尚未返回可核验文件或生成状态，已暂停；请在原页面核对，不会重复点击下载。")
                return pause("load_timeout", "知网详情超过1分钟未能核对目标文献或下载入口，已暂停；请在原页面核对。")
            tick()
    except Exception:
        if fetcher._page is not None:
            return pause("page_error", "知网正常页面操作未完成，已暂停并保留任务页；请核对后继续。")
        return {"status": "fetch_error", "error": "知网单篇任务页面未能连接。", "url": ENTRY}
    finally:
        for target, event, callback in listeners:
            try:
                target.remove_listener(event, callback)
            except Exception:
                pass
