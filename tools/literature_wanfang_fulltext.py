"""Enter one Wanfang paper through its official detail page and click download.

The researcher browser owns the login/institution session. This module only
navigates the already known official detail URL, verifies the article identity,
clicks a visible PDF/download control, and returns the actual browser file bytes.
It never synthesizes download endpoints, bypasses a paywall, or solves a
challenge.

The flow mirrors the CNKI adapter's boundaries at the Wanfang scale:
  * identity and page stability are read twice before one click;
  * payment/purchase controls are never candidates;
  * every click is recorded before it happens, with a hard two-click ceiling
    across process resumes;
  * a download/response is accepted only when it belongs to this task's page;
  * an interrupted click is never replayed silently: the resume path reports
    the preserved state and requires an explicit restart.
"""
from __future__ import annotations

import hashlib
import math
import re
import time
from urllib.parse import urlsplit

import literature_browser
from literature_fulltext_browser import (_SNAPSHOT_JS, _WaitBudget, _material_identity,
                                         _page_loading, _snapshot_signature)


CONTROL_LABEL = re.compile(
    r"(?:pdf\s*(?:下载|全文|全文下载)?|(?:下载|全文下载|整篇下载|下载全文)\s*pdf|"
    r"全文下载|下载全文|整篇下载|下载|download\s*pdf|pdf\s*download)", re.I)
ACCESS_TEXT = re.compile(
    r"请先登录|请登录后|登录后(?:方可|才能|即可)?下载|充值|购买|付费|机构权限|"
    r"未订购|无权下载|订阅(?:后|才能)|会员(?:可|才能)|"
    r"sign\s*in\s+to\s+download|log\s*in\s+to\s+download|purchase|subscribe", re.I)
# A price/purchase label is never a download candidate, even when it also
# contains the word "下载" (for example "购买全文" or "付费下载").
PAY_TEXT = re.compile(r"购买|付费|支付|订阅|充值|purchase|payment|buy\s*now|subscribe", re.I)
CAJ_TEXT = re.compile(r"\bcaj\b|CAJ", re.I)
DETAIL_PATHS = ("/periodical/", "/thesis/", "/conference/")
MAX_CLICKS = 2
MAX_FLOWS = 30


class _BudgetExpired(Exception):
    pass


def _norm(value):
    return " ".join(str(value or "").split())


def _official(value) -> bool:
    try:
        parsed = urlsplit(str(value or ""))
        host = (parsed.hostname or "").lower()
        return (parsed.scheme == "https" and not parsed.username and not parsed.password
                and parsed.port in (None, 443)
                and (host == "wanfangdata.com.cn" or host.endswith(".wanfangdata.com.cn")))
    except (ValueError, TypeError):
        return False


def _detail_url(record: dict) -> str:
    for value in (record.get("result_url"), record.get("source_url")):
        url = literature_browser.safe_url(value)
        if not url:
            continue
        parsed = urlsplit(url)
        if (_official(url) and parsed.hostname == "d.wanfangdata.com.cn"
                and parsed.path.startswith(DETAIL_PATHS)):
            return url
    return ""


def _label(node) -> str:
    try:
        return _norm(node.inner_text() or node.get_attribute("aria-label") or "")
    except Exception:
        return ""


def _visible(node) -> bool:
    try:
        return bool(node.is_visible())
    except Exception:
        return False


def _enabled(node) -> bool:
    try:
        return bool(node.is_enabled())
    except Exception:
        return True


def _dispose(node) -> None:
    try:
        node.dispose()
    except Exception:
        pass


def _page_identity(snapshot: dict, page, record: dict) -> dict:
    """Wanfang often omits citation meta; use its visible title/DOI text."""
    if not isinstance(snapshot, dict):
        return snapshot
    if not snapshot.get("citation_title"):
        try:
            title = re.split(r"\s*-(?:期刊|学位论文|会议论文|万方数据知识服务平台)\s*",
                             str(page.title() or "").strip(), maxsplit=1)[0]
            if title:
                snapshot["citation_title"] = title
        except Exception:
            pass
    if not snapshot.get("citation_doi"):
        try:
            text = page.inner_text("body")[:8000]
            match = re.search(r"DOI\s*[：:]\s*(10\.\d{4,9}/[^\s，,；;]+)", text, re.I)
            if match:
                snapshot["citation_doi"] = match.group(1)
        except Exception:
            pass
    return snapshot


def _choose_controls(page):
    """Choose one current visible non-payment download control.

    Returns the control handle plus why no click may happen. Payment/purchase
    labels are excluded before the PDF/generic ranking, so a paywalled detail
    page reports an access boundary instead of clicking a checkout entry.
    """
    items, pay_seen = [], False
    for node in page.query_selector_all("button,a,[role='button']"):
        label = _label(node)
        if not label or not _visible(node) or not _enabled(node):
            _dispose(node)
            continue
        if PAY_TEXT.search(label):
            pay_seen = True
            _dispose(node)
            continue
        if CONTROL_LABEL.search(label):
            items.append((node, label))
        else:
            _dispose(node)
    non_caj = [item for item in items if not CAJ_TEXT.search(item[1])]
    pdf = [item for item in non_caj if re.search(r"pdf", item[1], re.I)]
    chosen = pdf or non_caj
    caj_only = bool(items) and not chosen
    if len(chosen) != 1:
        for node, _ in items:
            _dispose(node)
        return {"control": None, "label": "", "caj_only": caj_only,
                "pay_only": pay_seen and not items, "ambiguous": len(chosen) > 1}
    control, label = chosen[0]
    for node, _ in items:
        if node is not control:
            _dispose(node)
    return {"control": control, "label": label, "caj_only": False,
            "pay_only": False, "ambiguous": False}


def _binding(fetcher):
    value = getattr(fetcher, "_binding", None)
    return value if isinstance(value, dict) else {}


def _write_binding(fetcher) -> None:
    writer = getattr(fetcher, "_write_binding", None)
    if callable(writer):
        try:
            writer()
        except Exception:
            pass


def _clock(fetcher):
    clock = getattr(fetcher, "_clock", None)
    if callable(clock):
        try:
            return float(clock())
        except Exception:
            pass
    return time.monotonic()


def _progress(fetcher, message: str) -> None:
    report = getattr(fetcher, "_progress", None)
    if callable(report):
        try:
            report(message)
        except Exception:
            pass


def _clear_pending(fetcher) -> None:
    clear = getattr(fetcher, "_clear_pending", None)
    if callable(clear):
        try:
            clear()
        except Exception:
            pass


def _target_id(fetcher, page) -> str:
    context = getattr(fetcher, "_context", None)
    if context is None or page is None:
        return ""
    try:
        value = literature_browser._target_id(context, page)
        return value if isinstance(value, str) else ""
    except Exception:
        return ""


def _tick(fetcher, page) -> None:
    waiter = getattr(fetcher, "_wait_tick", None)
    if callable(waiter):
        try:
            waiter(page)
            return
        except Exception:
            pass
    wait = getattr(page, "wait_for_timeout", None)
    if callable(wait):
        try:
            wait(200)
            return
        except Exception:
            pass
    time.sleep(0.2)


def _take_cdp(fetcher, before):
    reader = getattr(fetcher, "_take_cdp_download", None)
    if not callable(reader):
        return None
    try:
        return reader(before if isinstance(before, set) else set())
    except Exception:
        return None


def _default_discovery(url: str = "") -> dict:
    return {"status": "unknown", "reason": "article_materials_not_observed",
            "source_url": literature_browser.safe_url(url) or "", "links": []}


def _paper_hash(record: dict) -> str:
    value = "\n".join(str(record.get(key) or "") for key in
                      ("source_key", "source_candidate_id", "paper_id", "id"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _title_hash(title: str) -> str:
    return hashlib.sha256(_norm(title).encode("utf-8")).hexdigest()


def _flows(fetcher) -> dict:
    value = _binding(fetcher).get("wanfang_flows")
    return value if isinstance(value, dict) else {}


def _flow(fetcher, paper_hash: str, title_hash: str = "") -> dict:
    """Read this paper's own click trace.

    A job directory processes many papers; one shared ``wanfang_flow`` would be
    overwritten by the next paper and let an earlier paper's interrupted click
    be replayed. Traces are keyed by the paper hash instead.
    """
    value = _flows(fetcher).get(paper_hash)
    if isinstance(value, dict):
        if title_hash and value.get("title_hash") != title_hash:
            return {}
        return value
    # Bindings written before keyed traces keep one ``wanfang_flow`` mirror.
    legacy = _binding(fetcher).get("wanfang_flow")
    if (isinstance(legacy, dict) and legacy.get("paper_hash") == paper_hash
            and (not title_hash or legacy.get("title_hash") == title_hash)):
        return legacy
    return {}


def _click_targets(flow: dict):
    values = flow.get("click_target_ids")
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_CLICKS:
        return []
    if any(not isinstance(value, str) or not value or len(value) > 200 for value in values):
        return []
    if len(set(values)) != len(values):
        return []
    return list(values)


def _flow_write(fetcher, *, paper_hash, title_hash, step, click_target=None, cdp_before=None):
    """Persist the click trace before the click reaches the official page."""
    binding = _binding(fetcher)
    if not isinstance(binding, dict):
        return
    flows = binding.get("wanfang_flows")
    if not isinstance(flows, dict):
        flows = {}
    legacy = binding.get("wanfang_flow")
    if (isinstance(legacy, dict) and isinstance(legacy.get("paper_hash"), str)
            and legacy["paper_hash"] and legacy["paper_hash"] not in flows):
        # Adopt a trace written before keyed storage existed, before this new
        # paper's mirror replaces it.
        flows[legacy["paper_hash"]] = legacy
    previous = flows.get(paper_hash) if isinstance(flows.get(paper_hash), dict) else {}
    flow = {"paper_hash": paper_hash, "title_hash": title_hash,
            "target_id": binding.get("target_id"), "step": step,
            "updated_at": time.time()}
    if previous.get("title_hash") == title_hash:
        for key in ("click_target_ids", "cdp_before", "diagnostic"):
            if key in previous:
                flow[key] = previous[key]
    if click_target is not None:
        clicked = _click_targets(flow)
        if click_target in clicked or len(clicked) >= MAX_CLICKS:
            raise ValueError("Wanfang download click limit")
        flow["click_target_ids"] = [*clicked, click_target]
    if cdp_before is not None:
        flow["cdp_before"] = sorted(str(name) for name in cdp_before)[:200]
    flows[paper_hash] = flow
    if len(flows) > MAX_FLOWS:
        stale = sorted(flows.items(), key=lambda item: float(
            (item[1] or {}).get("updated_at") or 0 if isinstance(item[1], dict) else 0))
        for key, _ in stale[:len(flows) - MAX_FLOWS]:
            flows.pop(key, None)
    binding["wanfang_flows"] = flows
    # Latest mirror for diagnostics; the keyed map above is the authority.
    binding["wanfang_flow"] = flow
    _write_binding(fetcher)


def _attention(fetcher, reason: str, url: str, *, snapshot=None, message: str = "") -> dict:
    result = fetcher._attention(reason, url, snapshot=snapshot)
    if message:
        result["message"] = message
    return result


# The database's own institution picker. It is the only place a researcher
# selects *their* school; no entityID may be hardcoded here, or the adapter
# would only work for one institution.
INSTITUTION_ENTRY = "https://fsso.wanfangdata.com.cn/"
_LOGIN_MESSAGE = ("万方需要登录：已在专用浏览器新开标签打开“万方数据高校/机构外部访问系统”，"
                  "请选择你所在学校并完成统一身份认证，然后回工作台点“检查并继续”。")
_LOGIN_MESSAGE_NO_ENTRY = ("万方需要登录：请在专用浏览器打开万方页面，选择你所在学校完成统一身份认证，"
                           "然后回工作台点“检查并继续”。")
_VERIFY_MESSAGE = ("万方要求安全验证：可在原页面完成滑块；也可改用已打开的“万方数据高校/机构外部访问系统”，"
                   "选择你所在学校登录后回工作台点“检查并继续”。")
_VERIFY_MESSAGE_NO_ENTRY = ("万方要求安全验证：请在原页面完成滑块；若你属于已订购学校，"
                             "也可在万方页面选择机构登录后回工作台点“检查并继续”。")
_ACCESS_MESSAGE = ("万方提示需要机构或订阅权限：已在专用浏览器新开标签打开“万方数据高校/机构外部访问系统”，"
                   "请选择你所在学校登录；学校未订购时只能自行购买会员。完成后回工作台点“检查并继续”。")
_ACCESS_MESSAGE_NO_ENTRY = ("万方提示需要机构或订阅权限：请在专用浏览器打开万方页面，"
                            "选择你所在学校登录或自行购买会员，然后回工作台点“检查并继续”。")
# 匿名访问万方时先出现的是安全验证而不是登录表单；机构登录是绕过匿名验证的
# 正规入口。付费墙同样先给机构入口——多数情况是“学校订了但没登录”，
# 而不是真的没有权限。
_WALL_REASONS = {"login", "verification", "access_required"}
# 只有站点级访问墙才允许阻断后续文献。单篇材料页错误（page_error /
# page_not_ready）如果也写进 fetcher._blocked，下一篇会在打开网页前被直接拒绝。
_SITE_BLOCK_REASONS = {"login", "verification", "access_required", "rate_limited"}
MATERIAL_INSPECT_SECONDS = 30.0
# 详情页 60 秒还没出现本篇题名，多半是被风控页/空白页挡住了；早点报待就绪，
# 比等满默认 120 秒空闲窗口更划算（重试会复用同一页面）。
FAST_IDENTITY_SECONDS = 60.0


def _material_budget(opts) -> float:
    """Bound a supplement-only page visit; the main-PDF fetch keeps its own budget."""
    try:
        seconds = float((opts or {}).get("material_timeout_sec", MATERIAL_INSPECT_SECONDS))
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError
    except (TypeError, ValueError):
        seconds = MATERIAL_INSPECT_SECONDS
    return min(max(seconds, 5.0), 120.0)


def _open_institution_entry(fetcher) -> bool:
    """Open the institution picker once per browser session.

    The picker itself belongs to the database and lists every participating
    school, so different researchers log in as themselves. A browser without
    a context (unit tests, restricted runs) reports that nothing was opened.
    """
    if getattr(fetcher, "_wanfang_institution_entry", None):
        return True
    context = getattr(fetcher, "_context", None)
    new_page = getattr(context, "new_page", None)
    if not callable(new_page):
        return False
    entry = None
    try:
        entry = new_page()
        entry.goto(INSTITUTION_ENTRY, wait_until="domcontentloaded", timeout=30_000)
    except Exception:
        return False
    finally:
        if entry is not None:
            fetcher._wanfang_institution_entry = True
    return True


def _wall_attention(fetcher, reason: str, url: str, *, snapshot=None, detail: str = "") -> dict:
    """Pause on an access wall and leave the researcher a way to pick a school.

    Mirrors the CNKI adapter: the code recognises the wall, never a school.
    """
    result = fetcher._attention(reason, url, snapshot=snapshot)
    if str(reason) not in _WALL_REASONS:
        return result
    opened = _open_institution_entry(fetcher)
    if str(reason) == "login":
        result["message"] = _LOGIN_MESSAGE if opened else _LOGIN_MESSAGE_NO_ENTRY
    elif str(reason) == "verification":
        result["message"] = _VERIFY_MESSAGE if opened else _VERIFY_MESSAGE_NO_ENTRY
    else:
        result["message"] = _ACCESS_MESSAGE if opened else _ACCESS_MESSAGE_NO_ENTRY
    if detail:
        result["message"] = result["message"] + detail
    return result


def run_wanfang(fetcher, record: dict, opts: dict) -> dict:
    opts = opts if isinstance(opts, dict) else {}
    url = _detail_url(record)
    if not url:
        return {"status": "fetch_error", "url": "",
                "error": "万方单篇需要官方详情页地址（d.wanfangdata.com.cn/periodical|thesis|conference）。"}
    if getattr(fetcher, "_blocked", None):
        blocked = dict(fetcher._blocked)
        if str(blocked.get("reason")) in _SITE_BLOCK_REASONS:
            return blocked
        # 上一轮的单篇材料页错误不应阻断下一篇：清掉后照常打开新页面。
        fetcher._blocked = None
    title = str(record.get("title") or "").strip()
    metadata_only = opts.get("metadata_only") is True
    materials_only = opts.get("materials_only") is True
    restart = opts.get("wanfang_restart") is True
    clock = lambda: _clock(fetcher)
    paper_hash, title_hash = _paper_hash(record), _title_hash(title)
    metadata_deadline = None
    if metadata_only:
        try:
            seconds = float(opts.get("metadata_timeout_sec", 30))
            if not math.isfinite(seconds) or seconds <= 0:
                raise ValueError("Invalid metadata budget")
        except (TypeError, ValueError):
            return {"status": "attention", "reason": "page_not_ready", "url": "",
                    "message": "摘要回源预算无效，未进行页面操作。"}
        metadata_deadline = clock() + seconds
    # 补充材料只是附加产物：主 PDF 已保存时不该为它等满两分钟。
    material_budget = _material_budget(opts) if materials_only else None
    material_deadline = clock() + material_budget if material_budget else None

    def check_budget():
        now = clock()
        if metadata_deadline is not None and now >= metadata_deadline:
            raise _BudgetExpired()
        if material_deadline is not None and now >= material_deadline:
            raise _BudgetExpired()

    def operation_timeout(default_ms):
        deadlines = [value for value in (metadata_deadline, material_deadline) if value is not None]
        if not deadlines:
            return default_ms
        remaining = max(1, int((min(deadlines) - clock()) * 1000))
        return min(default_ms, remaining)

    # An interrupted click is preserved, never replayed: the previous run may
    # already have reached the publisher and a second click would download
    # twice. Only an explicit --restart-wanfang starts a new attempt.
    flow = _flow(fetcher, paper_hash, title_hash)
    same_paper = bool(flow)
    if not restart and same_paper and flow.get("step") == "download_clicked" and _click_targets(flow):
        before = set(flow["cdp_before"]) if isinstance(flow.get("cdp_before"), list) else set()
        blob = _take_cdp(fetcher, before)
        if blob is not None:
            _clear_pending(fetcher)
            return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                    "url": url, "acquisition_method": "wanfang_cdp_download",
                    "material_discovery": _default_discovery(url)}
        return _attention(fetcher, "page_not_ready", url,
                          message="万方本篇已点击过下载但尚未取得完整 PDF；为避免重复下载未再次点击，"
                                  "请在原任务页面核对，或显式使用“重新定位这篇”后重试。")

    page = fetcher._get_page()
    if page is None:
        return {"status": "fetch_error", "error": "万方单篇任务页面未能创建。", "url": url}
    try:
        fetcher._page = page
    except Exception:
        pass
    timeout_ms = max(10, min(120, int(opts.get("per_paper_timeout_sec") or 60))) * 1000
    listeners = []
    downloads, responses, popups = [], [], []
    attached_targets = {}
    clicked = False
    first_label = ""

    def source_ok(target) -> bool:
        return clicked and id(target) in attached_targets

    def attach(owner):
        if id(owner) in attached_targets:
            return
        attached_targets[id(owner)] = _target_id(fetcher, owner)

        def on_download(download):
            if source_ok(owner) and len(downloads) < 4:
                downloads.append((download, owner))

        def on_response(response):
            try:
                if (source_ok(owner) and response.request.is_navigation_request()
                        and response.request.frame == owner.main_frame
                        and "application/pdf" in str((response.headers or {}).get("content-type", "")).lower()):
                    if len(responses) < 4:
                        responses.append((response, owner))
            except Exception:
                pass

        def on_popup(child):
            try:
                if clicked and child.opener() is owner:
                    if len(popups) >= 2:
                        child.close(run_before_unload=False)
                        return
                    popups.append(child)
                    attach(child)
            except Exception:
                pass

        for event, callback in (("download", on_download), ("response", on_response), ("popup", on_popup)):
            owner.on(event, callback)
            listeners.append((owner, event, callback))

    try:
        check_budget()
        fetcher._pace(url)
        fetcher._request_url = url
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=operation_timeout(timeout_ms))
        except Exception as exc:
            if "timeout" not in str(exc).lower() and "timeout" not in type(exc).__name__.lower():
                return _attention(fetcher, "page_error", getattr(page, "url", url),
                                  message="万方详情页加载未完成；已保留页面，请核对后继续。")
            # A goto deadline can fire although usable DOM has arrived.
        fetcher._record_destination(page.url)

        budget = (_WaitBudget(clock, idle=material_budget, total=material_budget + 15)
                  if material_budget else _WaitBudget(clock))
        snapshot, last_signature, repeats = None, None, 0
        started = clock()
        while True:
            check_budget()
            try:
                snapshot = page.evaluate(_SNAPSHOT_JS)
            except Exception:
                snapshot = None
            snapshot = _page_identity(snapshot or {}, page, record)
            reason = fetcher._reason(snapshot or {})
            if reason:
                return _wall_attention(fetcher, reason, page.url, snapshot=snapshot or {})
            signature = _snapshot_signature(snapshot or {}, page.url)
            repeats = repeats + 1 if signature == last_signature else 0
            last_signature = signature
            budget.observe(signature)
            if _material_identity(snapshot or {}, record) and not _page_loading(snapshot or {}):
                # Two identical, identity-verified reads (or the site's own
                # idle window) before any click.
                if repeats >= 2 or budget.stable():
                    break
            elif budget.expired() or (
                    metadata_deadline is None and material_budget is None
                    and clock() - started >= FAST_IDENTITY_SECONDS):
                fast = not budget.expired()
                return _attention(fetcher, "page_not_ready", page.url, snapshot=snapshot or {},
                                  message=("万方详情页 60 秒内未出现本篇题名；已保留页面，请稍后重试。"
                                           if fast else "万方详情页未核对到本篇题名；已保留页面，请稍后重试。"))
            _tick(fetcher, page)

        if metadata_only:
            _clear_pending(fetcher)
            return {"status": "ok", "url": literature_browser.safe_url(page.url) or url,
                    "metadata_only": True, "material_discovery": _default_discovery(page.url)}

        discovery = _default_discovery(page.url)
        observer = getattr(fetcher, "_observe_materials", None)
        if callable(observer):
            discovery, interrupted = observer(record, snapshot, page.url, opts)
            if interrupted:
                return interrupted
        if materials_only:
            _clear_pending(fetcher)
            return {"status": "ok", "url": literature_browser.safe_url(page.url) or url,
                    "material_discovery": discovery}

        choice = _choose_controls(page)
        if choice["control"] is None:
            try:
                page_text = page.inner_text("body")[:4000]
            except Exception:
                page_text = ""
            if choice["pay_only"]:
                return _wall_attention(fetcher, "access_required", page.url, snapshot=snapshot,
                                       detail="页面只显示购买/付费入口，未自动点击支付流程。")
            if ACCESS_TEXT.search(page_text):
                return _wall_attention(fetcher, "access_required", page.url, snapshot=snapshot,
                                       detail="页面提示登录/付费/机构权限，未自动下载。")
            if choice["ambiguous"]:
                return _attention(fetcher, "page_error", page.url, snapshot=snapshot,
                                  message="万方详情有多个无法唯一核对的下载控件，已暂停；请在原页面选择目标。")
            if choice["caj_only"]:
                return _attention(fetcher, "access_required", page.url, snapshot=snapshot,
                                  message="万方当前页面只显示 CAJ/无唯一 PDF 控件，未自动下载。")
            return _attention(fetcher, "page_not_ready", page.url, snapshot=snapshot,
                              message="万方详情页未找到唯一可见的下载控件；已保留页面。")

        # Re-read identity and the control immediately before the click; a
        # redirected or re-rendered detail page must not inherit the decision.
        fetcher._pace(page.url)
        latest = _page_identity(page.evaluate(_SNAPSHOT_JS), page, record)
        latest_reason = fetcher._reason(latest or {})
        if latest_reason:
            _dispose(choice["control"])
            return fetcher._attention(latest_reason, page.url, snapshot=latest or {})
        if (not _official(page.url) or not _material_identity(latest or {}, record)
                or _page_loading(latest or {})):
            _dispose(choice["control"])
            return _attention(fetcher, "page_not_ready", page.url, snapshot=latest or {},
                              message="万方详情页在等待期间仍在加载或已变化，已暂停；未点击下载。")
        confirm = _choose_controls(page)
        _dispose(choice["control"])
        if (confirm["control"] is None or confirm["ambiguous"]
                or _norm(confirm["label"]) != _norm(choice["label"])):
            _dispose(confirm["control"])
            return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                              message="万方下载控件在等待期间发生变化，已暂停；未点击其他控件。")

        target_key = _target_id(fetcher, page) or "page-" + hashlib.sha256(
            str(page.url).encode("utf-8")).hexdigest()[:16]
        flow = _flow(fetcher, paper_hash, title_hash)
        clicked_ids = _click_targets(flow)
        if target_key in clicked_ids or len(clicked_ids) >= MAX_CLICKS:
            _dispose(confirm["control"])
            return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                              message="万方当前页面已经点击过下载或已到两次确认上限，已暂停；不会在同页重复点击下载。")

        first_label = confirm["label"]
        attach(page)
        try:
            cdp_before = fetcher._cdp_download_snapshot()
        except Exception:
            cdp_before = set()
        try:
            _flow_write(fetcher, paper_hash=paper_hash, title_hash=title_hash,
                        step="download_clicked", click_target=target_key, cdp_before=cdp_before)
        except ValueError:
            _dispose(confirm["control"])
            return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                              message="万方下载点击记录无法安全保存，已暂停；未点击下载。")
        _progress(fetcher, "全文获取：已核对万方官方详情页与唯一下载控件，正在点击官方下载并等待文件。")
        try:
            clicked = True
            confirm["control"].click(timeout=operation_timeout(15_000), no_wait_after=True)
        finally:
            _dispose(confirm["control"])

        deadline = clock() + max(10, timeout_ms / 1000)
        second_at, second_clicked = clock() + 2.0, False
        while True:
            check_budget()
            while downloads:
                download, source = downloads.pop(0)
                if not source_ok(source):
                    return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                                      message="万方文件事件与本次已核对点击无法对应，已暂停；未把未知文件当作全文。")
                file_url = str(getattr(download, "url", "") or "")
                if file_url and not (file_url.startswith("blob:") or _official(file_url)):
                    return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                                      message="万方下载事件的文件来源无法核对，已暂停；未把未知文件当作全文。")
                blob = fetcher._read_download(download)
                if blob is not None:
                    return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                            "url": literature_browser.safe_url(page.url) or url,
                            "acquisition_method": "wanfang_official_download",
                            "material_discovery": discovery}
            blob = _take_cdp(fetcher, cdp_before)
            if blob is not None:
                return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                        "url": literature_browser.safe_url(page.url) or url,
                        "acquisition_method": "wanfang_cdp_download",
                        "material_discovery": discovery}
            while responses:
                response, source = responses.pop(0)
                if not source_ok(source) or not _official(getattr(response, "url", "")):
                    return _attention(fetcher, "page_error", page.url, snapshot=latest or {},
                                      message="万方PDF响应的点击来源或官方文件来源无法核对，已暂停；未把未知文件当作全文。")
                try:
                    data = response.body()
                except Exception:
                    continue
                if isinstance(data, bytes) and data.startswith(b"%PDF"):
                    return {"status": "pdf_page", "bytes": data, "size": len(data),
                            "url": literature_browser.safe_url(page.url) or url,
                            "acquisition_method": "wanfang_pdf_response",
                            "material_discovery": discovery}
            active = popups[-1] if popups else page
            if (not second_clicked and clock() >= second_at
                    and len(clicked_ids) < MAX_CLICKS):
                # A generic "下载" control commonly opens a small format menu;
                # click one newly revealed PDF control, never the same one twice.
                second_clicked = True
                try:
                    current = active.evaluate(_SNAPSHOT_JS)
                except Exception:
                    current = latest
                current = _page_identity(current or {}, active, record)
                reason = fetcher._reason(current or {})
                if reason:
                    return _wall_attention(fetcher, reason, getattr(active, "url", page.url),
                                           snapshot=current or {})
                second = _choose_controls(active)
                if second["control"] is not None and not second["ambiguous"]:
                    label = second["label"]
                    if re.search(r"pdf", label, re.I) and _norm(label) != _norm(first_label):
                        try:
                            if not _official(getattr(active, "url", page.url)) or not _material_identity(current or {}, record):
                                _dispose(second["control"])
                                return _attention(fetcher, "page_error", getattr(active, "url", page.url),
                                                  snapshot=current or {},
                                                  message="万方下载菜单页身份或来源无法核对，已暂停；未点击其他控件。")
                            second_key = _target_id(fetcher, active) or "menu-" + hashlib.sha256(
                                str(getattr(active, "url", page.url)).encode("utf-8")).hexdigest()[:16]
                            if second_key in clicked_ids:
                                _dispose(second["control"])
                                return _attention(fetcher, "page_error", getattr(active, "url", page.url),
                                                  snapshot=current or {},
                                                  message="万方下载菜单已点击过，已暂停；不会重复点击。")
                            fetcher._pace(getattr(active, "url", page.url))
                            _flow_write(fetcher, paper_hash=paper_hash, title_hash=title_hash,
                                        step="download_clicked", click_target=second_key)
                            clicked_ids = _click_targets(_flow(fetcher, paper_hash, title_hash))
                            first_label = label
                            second["control"].click(timeout=operation_timeout(10_000), no_wait_after=True)
                        finally:
                            _dispose(second["control"])
                    else:
                        _dispose(second["control"])
                elif second["caj_only"]:
                    return _attention(fetcher, "access_required", getattr(active, "url", page.url),
                                      snapshot=current or {},
                                      message="万方下载菜单只提供 CAJ，未自动保存为 PDF。")
                else:
                    _dispose(second["control"])
            try:
                current = active.evaluate(_SNAPSHOT_JS)
            except Exception:
                current = snapshot
            reason = fetcher._reason(current or {})
            if reason:
                return _wall_attention(fetcher, reason, getattr(active, "url", page.url),
                                       snapshot=current or snapshot)
            try:
                text = active.inner_text("body")[:4000]
            except Exception:
                text = ""
            if ACCESS_TEXT.search(text):
                return _attention(fetcher, "access_required", getattr(active, "url", page.url),
                                  snapshot=current or snapshot,
                                  message="万方下载后进入登录/付费/机构权限页面，未保存为 PDF。")
            if clock() >= deadline:
                return _attention(fetcher, "page_not_ready", getattr(active, "url", page.url),
                                  snapshot=current or snapshot,
                                  message="万方下载未在时限内返回完整 PDF；已保留原页面和点击记录，稍后可显式重试。")
            _tick(fetcher, active)
    except _BudgetExpired:
        return _attention(fetcher, "page_not_ready", getattr(page, "url", url),
                          message="万方原页面仍未就绪，回源预算已到；原任务页面保留，可稍后继续核对。")
    except Exception:
        return _attention(fetcher, "page_error", getattr(page, "url", url),
                          message="万方详情页自动下载未完成；已保留页面，请核对后重试。")
    finally:
        for owner, event, callback in listeners:
            try:
                owner.remove_listener(event, callback)
            except Exception:
                pass
