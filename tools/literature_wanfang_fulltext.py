"""Enter one Wanfang paper through its official detail page and click download.

The researcher browser owns the login/institution session. This module only
navigates the already known official detail URL, verifies the article identity,
clicks a visible PDF/download control, and returns the actual browser file bytes.
It never synthesizes download endpoints, bypasses a paywall, or solves a
challenge.
"""
from __future__ import annotations

import re
import time
from urllib.parse import urlsplit

import literature_browser
from literature_fulltext_browser import _SNAPSHOT_JS, _material_identity


CONTROL_LABEL = re.compile(
    r"(?:pdf\s*(?:下载|全文|全文下载)?|(?:下载|全文下载|整篇下载|下载全文)\s*pdf|"
    r"全文下载|下载全文|整篇下载|下载|download\s*pdf|pdf\s*download)", re.I)
ACCESS_TEXT = re.compile(
    r"请先登录|请登录后|登录后(?:方可|才能|即可)?下载|充值|购买|付费|机构权限|"
    r"未订购|无权下载|订阅(?:后|才能)|会员(?:可|才能)|"
    r"sign\s*in\s+to\s+download|log\s*in\s+to\s+download|purchase|subscribe", re.I)
CAJ_TEXT = re.compile(r"\bcaj\b|CAJ", re.I)


def _attention(fetcher, reason: str, url: str, *, snapshot=None, message: str = "") -> dict:
    result = fetcher._attention(reason, url, snapshot=snapshot)
    if message:
        result["message"] = message
    return result


def _detail_url(record: dict) -> str:
    for value in (record.get("result_url"), record.get("source_url")):
        url = literature_browser.safe_url(value)
        if not url:
            continue
        parsed = urlsplit(url)
        if (parsed.scheme == "https" and (parsed.hostname or "").lower() == "d.wanfangdata.com.cn"
                and parsed.path.startswith(("/periodical/", "/thesis/", "/conference/"))):
            return url
    return ""


def _label(node) -> str:
    try:
        return " ".join(str(node.inner_text() or node.get_attribute("aria-label") or "").split())
    except Exception:
        return ""


def _visible(node) -> bool:
    try:
        return bool(node.is_visible())
    except Exception:
        return False


def _choose_controls(page):
    controls = []
    for node in page.query_selector_all("button,a,[role='button']"):
        label = _label(node)
        if not label or not _visible(node):
            try:
                node.dispose()
            except Exception:
                pass
            continue
        if CONTROL_LABEL.search(label):
            controls.append((node, label))
        else:
            try:
                node.dispose()
            except Exception:
                pass
    # Prefer a control that explicitly mentions PDF; then a generic download
    # control; CAJ-only is a separate unsupported format, not a PDF guess.
    non_caj = [item for item in controls if not CAJ_TEXT.search(item[1])]
    pdf = [item for item in non_caj if re.search(r"pdf", item[1], re.I)]
    chosen = pdf or non_caj
    if len(chosen) != 1:
        for node, _ in controls:
            try:
                node.dispose()
            except Exception:
                pass
        return None, bool(CAJ_TEXT.search(" ".join(label for _, label in controls)))
    return chosen[0][0], False


def run_wanfang(fetcher, record: dict, opts: dict) -> dict:
    url = _detail_url(record)
    if not url:
        return {"status": "fetch_error", "url": "",
                "error": "万方单篇需要官方详情页地址（d.wanfangdata.com.cn/periodical|thesis|conference）。"}
    if fetcher._blocked:
        return dict(fetcher._blocked)
    page = fetcher._get_page()
    timeout_ms = max(10, min(120, int((opts or {}).get("per_paper_timeout_sec") or 60))) * 1000
    listeners = []
    downloads, responses, popups = [], [], []
    clicked = False
    try:
        fetcher._pace(url)
        fetcher._request_url = url
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        fetcher._record_destination(page.url)
        snapshot = None
        for _ in range(20):
            try:
                snapshot = page.evaluate(_SNAPSHOT_JS)
            except Exception:
                snapshot = None
            if isinstance(snapshot, dict) and _material_identity(snapshot, record):
                break
            reason = fetcher._reason(snapshot or {})
            if reason:
                return fetcher._attention(reason, page.url, snapshot=snapshot or {})
            time.sleep(0.5)
        if not isinstance(snapshot, dict) or not _material_identity(snapshot, record):
            return _attention(fetcher, "page_not_ready", page.url, snapshot=snapshot or {},
                                      message="万方详情页未核对到本篇题名；已保留页面，请稍后重试。")
        reason = fetcher._reason(snapshot)
        if reason:
            return fetcher._attention(reason, page.url, snapshot=snapshot)
        fetcher._enable_cdp_downloads(page)
        cdp_before = fetcher._cdp_download_snapshot()

        def attach(owner):
            def on_download(download):
                if clicked and len(downloads) < 4:
                    downloads.append(download)
            def on_response(response):
                try:
                    if (clicked and response.request.is_navigation_request()
                            and response.request.frame == owner.main_frame
                            and "application/pdf" in str((response.headers or {}).get("content-type", "")).lower()):
                        if len(responses) < 4:
                            responses.append(response)
                except Exception:
                    pass
            def on_popup(child):
                try:
                    if clicked and child.opener() is owner:
                        child._wanfang_owned = True
                        attach(child)
                        popups.append(child)
                except Exception:
                    pass
            for event, callback in (("download", on_download), ("response", on_response), ("popup", on_popup)):
                owner.on(event, callback)
                listeners.append((owner, event, callback))

        attach(page)
        control, caj_only = _choose_controls(page)
        first_label = _label(control) if control is not None else ""
        if control is None:
            try:
                page_text = page.inner_text("body")[:4000]
            except Exception:
                page_text = ""
            if ACCESS_TEXT.search(page_text):
                return _attention(fetcher, "access_required", page.url, snapshot=snapshot,
                                  message="万方页面提示登录/付费/机构权限，未自动下载。")
            if caj_only:
                return _attention(fetcher, "access_required", page.url, snapshot=snapshot,
                                          message="万方当前页面只显示 CAJ/无唯一 PDF 控件，未自动下载。")
            return _attention(fetcher, "page_not_ready", page.url, snapshot=snapshot,
                                      message="万方详情页未找到唯一可见的下载控件；已保留页面。")
        try:
            fetcher._pace(page.url)
            clicked = True
            control.click(timeout=15_000, no_wait_after=True)
        finally:
            try:
                control.dispose()
            except Exception:
                pass

        deadline = time.monotonic() + max(10, timeout_ms / 1000)
        second_at, second_clicked = time.monotonic() + 2.0, False
        while time.monotonic() < deadline:
            if downloads:
                blob = fetcher._read_download(downloads[0])
                if blob is not None:
                    return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                            "url": literature_browser.safe_url(page.url) or url,
                            "acquisition_method": "wanfang_official_download"}
            blob = fetcher._take_cdp_download(cdp_before)
            if blob is not None:
                return {"status": "pdf_page", "bytes": blob, "size": len(blob),
                        "url": literature_browser.safe_url(page.url) or url,
                        "acquisition_method": "wanfang_cdp_download"}
            while responses:
                response = responses.pop(0)
                try:
                    data = response.body()
                except Exception:
                    continue
                if isinstance(data, bytes) and data.startswith(b"%PDF"):
                    return {"status": "pdf_page", "bytes": data, "size": len(data),
                            "url": literature_browser.safe_url(page.url) or url,
                            "acquisition_method": "wanfang_pdf_response"}
            active = popups[-1] if popups else page
            if (not downloads and not responses and not second_clicked
                    and time.monotonic() >= second_at):
                # A generic "下载" control commonly opens a small format menu;
                # click one newly revealed PDF control, never the same one twice.
                second, caj_second = _choose_controls(active)
                second_clicked = True
                if second is not None:
                    label = _label(second)
                    try:
                        if re.search(r"pdf", label, re.I) and label != first_label:
                            fetcher._pace(getattr(active, "url", page.url))
                            second.click(timeout=10_000, no_wait_after=True)
                    finally:
                        try:
                            second.dispose()
                        except Exception:
                            pass
                elif caj_second:
                    return _attention(fetcher, "access_required", getattr(active, "url", page.url),
                                      snapshot=snapshot,
                                      message="万方下载菜单只提供 CAJ，未自动保存为 PDF。")
            try:
                current = active.evaluate(_SNAPSHOT_JS)
            except Exception:
                current = snapshot
            reason = fetcher._reason(current or {})
            if reason:
                return fetcher._attention(reason, getattr(active, "url", page.url), snapshot=current or snapshot)
            try:
                text = active.inner_text("body")[:4000]
            except Exception:
                text = ""
            if ACCESS_TEXT.search(text):
                return _attention(fetcher, "access_required", getattr(active, "url", page.url),
                                          snapshot=current or snapshot,
                                          message="万方下载后进入登录/付费/机构权限页面，未保存为 PDF。")
            fetcher._wait_tick(active)
        return _attention(fetcher, "page_not_ready", getattr(popups[-1] if popups else page, "url", page.url),
                                  snapshot=snapshot,
                                  message="万方下载未在时限内返回完整 PDF；已保留原页面和点击记录。")
    except Exception:
        return _attention(fetcher, "page_error", getattr(page, "url", url),
                                  message="万方详情页自动下载未完成；已保留页面，请核对后重试。")
    finally:
        for owner, event, callback in listeners:
            try:
                owner.remove_listener(event, callback)
            except Exception:
                pass
