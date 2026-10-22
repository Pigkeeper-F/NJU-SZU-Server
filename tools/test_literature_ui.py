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
              Store.addModule('下载数据'); Store.addModule('数据清洗');
              const lit = Store.addModule('文献挖掘');
              const calc = Store.addModule('模型调整与计算'); Store.setModuleMode(calc.id, 'direct');
              Store.selectModule(lit.id);
            }""")
            page.get_by_role("button", name="从对话整理规则").wait_for(timeout=5000)
            assert page.get_by_role("button", name="确认配置并检索").is_disabled()
            assert page.get_by_text("文献任务", exact=False).count() >= 1
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
            page.wait_for_timeout(800)  # startLiterature 先核对后台运行时，再发检索请求
            assert captured and captured[0]["config"]["publicationYearFrom"] == 2015

            # 【第二阶段】字段确认关口：任务停在 needs_attention + awaiting_confirmation
            page.route("**/api/literature/job?id=test-search", lambda route: route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"id": "test-search", "status": "completed", "stage": "completed", "message": "已保存 0 条候选", "count": 0, "config": config, "files": [], "events": []})))
            gate_job = {"id": "test-gate", "status": "needs_attention", "stage": "awaiting_confirmation",
                        "message": "提取前需由研究者确认主题参数字段含义与单位；确认后点击继续。",
                        "count": 3,
                        "config": {**config, "fieldDefinitions": [
                            {"key": "soc", "label": "SOC", "meaning": "土壤有机碳", "unit": "g/kg", "valueType": "number", "required": True}]},
                        "files": ["run_config.json", "candidates.json", "dedupe/dedupe.json", "fulltext/status.json"],
                        "stages": {"discover": "done", "dedupe": "done", "fulltext": "done", "extract": "pending", "validate": "pending", "export": "pending"},
                        "resumeStage": "extract", "until": "export", "counters": {"candidates": 3, "uniqueGroups": 2}, "events": []}
            page.route("**/api/literature/search", lambda route: route.fulfill(status=202, content_type="application/json", body=json.dumps(gate_job)))
            page.route("**/api/literature/job?id=test-gate", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(gate_job)))
            advance = []

            def on_advance(route):
                advance.append(route.request.post_data_json)
                route.fulfill(status=200, content_type="application/json", body=json.dumps(gate_job))

            page.route("**/api/literature/advance", on_advance)
            page.get_by_role("button", name="确认配置并检索").click()
            page.get_by_role("button", name="设置提取字段").click()
            page.get_by_role("button", name="核对表格并开始提取").first.wait_for(timeout=5000)
            assert page.get_by_text("下一阶段：提取参数", exact=False).count() >= 1, "阶段条应显示 resumeStage"
            assert page.get_by_text("去重结果 JSON", exact=False).count() >= 1, "下载区应按 job 快照渲染产物"
            assert page.get_by_label("表头名称").first.input_value() == "SOC", "确认表单应预填字段表头"
            assert page.get_by_label("单位").first.input_value() == "g/kg", "确认表单应预填字段单位"
            page.get_by_role("button", name="核对表格并开始提取").first.click()
            page.wait_for_timeout(400)
            assert advance and advance[0]["id"] == "test-gate", "确认后应调用 advance"
            assert advance[0]["confirmations"]["fields"][0]["key"] == "soc", "确认记录应包含字段定义"
            assert advance[0]["confirmations"]["fields"][0]["unit"] == "g/kg", "确认记录应包含单位"
            assert not errors, errors
            print("LITERATURE_UI_TESTS_PASS")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
