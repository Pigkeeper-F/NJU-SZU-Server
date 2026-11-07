"""Offline checks for the pre-task access pages (no browser is launched)."""
from __future__ import annotations

import sys

import literature_access as access


PASS = FAIL = 0


def ok(condition, message):
    global PASS, FAIL
    if condition:
        PASS += 1
        print("  OK   " + message)
    else:
        FAIL += 1
        print("  FAIL " + message)


def main() -> None:
    ok(access.TARGETS["institution"]["url"] == "https://fsso.wanfangdata.com.cn/",
       "机构入口指向万方高校/机构外部访问系统")
    ok(access.TARGETS["purchase"]["url"] == "https://svip.wanfangdata.com.cn/",
       "会员入口指向万方会员")
    ok(access.TARGETS["cnki"]["url"] == "https://fsso.cnki.net/",
       "知网入口指向知网高校/机构外部访问系统")
    ok(access.TARGETS["wos"]["url"].startswith("https://www.lib.szu.edu.cn/er/access/"),
       "WoS 入口指向深大图书馆校外通道（accproxy 带机构权限）")
    ok(access.TARGETS["scopus"]["url"].startswith("https://www.lib.szu.edu.cn/er/access/"),
       "Scopus 入口指向深大图书馆校外通道（/signin.uri 在新版是 404）")
    ok("ezproxy" in access.TARGETS["ezproxy"]["url"]
       and access.TARGETS["ezproxy"]["url"].endswith("/login"),
       "EZproxy 入口指向学校统一登录（可用 LITERATURE_EZPROXY 覆盖）")
    ok(access.HOME == "https://www.wanfangdata.com.cn/", "登录状态读取万方首页")

    for bad in ("", "institution2", "wos2", "https://evil.example/", "../institution", None):
        try:
            access.open_target(bad)
            ok(False, "未知目标必须拒绝：%r" % (bad,))
        except ValueError:
            ok(True, "未知目标被拒绝：%r" % (bad,))

    # 白名单只映射到固定 URL，调用方无法传入任意地址。
    ok(set(access.TARGETS) == {"institution", "purchase", "cnki", "wos", "scopus", "ezproxy"},
       "六个白名单目标（万方两键 + 五库其余入口 + EZproxy）")

    # 回归：登录后页头的“万方会员”文案会消失，识别必须按容器/机构标签，不能靠它。
    ok(".anxs-8qwe-top-rt" in access._STATUS_JS and ".anxs-8qwe-list-jg" in access._STATUS_JS,
       "登录状态按页头容器与机构标签识别，不依赖匿名态文案")

    ok(set(access.STATUS_SOURCES) == {"wanfang", "cnki", "wos", "scopus", "ezproxy"},
       "状态探测覆盖五库与 EZproxy")
    ok('input[type="password"]' in access._GENERIC_JS, "通用探测包含密码表单判定")
    ok("signOut" in access._GENERIC_JS and "preview" in access._GENERIC_JS
       and "institution" in access._GENERIC_JS and "authPage" in access._GENERIC_JS
       and "mfa" in access._GENERIC_JS and "ecp_header_unitName" in access._GENERIC_JS,
       "通用探测只返回布尔量与显示名，不返回页面正文")

    # 判定逻辑离线可测：不启动浏览器。
    cases = [
        ({"source": "wanfang", "label": "万方", "mode": "wanfang", "host": "www.wanfangdata.com.cn",
          "path": "/", "data": {"name": "深圳大学", "signedIn": True}},
         True, "已登录：深圳大学"),
        ({"source": "cnki", "label": "知网", "mode": "cnki", "host": "www.cnki.net",
          "path": "/", "data": {"password": True, "signOut": False}},
         False, "未登录"),
        ({"source": "wos", "label": "Web of Science", "mode": "wos",
          "host": "www.webofscience.com", "path": "/wos/woscc/basic-search",
          "data": {"password": False, "signOut": False}},
         True, "可访问"),
        ({"source": "scopus", "label": "Scopus", "mode": "scopus", "host": "www.scopus.com",
          "path": "/home.uri", "data": {"password": False, "signOut": False, "preview": True}},
         False, "仅预览"),
        ({"source": "ezproxy", "label": "EZproxy", "mode": "ezproxy",
          "host": "authserver.szu.edu.cn", "path": "/authserver/login",
          "data": {"password": True, "signOut": False}},
         False, "未登录"),
        ({"source": "ezproxy", "label": "EZproxy", "mode": "ezproxy",
          "host": "authserver.szu.edu.cn", "path": "/authserver/reAuth",
          "data": {"password": True, "signOut": True, "authPage": True, "mfa": True}},
         False, "多因子认证"),
        ({"source": "cnki", "label": "知网", "mode": "cnki", "host": "www.cnki.net",
          "path": "/", "data": {"password": False, "signOut": True, "institution": "深圳大学"}},
         True, "已登录"),
        ({"source": "cnki", "label": "知网", "mode": "cnki", "host": "www.cnki.net",
          "path": "/", "data": {"password": False, "signOut": False, "loginEntry": True}},
         False, "未检测到个人登录"),
        ({"source": "cnki", "label": "知网", "mode": "cnki", "host": "www.cnki.net",
          "path": "/", "data": {"password": False, "unitName": "深圳大学"}},
         True, "已登录（机构：深圳大学）"),
        ({"source": "wos", "label": "Web of Science", "mode": "wos",
          "host": "www-webofscience-com.accproxy.lib.szu.edu.cn",
          "path": "/wos/woscc/basic-search", "data": {"password": False, "signOut": False}},
         True, "深大代理"),
        ({"source": "scopus", "label": "Scopus", "mode": "scopus",
          "host": "www-scopus-com.accproxy.lib.szu.edu.cn", "path": "/pages/home",
          "data": {"password": False, "preview": False}},
         True, "深大代理"),
        ({"source": "wos", "label": "Web of Science", "mode": "wos",
          "host": "login.ezproxy.lib.szu.edu.cn", "path": "/login",
          "data": {"password": False, "signOut": False}},
         False, "需要完成 EZproxy 登录"),
    ]
    for entry, expected, text in cases:
        signed, _name, message = access._message(entry)
        ok(signed is expected and text in message,
           "%s 判定：%s" % (entry["label"], message))

    try:
        access.read_status("cnki2")
        ok(False, "未知状态来源必须拒绝")
    except ValueError:
        ok(True, "未知状态来源被拒绝")

    print("\n结果：%d 通过 / %d 失败" % (PASS, FAIL))
    if FAIL:
        print("LITERATURE_ACCESS_TESTS_FAIL")
        raise SystemExit(1)
    print("LITERATURE_ACCESS_TESTS_PASS")


if __name__ == "__main__":
    sys.exit(main())
