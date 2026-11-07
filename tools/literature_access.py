"""Open the database's own access pages in the researcher browser.

Used before a task starts, so a researcher can sign in with their school or
buy a personal membership once and reuse that session for later tasks.  This
module never reads credentials, never fills a login form and never pays: it
only opens the official page and reports what the page header shows.

2026-11-06: extended from Wanfang-only to the five-source set plus the campus
EZproxy entry.  Every target is a fixed official URL; callers cannot pass an
arbitrary address.  Status probes only return booleans, a display name and the
final host - never page text, cookies or tokens.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import literature_browser


# A campus EZproxy host is school-specific.  The default is Shenzhen
# University (recorded as verified on 2026-11-04); override it for any other
# institution without touching code.
EZPROXY_URL = os.environ.get("LITERATURE_EZPROXY", "http://ezproxy.lib.szu.edu.cn/login")

# SZU's library hands out per-database "off-campus channel" links; they redirect
# through accproxy.lib.szu.edu.cn and carry the institution entitlement.  These
# are the verified one-click routes for WoS/Scopus (2026-11-06), unlike
# Clarivate's personal login page which has no institution entry.
WOS_ENTRY = os.environ.get("LITERATURE_WOS_ENTRY", "https://www.lib.szu.edu.cn/er/access/18818")
SCOPUS_ENTRY = os.environ.get("LITERATURE_SCOPUS_ENTRY", "https://www.lib.szu.edu.cn/er/access/18457")
WOS_PROBE = os.environ.get(
    "LITERATURE_WOS_PROBE", "https://www-webofscience-com.accproxy.lib.szu.edu.cn/wos/woscc/basic-search")
SCOPUS_PROBE = os.environ.get(
    "LITERATURE_SCOPUS_PROBE", "https://www-scopus-com.accproxy.lib.szu.edu.cn/pages/home")

TARGETS = {
    "institution": {
        "url": "https://fsso.wanfangdata.com.cn/",
        "label": "万方数据高校/机构外部访问系统",
    },
    "purchase": {
        "url": "https://svip.wanfangdata.com.cn/",
        "label": "万方会员",
    },
    "cnki": {
        "url": "https://fsso.cnki.net/",
        "label": "知网高校/机构外部访问系统",
    },
    "wos": {
        "url": WOS_ENTRY,
        "label": "Web of Science（深大校外通道）",
    },
    "scopus": {
        # 直连 scopus.com/signin.uri 在新版是 404；深大图书馆的校外通道
        # 会经 accproxy 直接带机构权限，比 Elsevier 个人登录页更可靠。
        "url": SCOPUS_ENTRY,
        "label": "Scopus（深大校外通道）",
    },
    "ezproxy": {
        "url": EZPROXY_URL,
        "label": "学校 EZproxy 统一登录",
    },
}
HOME = "https://www.wanfangdata.com.cn/"

# One probe URL per source.  WoS/Scopus send an anonymous visitor through their
# own sign-in door, so the final host tells us whether the session already
# carries access; CNKI/EZproxy are judged by the login form and sign-out entry.
PROBES = {
    "wanfang": {"url": HOME, "mode": "wanfang", "label": "万方"},
    "cnki": {"url": "https://www.cnki.net/", "mode": "cnki", "label": "知网"},
    "wos": {"url": WOS_PROBE, "mode": "wos", "label": "Web of Science"},
    "scopus": {"url": SCOPUS_PROBE, "mode": "scopus", "label": "Scopus"},
    "ezproxy": {"url": EZPROXY_URL, "mode": "ezproxy", "label": "EZproxy"},
}
STATUS_SOURCES = tuple(PROBES)

# The header login block shows 万方会员 / 登录 / 注册 when anonymous. Once signed
# in, 万方会员 disappears and the institution/locale chip (anxs-8qwe-list-jg)
# carries the school or account name, so the block must be located by container
# rather than by that label.
_STATUS_JS = r"""() => {
  const text = e => (e && (e.innerText || e.textContent) || '').trim();
  const clean = v => !/登录|注册|退出|简\s*繁|万方会员|切换个人版/.test(v);
  const top = document.querySelector('.anxs-8qwe-top-rt') || document.querySelector('.wf-header');
  const names = [];
  const chip = document.querySelector('.anxs-8qwe-list-jg');
  if (chip && text(chip) && clean(text(chip))) names.push(text(chip));
  if (top) {
    for (const e of top.querySelectorAll('b')) {
      const value = text(e);
      if (value && clean(value) && !names.includes(value)) names.push(value);
    }
  }
  const body = top ? text(top) : '';
  return { name: names[0] || '', signedIn: names.length > 0 || /退出/.test(body),
           header: body.slice(0, 120) };
}"""

# Generic probe: report booleans only.  The institution name is display text,
# never an account or token.  A visible password field is treated as the
# strongest "not signed in" signal.  The institution label must carry a colon:
# CNKI's anonymous header contains the words "机构登录 个人登录" without one, and
# a bare keyword match would otherwise turn page prose into a fake school name.
_GENERIC_JS = r"""() => {
  const text = (document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 6000);
  const visible = e => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const password = Array.from(document.querySelectorAll('input[type="password"]')).some(visible);
  const signOut = /退出登录|退出|Sign\s*out|Log\s*out/i.test(text);
  const preview = /Scopus\s*Preview|Preview\s*mode|仅预览/i.test(text);
  const authPage = /统一身份认证|多因子|二次认证|reAuth/i.test(text);
  const mfa = /多因子|二次认证|验证码/.test(text) && authPage;
  const loginEntry = /机构登录|个人登录/.test(text);
  const institution = (text.match(/(?:机构|单位|Institution)\s*[：:]\s*([^\n|，,、；;]{2,28})/i) || [])[1] || '';
  // CNKI hides the institution chip behind .ecp_header_unitName; the page text
  // only shows "深圳大学 个人登录", so a colon-based regex never matches it.
  const unit = document.querySelector('.ecp_header_unitName, .ecp_unitAccountName');
  const unitName = unit ? (unit.innerText || unit.textContent || '').trim().slice(0, 28) : '';
  return { password, signOut, preview, authPage, mfa, loginEntry, institution, unitName,
           host: location.host, path: location.pathname };
}"""


def open_target(target: str) -> dict:
    """Open one whitelisted access page; unknown targets never reach the browser."""
    entry = TARGETS.get(str(target or ""))
    if not entry:
        raise ValueError("只能打开白名单内的登录或购买页面。")
    with literature_browser._runtime() as context:
        page = context.new_page()
        page.goto(entry["url"], wait_until="domcontentloaded", timeout=60_000)
    return {"opened": True, "target": target, "url": entry["url"], "label": entry["label"],
            "message": "已打开官方页面；登录或购买请在本页完成，平台不代填账号、不代付款。"}


def _probe(source: str) -> dict:
    """Read one source's session state in a fresh tab; never returns page text."""
    entry = PROBES[source]
    with literature_browser._runtime() as context:
        page = context.new_page()
        try:
            try:
                page.goto(entry["url"], wait_until="domcontentloaded", timeout=35_000)
            except Exception as error:
                # Heavy SPA/proxy pages can commit without a timely
                # DOMContentLoaded; read the rendered header instead of
                # failing the whole probe. Real network errors still raise.
                name = type(error).__name__
                if "Timeout" not in name:
                    raise
            page.wait_for_timeout(3_000)
            data = page.evaluate(_STATUS_JS if entry["mode"] == "wanfang" else _GENERIC_JS) or {}
            final_host = str(page.url or "").split("/")[2] if "//" in str(page.url or "") else ""
        finally:
            try:
                page.close()
            except Exception:
                pass
    return {"source": source, "label": entry["label"], "mode": entry["mode"],
            "host": str(data.get("host") or final_host), "data": data,
            "path": str(data.get("path") or "")}


def _message(entry: dict) -> tuple[bool, str, str]:
    """Turn a probe into (signedIn, display name, human message)."""
    data = entry["data"]
    mode = entry["mode"]
    host = entry["host"].lower()
    path = entry["path"]
    if mode == "wanfang":
        name = str(data.get("name") or "").strip()
        signed = bool(data.get("signedIn"))
        return signed, name, (f"已登录：{name}" if name else ("已登录" if signed else "未登录或页面要求验证"))
    name = str(data.get("institution") or "").strip()
    password = bool(data.get("password"))
    sign_out = bool(data.get("signOut"))
    if mode == "ezproxy":
        if "ezproxy" in host and not password:
            return True, name, "已登录（已进入 EZproxy）"
        if data.get("mfa"):
            return False, name, "需要完成统一身份认证/多因子认证"
        if data.get("authPage") or "authserver" in host:
            return False, name, "未登录（已跳到学校统一身份认证）"
        return False, name, "未判定"
    if password:
        return False, name, "未登录（检测到登录表单）"
    if sign_out:
        return True, name, (f"已登录（{name}）" if name else "已登录")
    if mode != "ezproxy" and "ezproxy" in host:
        return False, name, "需要完成 EZproxy 登录（深大统一身份认证）"
    if mode == "wos" and ("accproxy" in host or "webofscience" in host):
        return True, name, ("可访问（深大代理）" if "accproxy" in host
                            else "可访问（未检测到个人登录，可能是 IP/机构授权）")
    if mode == "scopus":
        if data.get("preview"):
            return False, name, "仅预览（未获得机构/个人访问权限）"
        if "accproxy" in host:
            return True, name, "可访问（深大代理）"
        if "signin" not in path:
            return True, name, (f"可访问（{name}）" if name else "可访问（未检测到个人登录，可能是 IP/机构授权）")
        return False, name, "未登录"
    if mode == "cnki":
        unit = str(data.get("unitName") or "").strip()
        if unit:
            return True, unit, f"已登录（机构：{unit}）"
        if name:
            return True, name, f"已登录（机构：{name}）"
        if data.get("loginEntry"):
            return False, "", "未检测到个人登录（页面显示机构/个人登录入口；IP 授权可能仍生效）"
    return False, name, "未判定（未检测到登录或退出入口）"


def read_status(source: str = "wanfang") -> dict:
    """Read one source, or every source when source == 'all'."""
    source = str(source or "wanfang")
    if source == "all":
        results, failures = [], []
        for key in STATUS_SOURCES:
            try:
                results.append(_status_isolated(key))
            except Exception as error:  # One slow site must not hide the others.
                failures.append({"source": key, "label": PROBES[key]["label"],
                                 "message": f"读取失败：{error}"})
        merged = results + failures
        return {"checked": bool(results), "source": "all", "results": merged,
                "message": "；".join(f"{item['label']}：{item['message']}" for item in merged)}
    if source not in PROBES:
        raise ValueError("只能读取白名单内的登录状态。")
    return _status_one(source)


def _status_isolated(source: str) -> dict:
    """Probe one source in a child process so a wedged page cannot hang the caller."""
    import subprocess
    command = [sys.executable, "-u", os.path.abspath(__file__), "--status", source]
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise TimeoutError("状态读取超时（60 秒）")
    lines = [line for line in (done.stdout or "").strip().splitlines() if line.strip()]
    if not lines:
        detail = (done.stderr or "").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "状态读取未返回结果")
    try:
        result = json.loads(lines[-1])
    except ValueError:
        raise RuntimeError("状态读取未返回有效结果")
    if result.get("checked") is not True:
        raise RuntimeError(result.get("message") or "状态读取未返回结果")
    return result


def _status_one(source: str) -> dict:
    entry = _probe(source)
    signed, name, message = _message(entry)
    return {"source": source, "label": entry["label"], "checked": True,
            "signedIn": signed, "name": name, "host": entry["host"], "message": message}


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--open", choices=tuple(TARGETS))
    group.add_argument("--status", nargs="?", const="wanfang",
                       choices=("all",) + STATUS_SOURCES, metavar="SOURCE")
    args = parser.parse_args()
    try:
        result = read_status(args.status) if args.status else open_target(args.open)
    except Exception as error:  # Keep the CLI contract: one JSON line or one error line.
        print(json.dumps({"opened": False, "checked": False, "message": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
