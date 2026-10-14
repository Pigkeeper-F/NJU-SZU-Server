"""Optional headless UI smoke test; run with .venv/bin/python after setup."""
from __future__ import annotations

import os
import json
from playwright.sync_api import sync_playwright


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context()
            context.add_init_script("localStorage.setItem('wa_session', 'literature-ui-test')")
            page = context.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(os.environ.get("LITERATURE_UI_URL", "http://127.0.0.1:8123/"), wait_until="domcontentloaded")
            page.evaluate("""() => {
              Store.addModule(); Store.addModule();
              const calc = Store.addModule(); Store.setModuleMode(calc.id, 'direct');
              Store.addModule(); Store.addModule();
            }""")
            page.get_by_role("button", name="从对话整理规则").wait_for(timeout=5000)
            assert page.get_by_role("button", name="确认配置并检索").is_disabled()
            assert page.get_by_text("当前仅 Google Scholar 已接通", exact=False).count() >= 1
            config = {"topic": "中国水产养殖与气候变化", "query": "China aquaculture climate change",
                      "sources": ["google-scholar"], "publicationYearFrom": 2015, "publicationYearTo": 2023,
                      "geography": "中国", "language": "", "studyTypes": [], "inclusion": [],
                      "exclusion": [], "targetFields": ["产量"], "limit": 10}
            captured = []
            page.route("**/api/codex/session", lambda route: route.fulfill(status=201, content_type="application/json", body=json.dumps({"id": "test-session"})))
            page.route("**/api/literature/prepare", lambda route: route.fulfill(status=202, content_type="application/json", body=json.dumps({"id": "test-prepare", "status": "running"})))
            page.route("**/api/codex/job?id=test-prepare", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps({"id": "test-prepare", "status": "completed", "text": json.dumps(config, ensure_ascii=False)})))
            def on_search(route):
                captured.append(route.request.post_data_json)
                route.fulfill(status=202, content_type="application/json", body=json.dumps({"id": "test-search", "status": "completed", "config": config, "count": 0, "files": [], "events": []}))
            page.route("**/api/literature/search", on_search)
            page.evaluate("""() => { const mod = Store.getState().modules.find(m => m.type === 'literature-mining'); Store.appendMessage(mod.id, '主题：中国水产养殖与气候变化；只查 Google Scholar；论文发表年份 2015 到 2023。', 'user'); }""")
            page.get_by_role("button", name="从对话整理规则").click()
            page.get_by_label("发表年份起").wait_for(timeout=5000)
            assert page.get_by_label("发表年份起").input_value() == "2015"
            page.get_by_role("button", name="确认配置并检索").click()
            assert captured and captured[0]["config"]["publicationYearFrom"] == 2015
            assert not errors, errors
            print("LITERATURE_UI_TESTS_PASS")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
