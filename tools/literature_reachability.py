"""来源可达性探测：某些库（如 Google Scholar）从境内主机根本连不上，
让 worker 空跑 60 秒只会让用户干等，还把浏览器拖到 CDP 握手超时。

判据是 TCP 能否在 2.5 秒内建连 + TLS 能否握完，不做整页请求——
只要连不上，后面一定是超时，没有别的可能。

结果按进程缓存（same host, same reachability），并允许用环境变量
LITERATURE_PROXY 声明已配代理：那时不再探测，直接把问题交给浏览器。
"""
from __future__ import annotations

import os
import socket
import ssl
from urllib.parse import urlsplit

# 探测目标以注册表为准（tools/literature-sources.json 的 probeUrl），JS/Python 共用
# 同一份真相。下面这份只是注册表读不出来时的兜底，不要在这里单独维护。
FALLBACK_PROBE_HOSTS = {
    "google-scholar": "https://scholar.google.com/",
    "cnki": "https://kns.cnki.net/",
    "wanfang": "https://g.wanfangdata.com.cn/",
    "web-of-science": "https://www.webofscience.com/",
    "scopus": "https://www.scopus.com/",
    "pubmed": "https://pubmed.ncbi.nlm.nih.gov/",
}


def _probe_hosts():
    try:
        import literature_sources as registry
        return registry.probe_urls()
    except Exception:
        return dict(FALLBACK_PROBE_HOSTS)

#: 建连超时。境内访问 Google 是立刻被拒或直接黑洞，2.5 秒足够区分。
PROBE_TIMEOUT_SECONDS = 2.5

#: 探测结果文案（前端直接显示，别再让人猜"失败"是网络还是登录）。
UNREACHABLE_MESSAGE = (
    "此来源在本机所在网络不可达（{reason}）。"
    "请在能访问该站的机器上检索此来源，或取消勾选后继续。"
)

_cache = {}


def _proxy_configured():
    return bool((os.environ.get("LITERATURE_PROXY") or "").strip())


def reachable(source):
    """该来源的官方主机能否建连。

    返回 (ok, reason)。已配代理时一律返回 True —— 出口在代理那一侧，
    这里探测直连只会得出错误结论，真正的判断交给浏览器。
    """
    if _proxy_configured():
        return True, ""
    if source in _cache:
        return _cache[source]

    url = _probe_hosts().get(source)
    if not url:
        _cache[source] = (True, "")   # 未知来源不拦，交给适配器自己报错
        return _cache[source]

    parsed = urlsplit(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        with socket.create_connection((host, port), timeout=PROBE_TIMEOUT_SECONDS) as sock:
            if parsed.scheme == "https":
                context = ssl.create_default_context()
                with context.wrap_socket(sock, server_hostname=host):
                    pass
        _cache[source] = (True, "")
    except socket.timeout:
        _cache[source] = (False, "连接超时")
    except ssl.SSLError as error:
        # TLS 失败说明端口是通的（可能被中间设备阻断），仍让浏览器去试
        _cache[source] = (True, "")
    except OSError as error:
        _cache[source] = (False, getattr(error, "strerror", None) or "网络不可达")
    return _cache[source]


def unreachable_result(source):
    """不可达时立刻返回的结果：状态与超时一致（attention），但不让人等 60 秒。"""
    ok, reason = reachable(source)
    if ok:
        return None
    return {
        "status": "attention",
        "reason": "source_unreachable",
        "source_key": source,
        "results": [],
        "timed_out": False,
        "message": UNREACHABLE_MESSAGE.format(reason=reason),
    }


def reset_cache():
    """测试与"刚换了网络"时清掉探测结果。"""
    _cache.clear()
