"""Enter one CNKI paper through the visible official search and download UI.

Only the fixed title-search entry is navigated directly.  Article and download
links are clicked in place; their transient hrefs are never replayed.  The
caller owns artifact validation/status persistence and closing a successful tab.
"""
from __future__ import annotations

import hashlib
import copy
import re
import unicodedata
from urllib.parse import quote, urlsplit

import literature_browser


ENTRY = "https://kns.cnki.net/kns8s/defaultresult/index"
ROWS = (".result-table-list tbody tr", "table.result-table-list tr", ".search-table tr")
CONTROLS = "a,button,input[type=button],input[type=submit]"
QUERY_CONTROLS = '#txt_SearchText,#txt_search,#txtSearchText,input[name="kw"],input[name="txt_SearchText"],input[name="txt_1_value1"],input.search-input,.search-input input,.search-box input[type="text"]'
SEARCH_CONTROLS = 'button,input[type=button],input[type=submit],a[role="button"],a.search-btn,a.btn-search'
WAIT_SECONDS = 60.0
_CONTROL_LABEL_JS = r"""e => {
  const supplement=/supplement|supporting\s+(?:information|material|data|file)|additional\s+(?:file|material|data)|补充(?:材料|数据|文件|信息)|附件/i;
  const area=e.closest('section,details,[id*="supp"],[class*="supp"],[id*="attachment"],[class*="attachment"]');
  const label=[e.getAttribute('aria-label'),e.innerText,e.value,e.getAttribute('title'),e.querySelector('img')?.alt].map(v=>String(v||'').trim()).find(Boolean)||'';
  return supplement.test(label) || (area && supplement.test([area.id,area.className,area.querySelector('h2,h3,h4,h5,h6,summary')?.innerText].join(' '))) ? '' : label;
}"""
_CONTROL_READY_JS = "e => e.isConnected && !e.disabled && e.getAttribute('aria-disabled') !== 'true'"
_POPUP_MESSAGES = {
    "extra": "知网本次点击打开了多个待确认窗口，已暂停；请核对任务页面和下载窗口，避免重复下载。",
    "origin": "知网下载窗口的来源或PDF文件尚未通过官方校验，已暂停；请保留该窗口核对，不会重复点击下载。",
    "owner": "知网下载窗口与本次任务的打开关系无法核对，已暂停；请保留窗口核对。",
    "handoff_error": "知网下载窗口已出现，但任务绑定交接未完成，已暂停；请保留窗口后继续核对。",
}
_ORIGIN_LABELS = {
    "http_cnki": "HTTP知网域名，尚未进入可核验HTTPS官方页面",
    "https_cnki": "标准HTTPS知网官方页面",
    "https_other": "HTTPS其他域名，尚未进入可核验官方页面",
    "http_other": "HTTP其他域名，尚未进入可核验官方页面",
    "browser_internal": "浏览器内部页面",
    "about_variant": "about内部或空白页面，尚未取得真实文件",
    "official_blob_pending": "官方blob文件窗口，尚待真实文件校验",
    "official_unsupported": "知网域名但访问形式含不支持的凭据或端口",
    "blob_other": "未核验来源的blob页面",
    "other": "其他或无法识别的页面协议",
    "unverified_window": "尚未核对到本次任务窗口",
}

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
  const label = __CONTROL_LABEL__;
  const controls=Array.from(document.querySelectorAll('a,button,input[type=button],input[type=submit]')).map((e,index)=>({index,text:label(e),visible:visible(e),enabled:!e.disabled&&e.getAttribute('aria-disabled')!=='true'})).filter(e=>e.visible);
  const head=(document.body?.innerText||'').slice(0,8000);
  const paymentDialog=Array.from(document.querySelectorAll('[role="dialog"],.modal,.layui-layer-dialog,.pay-dialog,.purchase-dialog')).filter(visible)
    .some(e=>/购买|付费|支付|充值|订阅|purchase|payment|buy access|subscribe/i.test(text(e)));
  return {queries,rowSelector,rows,titles,controls,
    purchase_required:paymentDialog || /请购买全文|需付费|购买后(?:下载|阅读)|支付后(?:下载|阅读)|需支付|purchase (?:this article|access) to/i.test(head),
    generating:/正在(?:生成|准备|下载)|文件(?:生成|准备)中|下载准备中|generating (?:the )?(?:file|pdf)|preparing (?:the )?download/i.test(head)};
}""".replace("__CONTROL_LABEL__", _CONTROL_LABEL_JS)


def _norm(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def _hash(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _official(url):
    try:
        parsed = urlsplit(str(url or ""))
        host = (parsed.hostname or "").lower()
        return (parsed.scheme == "https" and not parsed.username and not parsed.password
                and parsed.port in (None, 443) and (host == "cnki.net" or host.endswith(".cnki.net")))
    except (ValueError, TypeError):
        return False


def _origin_summary(value):
    """Fixed categories plus protocol/hostname; never serialize a full URL.

    Credentials, port values, paths, query strings and fragments are excluded
    even for malformed/untrusted URLs. Hostnames are normalized ASCII only.
    This function is explanatory and never grants permission to a new origin.
    """
    protocol, hostname, category = "other", "", "other"
    try:
        parsed = urlsplit(str(value or ""))
        scheme = parsed.scheme.lower()
        blob = scheme == "blob"
        if blob:
            parsed = urlsplit(parsed.path)
            scheme = parsed.scheme.lower()
            protocol = "blob:" + scheme if scheme in {"http", "https"} else "blob"
        else:
            protocol = scheme if scheme in {"http", "https", "about", "chrome", "chrome-extension", "chrome-error", "edge", "edge-extension", "devtools"} else "other"
        raw_host = str(parsed.hostname or "").lower()
        try:
            host = raw_host.encode("idna").decode("ascii")
            if re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host):
                hostname = host
        except (ValueError, UnicodeError):
            pass
        cnki = bool(hostname and (hostname == "cnki.net" or hostname.endswith(".cnki.net")))
        try:
            unsupported = bool(parsed.username or parsed.password) or parsed.port not in {None, 443}
        except ValueError:
            unsupported = True
        if blob:
            category = "official_unsupported" if cnki and unsupported else "official_blob_pending" if cnki and scheme == "https" else "blob_other"
        elif scheme == "about":
            hostname, category = "", "about_variant"
        elif scheme in {"chrome", "chrome-extension", "chrome-error", "edge", "edge-extension", "devtools"}:
            hostname, category = "", "browser_internal"
        elif scheme == "https":
            category = "official_unsupported" if cnki and unsupported else "https_cnki" if cnki else "https_other"
        elif scheme == "http":
            category = "http_cnki" if cnki else "http_other"
        else:
            hostname = ""
    except (ValueError, TypeError):
        pass
    return {"protocol": protocol, "hostname": hostname, "category": category,
            "description": _ORIGIN_LABELS[category]}


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


def _query_matches(ui, title):
    values = {_norm(v) for v in ui.get("queries", []) if str(v).strip()}
    # Quotes are only an exact literal wrapper of this entire target title.
    # Missing L-/D- prefixes, substrings and extra terms remain mismatches.
    return bool(values) and values <= {_norm(title), _norm('"' + title + '"')}


def _title_matches(ui, title):
    if ui.get("rowSelector") not in ROWS:
        return []
    matches = []
    for row in ui.get("rows", []):
        if not row.get("visible"):
            continue
        for anchor in row.get("anchors", []):
            if anchor.get("visible") and _norm(anchor.get("text")) == _norm(title):
                matches.append((int(row["index"]), int(anchor["index"])))
    return matches


def _exact_result(ui, title):
    return _title_matches(ui, title) if _query_matches(ui, title) else []


def _lookup_diagnosis(url, ui, title):
    if not _lookup_page(url):
        return "page_unrecognized"
    if not any(str(value).strip() for value in ui.get("queries", [])):
        return "query_missing"
    if not _query_matches(ui, title):
        return "query_rewritten"
    if ui.get("rowSelector") not in ROWS or not any(row.get("visible") for row in ui.get("rows", [])):
        return "rows_loading"
    found = _title_matches(ui, title)
    return "ambiguous" if len(found) > 1 else "title_mismatch" if not found else "ready"


def _lookup_form(page):
    """Only actual visible editable search input + unique normal search UI."""
    editors, buttons = page.query_selector_all(QUERY_CONTROLS), page.query_selector_all(SEARCH_CONTROLS)
    selected_editor = selected_button = None
    try:
        editable = [item for item in editors if item.is_visible() and item.is_enabled() and item.is_editable()]
        if len(editable) != 1:
            return None, None, "repair_editor_unrecognized"
        selected_editor = editable[0]
        searchable = [item for item in buttons if item.is_visible() and item.is_enabled()
                      and item.evaluate(_CONTROL_READY_JS) and _norm(item.evaluate(_CONTROL_LABEL_JS)) in {"检索", "搜索", "search"}]
        if len(searchable) != 1:
            selected_editor = None
            return None, None, "repair_button_unrecognized"
        selected_button = searchable[0]
        return selected_editor, selected_button, None
    finally:
        for item in [*editors, *buttons]:
            if item is not selected_editor and item is not selected_button:
                try:
                    item.dispose()
                except Exception:
                    pass


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


def _download_element(page):
    """Choose one current visible download node without a stale DOM position.

    ElementHandles refer to the verified node itself. Inserting an advertisement
    or a navigation anchor before it cannot silently retarget the later click.
    A detached/replaced node fails closed rather than clicking its replacement.
    """
    elements = page.query_selector_all(CONTROLS)
    selected = None
    try:
        controls = []
        for index, element in enumerate(elements):
            if element.is_visible():
                controls.append({"index": index, "text": element.evaluate(_CONTROL_LABEL_JS),
                    "visible": True, "enabled": element.is_enabled() and element.evaluate(_CONTROL_READY_JS)})
        control, _, ambiguous = _download_control({"controls": controls})
        if not control or ambiguous:
            return None, None
        selected = elements[control["index"]]
        if not selected.is_visible() or not selected.is_enabled() or not selected.evaluate(_CONTROL_READY_JS) or _norm(selected.evaluate(_CONTROL_LABEL_JS)) != _norm(control["text"]):
            selected = None
            return None, None
        return selected, control
    finally:
        for element in elements:
            if element is not selected:
                try:
                    element.dispose()
                except Exception:
                    pass


def _click_targets(flow):
    names = ("download_click_target_ids", "download_click_target_id", "download_click_count")
    if not any(name in flow for name in names):
        return []
    values = flow.get("download_click_target_ids")
    if (not isinstance(values, list) or not 1 <= len(values) <= 2
        or any(not isinstance(value, str) or not value or len(value) > 200 for value in values)
        or len(set(values)) != len(values) or flow.get("download_click_target_id") != values[-1]
        or type(flow.get("download_click_count")) is not int or flow["download_click_count"] != len(values)):
        return None
    return list(values)


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
    popup_error = None
    attached = set()
    attached_targets = {}
    origin_wait_started = {}
    origin_wait_reported = set()
    material_discovery = None
    materials_observed_target = None

    def pause(reason, message=None, snapshot=None):
        result = fetcher._attention(reason, getattr(fetcher._page, "url", lookup), snapshot=snapshot)
        if message:
            result["message"] = message
            fetcher._blocked = dict(result)
        return result

    def commit_binding(updated):
        previous = fetcher._binding
        fetcher._binding = updated
        try:
            fetcher._write_binding()
        except Exception:
            fetcher._binding = previous
            raise

    def flow_write(step, *, preserve_popup=True, download_target=None, title_target=None):
        updated = copy.deepcopy(fetcher._binding)
        previous = updated.get("cnki_flow", {})
        flow = {"paper_hash": paper_hash, "title_hash": title_hash,
                "target_id": updated.get("target_id"), "step": step}
        if preserve_popup and isinstance(previous, dict) and previous.get("paper_hash") == paper_hash and previous.get("title_hash") == title_hash:
            for key in ("pending_popup", "cleanup_target_id", "diagnostic", "lookup_repair", "lookup_diagnostic", "title_click_target_id", "download_click_target_ids", "download_click_target_id", "download_click_count"):
                if key in previous:
                    flow[key] = previous[key]
        if title_target is not None:
            flow["title_click_target_id"] = title_target
        if download_target is not None:
            clicked = _click_targets(flow)
            if clicked is None or download_target in clicked or len(clicked) >= 2:
                raise ValueError("CNKI download click limit")
            clicked.append(download_target)
            flow.update(download_click_target_ids=clicked, download_click_target_id=download_target,
                        download_click_count=len(clicked))
        updated["cnki_flow"] = flow
        commit_binding(updated)

    def diagnostic(code):
        nonlocal popup_error
        popup_error = code
        try:
            updated = copy.deepcopy(fetcher._binding)
            updated.setdefault("cnki_flow", {})["diagnostic"] = code
            commit_binding(updated)
        except Exception:
            popup_error = "handoff_error"
        return False

    def popup_pause(code=None):
        code = code or popup_error or "handoff_error"
        summary = None
        if code == "origin":
            target = pending_popup_page()
            if target is not None and _official(target.url):
                # A witnessed official page can report a concrete failure.
                # Preserve that cause instead of relabeling it as an origin
                # problem; no third-party/error-page DOM is inspected here.
                try:
                    snap = target.evaluate(_SNAPSHOT_JS)
                    reason = fetcher._reason(snap, response_status.get(id(target), 0)) if isinstance(snap, dict) else None
                    if reason:
                        return pause(reason, snapshot=snap)
                except Exception:
                    pass
            summary = _origin_summary(target.url) if target is not None else {
                "protocol": "other", "hostname": "", "category": "unverified_window",
                "description": _ORIGIN_LABELS["unverified_window"]}
        diagnostic(code)
        message = _POPUP_MESSAGES[code]
        if summary is not None:
            try:
                updated = copy.deepcopy(fetcher._binding)
                updated.setdefault("cnki_flow", {})["origin_summary"] = summary
                commit_binding(updated)
            except Exception:
                return popup_pause("handoff_error")
            message += f" 当前窗口：协议 {summary['protocol']}；域名 {summary['hostname'] or '无可报告域名'}；类别 {summary['description']}。"
        result = pause("page_error", message)
        result["diagnostic"] = code
        if summary is not None:
            result["origin_summary"] = summary
        fetcher._blocked = dict(result)
        return result

    def pending_popup_page():
        witness = fetcher._binding.get("cnki_flow", {}).get("pending_popup", {})
        if not isinstance(witness, dict) or witness.get("opener_verified") is not True:
            return None
        for owner, target in list(popups):
            try:
                if target.is_closed() or literature_browser._target_id(fetcher._context, target) != witness.get("target_id"):
                    continue
                if owner is not None and not owner.is_closed() and target.opener() is not owner:
                    continue
                return target
            except Exception:
                continue
        return None

    def register_popup(owner, popup):
        """Persist this click's opener witness before any origin decision."""
        if any(candidate is popup for _, candidate in popups):
            return True
        if action is None or owner is not fetcher._page or popup.opener() is not owner:
            return diagnostic("owner")
        try:
            owner_id = literature_browser._target_id(fetcher._context, owner)
            popup_id = literature_browser._target_id(fetcher._context, popup)
            existing = fetcher._binding.get("cnki_flow", {}).get("pending_popup", {})
            if (isinstance(existing, dict) and existing.get("opener_verified") is True
                and existing.get("target_id") == popup_id and existing.get("owner_target_id") == owner_id
                and any(literature_browser._target_id(fetcher._context, child) == popup_id for _, child in popups)):
                return True
        except Exception:
            return diagnostic("handoff_error")
        if any(not candidate.is_closed() and candidate is not fetcher._page for _, candidate in popups):
            # Extra windows are created by our own observed click, but cannot
            # become an unbounded set of document tasks.
            try:
                popup.close(run_before_unload=False)
            except Exception:
                pass
            return diagnostic("extra")
        try:
            if owner_id != fetcher._binding.get("target_id") or popup_id == owner_id:
                return diagnostic("owner")
            updated = copy.deepcopy(fetcher._binding)
            flow = updated.get("cnki_flow", {})
            if flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash:
                return diagnostic("owner")
            flow["pending_popup"] = {"target_id": popup_id, "owner_target_id": owner_id,
                "opener_verified": True, "action": action, "adopted": False}
            commit_binding(updated)
            popups.append((owner, popup))
            attach(popup)
            return True
        except Exception:
            return diagnostic("handoff_error")

    def event_source(target):
        """Proof for this event, retained even if its page then closes."""
        target_id = attached_targets.get(id(target))
        flow = fetcher._binding.get("cnki_flow", {})
        if (not target_id or action not in {"title", "download"}
            or flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash):
            return None
        clicked = _click_targets(flow)
        allowed = {flow.get("title_click_target_id")} if action == "title" else set(clicked or [])
        witness = flow.get("pending_popup", {})
        if (isinstance(witness, dict) and witness.get("opener_verified") is True
            and witness.get("action") == action and witness.get("target_id") == target_id
            and witness.get("owner_target_id") in allowed):
            allowed.add(target_id)
        if target_id not in allowed:
            return None
        return {"target_id": target_id, "action": action, "paper_hash": paper_hash, "title_hash": title_hash}

    def valid_event_source(source):
        return (isinstance(source, dict) and source.get("target_id") in set(attached_targets.values())
                and source.get("action") in {"title", "download"}
                and source.get("paper_hash") == paper_hash and source.get("title_hash") == title_hash)

    def attach(target):
        if id(target) in attached:
            return
        attached.add(id(target))
        attached_targets[id(target)] = literature_browser._target_id(fetcher._context, target)
        def on_download(download):
            source = event_source(target)
            if source is not None and len(downloads) < 4:
                downloads.append((download, source))
        def on_response(response):
            try:
                main_navigation = response.request.is_navigation_request() and response.request.frame == target.main_frame
                if not main_navigation:
                    return
                response_status[id(target)] = int(response.status or 0)
                source = event_source(target)
                if source is not None and "application/pdf" in str(response.headers.get("content-type", "")).lower():
                    if len(pdf_responses) < 4:
                        pdf_responses.append((response, source))
            except Exception:
                pass
        def on_popup(popup):
            # Only a Page event emitted by the page we own qualifies.  Verify
            # opener too; context-wide pages are deliberately never enumerated.
            try:
                if action is not None and target is fetcher._page and popup.opener() is target:
                    register_popup(target, popup)
            except Exception:
                pass
        for event, callback in (("download", on_download), ("response", on_response), ("popup", on_popup)):
            target.on(event, callback)
            listeners.append((target, event, callback))

    def context_response(response):
        # Popup's first navigation response may precede its Page popup event.
        # Inspect only a current owned click's direct main-frame child. Never
        # choose a context page by title/domain or inspect unrelated responses.
        try:
            if action is None or not response.request.is_navigation_request():
                return
            frame = response.request.frame
            child = frame.page
            owner = fetcher._page
            if child is owner or frame != child.main_frame or child.opener() is not owner:
                return
            if not register_popup(owner, child):
                return
            response_status[id(child)] = int(response.status or 0)
            source = event_source(child)
            if source is not None and "application/pdf" in str(response.headers.get("content-type", "")).lower() and len(pdf_responses) < 4:
                pdf_responses.append((response, source))
        except Exception:
            # No broad response fallback: an unprovable early event remains
            # pending for the normal Page event or explicit human review.
            return

    def promote(owner, popup, *, verified_artifact=False):
        """Commit new ownership before changing memory or closing old owner."""
        try:
            if popup.is_closed():
                return True
            witness = fetcher._binding.get("cnki_flow", {}).get("pending_popup", {})
            popup_id = literature_browser._target_id(fetcher._context, popup)
            if not witness.get("opener_verified") or witness.get("target_id") != popup_id:
                return diagnostic("owner")
            if fetcher._page is popup:
                return True
            if fetcher._page is not owner or (owner is not None and not owner.is_closed() and popup.opener() is not owner):
                return diagnostic("owner")
            if not _official(popup.url):
                artifact_popup = popup.url == "about:blank" or (str(popup.url).startswith("blob:") and _artifact_origin(popup.url))
                if not (verified_artifact and artifact_popup):
                    return diagnostic("origin")
            updated = copy.deepcopy(fetcher._binding)
            updated["target_id"] = popup_id
            flow = updated["cnki_flow"]
            outstanding = flow.get("cleanup_target_id")
            if outstanding and outstanding not in {witness.get("owner_target_id"), popup_id}:
                return diagnostic("handoff_error")
            flow["target_id"] = popup_id
            flow["pending_popup"]["adopted"] = True
            flow.pop("diagnostic", None)
            flow.pop("origin_summary", None)
            if owner is not None and owner is not popup and not owner.is_closed():
                flow["cleanup_target_id"] = witness["owner_target_id"]
            commit_binding(updated)
            fetcher._page = popup
            if owner is not None and owner is not popup and not owner.is_closed():
                try:
                    owner.close(run_before_unload=False)
                    updated = copy.deepcopy(fetcher._binding)
                    updated["cnki_flow"].pop("cleanup_target_id", None)
                    commit_binding(updated)
                except Exception:
                    # Ownership is already committed. A cleanup failure is not
                    # a failure to prove who opened the popup. The driver can
                    # close this exact recorded owned target after status saves.
                    fetcher._progress("全文获取：下载窗口已绑定；旧任务页稍后在文件保存后清理。")
            return True
        except Exception:
            return diagnostic("handoff_error")

    def adopt_popup():
        if popup_error:
            return False
        waiting = False
        for owner, popup in list(popups):
            try:
                if popup.is_closed():
                    continue
                if fetcher._page is popup:
                    continue
                if owner is not None and not owner.is_closed() and popup.opener() is not owner:
                    return diagnostic("owner")
                if not _official(popup.url):
                    if popup.url != "about:blank" and not (str(popup.url).startswith("blob:") and _artifact_origin(popup.url)):
                        target_id = literature_browser._target_id(fetcher._context, popup)
                        if target_id not in origin_wait_started:
                            origin_wait_started[target_id] = fetcher._clock()
                        if target_id not in origin_wait_reported:
                            fetcher._progress("全文获取：下载窗口正在跳转，等待就绪，最多1分钟；不会重新打开或重复点击。")
                            origin_wait_reported.add(target_id)
                        if fetcher._clock() - origin_wait_started[target_id] >= WAIT_SECONDS:
                            return diagnostic("origin")
                        waiting = True
                        continue
                    # Official blob / empty attachment windows are not
                    # accepted as documents on URL alone. Await actual bytes.
                    continue
                if not promote(owner, popup):
                    return False
            except Exception:
                return diagnostic("handoff_error")
        return "waiting" if waiting else True

    def finish_artifact(blob):
        for owner, popup in list(popups):
            if not popup.is_closed() and popup is not fetcher._page:
                if not (_official(popup.url) or popup.url == "about:blank" or (str(popup.url).startswith("blob:") and _artifact_origin(popup.url))):
                    # A real official file is separate from permission to
                    # operate this side window. Keep our current binding and
                    # only schedule the exact witnessed child for cleanup
                    # after the caller saves the file and success status.
                    witness = fetcher._binding.get("cnki_flow", {}).get("pending_popup", {})
                    try:
                        child_id = literature_browser._target_id(fetcher._context, popup)
                        owner_id = attached_targets.get(id(owner))
                        if (not isinstance(witness, dict) or witness.get("opener_verified") is not True
                            or witness.get("target_id") != child_id or witness.get("owner_target_id") != owner_id
                            or fetcher._page is not owner or popup.opener() is not owner):
                            return popup_pause("owner")
                        updated = copy.deepcopy(fetcher._binding)
                        flow = updated["cnki_flow"]
                        if flow.get("cleanup_target_id") not in {None, child_id}:
                            return popup_pause("handoff_error")
                        flow["cleanup_target_id"] = child_id
                        flow.pop("diagnostic", None)
                        flow.pop("origin_summary", None)
                        commit_binding(updated)
                        fetcher._progress("全文获取：已校验官方PDF文件；旁支窗口未获自动操作许可，将在文件和成功状态保存后关闭本任务窗口。")
                    except Exception:
                        return popup_pause("handoff_error")
                    continue
                if not promote(owner, popup, verified_artifact=True):
                    return popup_pause()
        fetcher._clear_pending()
        return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                "url": literature_browser.safe_url(fetcher._page.url) or ENTRY,
                "material_discovery": material_discovery or {"status": "unknown", "reason": "article_materials_not_observed", "source_url": "", "links": []}}

    def read():
        current = fetcher._page
        snap = current.evaluate(_SNAPSHOT_JS)
        ui = current.evaluate(_CNKI_UI_JS)
        if not isinstance(snap, dict) or not isinstance(ui, dict):
            raise ValueError("Unrecognized CNKI page")
        return snap, ui

    def lookup_pause(code, *, snapshot=None):
        messages = {
            "page_unrecognized": "知网当前任务页不是可核对的题名检索结果或目标详情页，已暂停；请在原任务页面核对。",
            "query_missing": "知网单篇定位超过1分钟，但未识别到可见检索框中的完整目标题名，已暂停；请在原任务页面核对。",
            "query_rewritten": "知网显示的检索词与完整目标题名不一致，已暂停；不能删除或忽略L-等题名前缀后继续。请在原任务页面核对完整题名。",
            "rows_loading": "知网单篇结果列表超过1分钟仍未加载出可核对题录，已暂停；已有成果保留。",
            "title_mismatch": "知网结果页未出现完全匹配的完整目标题名，已暂停；未点击相似文献。",
            "ambiguous": "知网检索到多个完全同名结果，已暂停；请人工确认目标文献。",
            "repair_editor_unrecognized": "知网显示的检索词已改变，但无法唯一核对可编辑的普通检索框，已暂停；请在原任务页面按完整题名检索后继续。",
            "repair_button_unrecognized": "知网显示的检索词已改变，但未找到唯一普通检索按钮，已暂停；未点击AI检索或其他按钮。请在原任务页面按完整题名检索后继续。",
            "repair_incomplete": "上次完整题名字面检索尚未确认提交完成，已暂停；不会重复提交。请在原任务页核对，或在该任务页打开同篇详情后继续。",
            "repair_query_rewritten": "已按加引号的完整题名重新检索一次，但官网显示的词仍与完整题名不一致，已暂停；不会删除前缀或反复提交。",
        }
        updated = copy.deepcopy(fetcher._binding)
        updated.setdefault("cnki_flow", {})["lookup_diagnostic"] = code
        commit_binding(updated)
        result = pause("load_timeout" if code in {"query_missing", "rows_loading"} else "page_error", messages[code], snapshot=snapshot)
        result["lookup_diagnostic"] = code
        fetcher._blocked = dict(result)
        return result

    def repair_lookup(current, ui):
        """Submit at most one visible literal-title repair for this paper."""
        previous = fetcher._binding.get("cnki_flow", {}).get("lookup_repair")
        if previous is not None:
            return lookup_pause("repair_incomplete" if not isinstance(previous, dict) or previous.get("state") != "submitted" else "repair_query_rewritten")
        if '"' in title:
            # No invented quoting/escaping grammar for an embedded quote.
            return lookup_pause("query_rewritten")
        editor, button, problem = _lookup_form(current)
        if problem:
            return lookup_pause(problem)
        try:
            fetcher._pace(current.url)
            latest_snap, latest_ui = read()
            reason = fetcher._reason(latest_snap)
            if reason:
                return pause(reason, snapshot=latest_snap)
            if (not _lookup_page(current.url) or len(_title_matches(latest_ui, title)) != 1
                or not editor.is_visible() or not editor.is_editable() or not button.is_visible()
                or not button.is_enabled() or _norm(button.evaluate(_CONTROL_LABEL_JS)) not in {"检索", "搜索", "search"}):
                return lookup_pause("query_rewritten")
            literal = '"' + title + '"'
            updated = copy.deepcopy(fetcher._binding)
            updated["cnki_flow"]["lookup_repair"] = {"state": "prepared", "query_hash": _hash(_norm(literal)), "method": "visible-literal-title"}
            commit_binding(updated)
            editor.fill(literal, timeout=10_000)
            if _norm(editor.input_value()) != _norm(literal):
                return lookup_pause("repair_incomplete")
            fetcher._progress("全文获取：官网显示的检索词与完整题名不一致，正在原任务页以加引号的完整题名重新检索一次；保留L-等前缀。")
            button.click(timeout=15_000, no_wait_after=True)
            updated = copy.deepcopy(fetcher._binding)
            updated["cnki_flow"]["lookup_repair"]["state"] = "submitted"
            updated["cnki_flow"].pop("lookup_diagnostic", None)
            commit_binding(updated)
            return None
        except Exception:
            try:
                snap, _ = read()
                reason = fetcher._reason(snap)
                if reason:
                    return pause(reason, snapshot=snap)
            except Exception:
                pass
            return lookup_pause("repair_incomplete")
        finally:
            for item in (editor, button):
                if item is not None:
                    try:
                        item.dispose()
                    except Exception:
                        pass

    def bound_blob_witness():
        """A blob address alone is never proof of task ownership or a PDF."""
        try:
            current = fetcher._page
            if not str(current.url).startswith("blob:") or not _artifact_origin(current.url):
                return False
            flow = fetcher._binding.get("cnki_flow", {})
            witness = flow.get("pending_popup", {})
            target_id = fetcher._binding.get("target_id")
            if (flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash
                or not isinstance(witness, dict) or witness.get("opener_verified") is not True
                or witness.get("adopted") is not True or witness.get("target_id") != target_id
                or witness.get("owner_target_id") == target_id or witness.get("action") not in {"title", "download"}
                or literature_browser._target_id(fetcher._context, current) != target_id):
                return False
            opener = current.opener()
            return opener is None or literature_browser._target_id(fetcher._context, opener) == witness.get("owner_target_id")
        except Exception:
            return False

    def artifact():
        if (downloads or pdf_responses) and not (_official(fetcher._page.url) or bound_blob_witness()):
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
        for item in list(downloads):
            downloads.remove(item)
            download, source = item
            if not valid_event_source(source):
                return pause("page_error", "知网文件事件与本次已核对点击无法对应，已暂停；未把未知文件当作全文。")
            if not _artifact_origin(getattr(download, "url", "")):
                return pause("page_error", "知网下载事件的文件来源无法核对，已暂停；未把未知文件当作全文。")
            blob = fetcher._read_download(download)
            if blob is None:
                return pause("page_error", "知网下载返回的文件未通过PDF校验（可能为CAJ或错误文件），已暂停；请在原页面核对。")
            return finish_artifact(blob)
        for item in list(pdf_responses):
            pdf_responses.remove(item)
            response, source = item
            if not valid_event_source(source) or not _artifact_origin(getattr(response, "url", "")):
                return pause("page_error", "知网PDF响应的点击来源或官方文件来源无法核对，已暂停；未把未知文件当作全文。")
            fetcher._progress("全文获取：文件正在生成或下载，等待实际传输完成后再保存。")
            try:
                blob = response.body()
                from literature_fulltext_browser import MIN_PDF_BYTES, MAX_PDF_BYTES
                if not isinstance(blob, bytes) or not blob.startswith(b"%PDF") or not MIN_PDF_BYTES <= len(blob) <= MAX_PDF_BYTES:
                    raise ValueError("Invalid PDF")
            except Exception:
                return pause("page_error", "知网页面响应未通过PDF内容校验，已暂停；请在原页面核对。")
            return finish_artifact(blob)
        return None

    def find_target(context, target_id, *, strict=False):
        if not isinstance(target_id, str) or not target_id or len(target_id) > 200:
            return None
        # Only the previously witnessed exact ID is eligible. Domain/title/
        # recency of unrelated pages never influences the selection.
        unverified = False
        for candidate in context.pages:
            try:
                if candidate.is_closed():
                    continue
                if literature_browser._target_id(context, candidate) == target_id:
                    return candidate
            except Exception:
                unverified = True
                continue
        if strict and unverified:
            raise RuntimeError("Cannot verify recorded target absence")
        return None

    def guard_restart():
        if not opts.get("cnki_restart"):
            return None
        flow = fetcher._binding.get("cnki_flow", {})
        if not isinstance(flow, dict):
            return None
        pending, cleanup = flow.get("pending_popup"), flow.get("cleanup_target_id")
        if pending is None and cleanup is None:
            return None
        if flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash:
            return popup_pause("owner")
        targets = []
        if pending is not None:
            if (not isinstance(pending, dict) or pending.get("opener_verified") is not True
                or pending.get("action") not in {"title", "download"}
                or not isinstance(pending.get("target_id"), str) or not pending["target_id"]
                or len(pending["target_id"]) > 200
                or not isinstance(pending.get("owner_target_id"), str) or not pending["owner_target_id"]
                or pending["owner_target_id"] == pending["target_id"]
                or fetcher._binding.get("target_id") not in {pending["owner_target_id"], pending["target_id"]}):
                return popup_pause("owner")
            targets.append(("pending_popup", pending["target_id"]))
        if cleanup is not None:
            if not isinstance(cleanup, str) or not cleanup or len(cleanup) > 200 or cleanup == fetcher._binding.get("target_id"):
                return popup_pause("owner")
            targets.append(("cleanup_target_id", cleanup))
        try:
            context = fetcher._connect()
            for _, target_id in targets:
                if find_target(context, target_id, strict=True) is not None:
                    return pause("page_error", "已有任务下载窗口或旧任务页清理记录，请先点击“继续这篇”处理原窗口；若窗口不再需要，请手动关闭后再重新定位。不会另开或重复下载。")
            # Every recorded target was conclusively closed or absent. Only
            # those stale references are removed; no replacement is borrowed.
            updated = copy.deepcopy(fetcher._binding)
            for key, _ in targets:
                updated["cnki_flow"].pop(key, None)
            commit_binding(updated)
            return None
        except Exception:
            return popup_pause("handoff_error")

    def restore_popup():
        flow = fetcher._binding.get("cnki_flow", {})
        if opts.get("cnki_restart") or not isinstance(flow, dict) or flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash:
            return None
        witness = flow.get("pending_popup")
        if not isinstance(witness, dict):
            return None
        owner_id, popup_id = witness.get("owner_target_id"), witness.get("target_id")
        if (witness.get("opener_verified") is not True or witness.get("action") not in {"title", "download"}
            or not isinstance(owner_id, str) or not isinstance(popup_id, str) or owner_id == popup_id
            or fetcher._binding.get("target_id") not in {owner_id, popup_id}):
            return popup_pause("owner")
        context = fetcher._connect()
        owner, popup = find_target(context, owner_id), find_target(context, popup_id)
        if popup is None:
            # Do not manufacture a replacement or repeat the previous click.
            fetcher._page = owner
            return popup_pause("owner")
        if owner is not None and popup.opener() is not owner:
            fetcher._page = owner
            return popup_pause("owner")
        if owner is None and popup.opener() is not None:
            return popup_pause("owner")
        if fetcher._binding.get("target_id") == popup_id:
            if witness.get("adopted") is not True:
                return popup_pause("owner")
            fetcher._page = popup
        else:
            fetcher._page = owner
        popups.append((owner, popup))
        attach(popup)
        if fetcher._page is None:
            if _official(popup.url):
                if not promote(None, popup):
                    return popup_pause()
            else:
                # The opener witness proves this is our window, but a blob or
                # empty page without an actual file event cannot prove a PDF.
                return popup_pause("origin")
        return None

    def tick():
        # Pumps the Playwright event loop; sleeping Python alone cannot receive
        # a delayed download or a popup.  The caller's stage budget is the
        # authority once the site explicitly reports file generation.
        fetcher._page.wait_for_timeout(200)

    try:
        restart_guard = guard_restart()
        if restart_guard:
            return restart_guard
        restored = restore_popup()
        if restored:
            return restored
        page = fetcher._get_page()
        target = fetcher._binding.get("target_id")
        flow = fetcher._binding.get("cnki_flow")
        resuming = (not opts.get("cnki_restart") and isinstance(flow, dict) and flow.get("paper_hash") == paper_hash
                    and flow.get("title_hash") == title_hash and flow.get("target_id") == target
                    and flow.get("step") in {"lookup", "detail_pending", "detail", "download_clicked"})
        step = flow["step"] if resuming else "lookup"
        action = "title" if step == "detail_pending" else "download" if step == "download_clicked" else None
        attach(page)
        fetcher._context.on("response", context_response)
        listeners.append((fetcher._context, "response", context_response))
        start = fetcher._clock()
        blob_wait_reported = False
        if not resuming:
            flow_write("lookup", preserve_popup=False)
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
            # Captured official file evidence must not be lost because a side
            # window is still redirecting, blocked, or has already closed.
            saved = artifact()
            if saved:
                return saved
            adoption = adopt_popup()
            if not adoption:
                return popup_pause()
            if adoption == "waiting":
                # Independent popup deadline: parent generation text or an old
                # navigation deadline cannot reset/shorten this observed wait.
                tick()
                continue
            saved = artifact()
            if saved:
                return saved
            current = fetcher._page
            if not _official(current.url):
                if str(current.url).startswith("blob:") and _artifact_origin(current.url):
                    if bound_blob_witness() and fetcher._clock() - start < WAIT_SECONDS:
                        if not blob_wait_reported:
                            fetcher._progress("全文获取：已核对本任务的官方文件窗口，等待真实下载事件校验；不会再次点击下载。")
                            blob_wait_reported = True
                        tick()
                        continue
                    return popup_pause("origin")
                return pause("page_error", "知网当前页面不是可核对的官方入口，已暂停；请核对原页面。")
            snap, ui = read()
            reason = fetcher._reason(snap, response_status.get(id(current), 0))
            if reason:
                return pause(reason, snapshot=snap)
            if ui.get("purchase_required"):
                return pause("access_required", "知网当前页面需要购买或付费，已暂停；不会确认购买或支付。")
            if step == "download_clicked" and not ui.get("generating"):
                # Some official downloads open one more same-paper detail or
                # confirmation page. A different URL alone proves nothing:
                # only the direct witnessed new target can receive one more
                # click, with a hard two-target ceiling across process resumes.
                flow = fetcher._binding.get("cnki_flow", {})
                clicked = _click_targets(flow)
                current_id = fetcher._binding.get("target_id")
                witness = flow.get("pending_popup", {})
                if clicked and current_id not in clicked and _identity(snap, ui, record):
                    if len(clicked) >= 2:
                        return pause("page_error", "知网下载已到达两次确认上限，尚未取得可核验文件，已暂停；请在当前页面人工核对，不会循环点击。")
                    if (not isinstance(witness, dict) or witness.get("opener_verified") is not True
                        or witness.get("adopted") is not True or witness.get("target_id") != current_id
                        or witness.get("owner_target_id") != clicked[-1] or witness.get("action") != "download"):
                        return popup_pause("owner")
                    step = "detail"
            if step == "lookup":
                if _lookup_page(current.url):
                    repair = fetcher._binding.get("cnki_flow", {}).get("lookup_repair")
                    if repair is not None and (not isinstance(repair, dict) or repair.get("state") != "submitted"):
                        return lookup_pause("repair_incomplete")
                    titles_found = _title_matches(ui, title)
                    if len(titles_found) > 1:
                        return lookup_pause("ambiguous")
                    if not _query_matches(ui, title) and len(titles_found) == 1:
                        repaired = repair_lookup(current, ui)
                        if repaired:
                            return repaired
                        start = fetcher._clock()
                        tick()
                        continue
                    matches = _exact_result(ui, title)
                    if len(matches) > 1:
                        return lookup_pause("ambiguous")
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
                        if not _query_matches(latest_ui, title):
                            return lookup_pause("repair_query_rewritten" if fetcher._binding.get("cnki_flow", {}).get("lookup_repair") else "query_rewritten")
                        if not _lookup_page(current.url) or _exact_result(latest_ui, title) != matches or not link.is_visible() or _norm(link.inner_text()) != _norm(title):
                            return pause("page_error", "知网题名结果在等待期间发生变化，已暂停；未点击相似文献。")
                        flow_write("detail_pending", title_target=fetcher._binding.get("target_id"))
                        step = "detail_pending"
                        action = "title"
                        fetcher._progress("全文获取：已核对唯一完全同名结果，正在点击知网正常详情入口。")
                        link.click(timeout=15_000, no_wait_after=True)
                        start = fetcher._clock()
                        tick()
                        continue
                elif _identity(snap, ui, record):
                    # The researcher may finish normal navigation while paused.
                    # Only this exact persisted task target qualifies; an
                    # unrelated detail tab with the same title is not borrowed.
                    flow = fetcher._binding.get("cnki_flow", {})
                    if (flow.get("paper_hash") != paper_hash or flow.get("title_hash") != title_hash
                        or flow.get("target_id") != fetcher._binding.get("target_id")
                        or literature_browser._target_id(fetcher._context, current) != flow.get("target_id")):
                        return lookup_pause("page_unrecognized")
                    step = "detail"
                    flow_write(step)
                    start = fetcher._clock()
                    continue
            elif step in {"detail_pending", "detail"}:
                if not _lookup_page(current.url) and _identity(snap, ui, record):
                    step = "detail"
                    if fetcher._binding.get("cnki_flow", {}).get("step") != step:
                        flow_write(step)
                    current_target = fetcher._binding.get("target_id")
                    if materials_observed_target != current_target:
                        # Supplementary-file events belong to the collector,
                        # never to this main-PDF/title-click artifact queue.
                        main_action, action = action, None
                        try:
                            material_discovery, interrupted = fetcher._observe_materials(record, snap, current.url, opts)
                        finally:
                            action = main_action
                        materials_observed_target = current_target
                        if interrupted:
                            return interrupted
                    if opts.get("materials_only"):
                        fetcher._clear_pending()
                        return {"status": "ok", "url": literature_browser.safe_url(current.url) or ENTRY,
                                "material_discovery": material_discovery}
                    if snap.get("container_verified"):
                        evidence = {key: snap.get(key) for key in ("page_title", "citation_title", "citation_doi", "article_text", "article_html", "headings", "sections", "container", "container_verified", "origin")}
                        evidence["links"] = []
                        from literature_fulltext_evidence import assess_html
                        verdict, _ = assess_html(str(snap.get("text") or ""), current.url, evidence, title, str(record.get("doi") or ""))
                        if verdict == "fulltext":
                            fetcher._clear_pending()
                            return {"status": "ok", "url": literature_browser.safe_url(current.url) or ENTRY,
                                    "text": str(snap.get("text") or ""), "html_evidence": evidence,
                                    "material_discovery": material_discovery}
                    control, caj_only, ambiguous = _download_control(ui)
                    if ambiguous:
                        return pause("page_error", "知网详情有多个无法唯一核对的下载控件，已暂停；请在原页面选择目标。")
                    if control:
                        flow = fetcher._binding.get("cnki_flow", {})
                        clicked = _click_targets(flow)
                        current_id = fetcher._binding.get("target_id")
                        if clicked is None or current_id in clicked or len(clicked) >= 2:
                            return pause("page_error", "知网当前页面已经点击过下载或已到两次确认上限，已暂停；不会在同页重复点击下载。")
                        if flow.get("cleanup_target_id"):
                            return popup_pause("handoff_error")
                        fetcher._pace(current.url)
                        latest_snap, latest_ui = read()
                        latest_reason = fetcher._reason(latest_snap)
                        if latest_reason:
                            return pause(latest_reason, snapshot=latest_snap)
                        latest_control, _, latest_ambiguous = _download_control(latest_ui)
                        if not _official(current.url) or not _identity(latest_snap, latest_ui, record) or latest_ambiguous or not latest_control or _norm(latest_control["text"]) != _norm(control["text"]):
                            return pause("page_error", "知网详情或下载控件在等待期间发生变化，已暂停；未点击其他控件。")
                        element, current_control = _download_element(current)
                        if element is None:
                            return pause("page_error", "知网下载控件无法唯一核对，已暂停；未点击其他控件。")
                        try:
                            final_snap, final_ui = read()
                            final_reason = fetcher._reason(final_snap)
                            final_control, _, final_ambiguous = _download_control(final_ui)
                            if final_reason:
                                return pause(final_reason, snapshot=final_snap)
                            if final_ui.get("purchase_required"):
                                return pause("access_required", "知网当前页面需要购买或付费，已暂停；不会确认购买或支付。")
                            if (not _official(current.url) or not _identity(final_snap, final_ui, record)
                                or final_ambiguous or not final_control
                                or _norm(current_control["text"]) != _norm(latest_control["text"])
                                or _norm(final_control["text"]) != _norm(current_control["text"])
                                or not element.is_visible() or not element.is_enabled()
                                or not element.evaluate(_CONTROL_READY_JS)
                                or _norm(element.evaluate(_CONTROL_LABEL_JS)) != _norm(current_control["text"])):
                                return pause("page_error", "知网下载控件发生变化，已暂停；未点击其他控件。")
                            # Record before clicking: resuming cannot duplicate a
                            # click that already reached the publisher.
                            flow_write("download_clicked", download_target=current_id)
                            step = "download_clicked"
                            action = "download"
                            fetcher._progress("全文获取：已点击当前知网详情页的下载控件，等待文件生成或真实下载；不会重复点击。")
                            element.click(timeout=15_000, no_wait_after=True)
                        finally:
                            try:
                                element.dispose()
                            except Exception:
                                pass
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
                    code = _lookup_diagnosis(current.url, ui, title)
                    return lookup_pause("title_mismatch" if code == "ready" else code)
                if step == "download_clicked":
                    if any(not child.is_closed() and child is not fetcher._page for _, child in popups):
                        return popup_pause("origin")
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
