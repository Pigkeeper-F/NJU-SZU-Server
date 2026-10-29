"""Real browser interaction with fixture HTTP responses; no model or real task."""
import functools
import http.server
import json
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
SESSION = "11111111-1111-4111-8111-111111111111"
RUN = "22222222-2222-4222-8222-222222222222"
REPLAY = "33333333-3333-4333-8333-333333333333"
FILES = [{"group": "input", "name": "aabbccdd-fixture.csv", "size": 30},
         {"group": "input", "name": "aabbccdd-fixture.xlsx", "size": 100}]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    calls, errors, state = [], [], {"run": None}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1400, "height": 1000})
            page.on("pageerror", lambda e: errors.append(str(e)))
            # Authentication is tested elsewhere; this fixture isolates cleaning.
            page.route("**/js/guard.js", lambda route: route.fulfill(body="/* fixture */", content_type="application/javascript"))

            def job():
                return {"id": state["run"], "sessionId": SESSION, "status": "completed", "stage": "completed",
                        "text": "清洗完成，固定基础核验通过，研究者验收未判定。", "events": [], "files": FILES, "error": None}

            def api(route):
                parsed = urlparse(route.request.url)
                body = route.request.post_data_json if route.request.post_data else None
                calls.append((parsed.path, body))
                if parsed.path == "/api/codex/status":
                    data = {"loggedIn": True, "model": "fixture-model", "models": [{"model": "fixture-model"}]}
                elif parsed.path == "/api/codex/session":
                    data = {"id": SESSION, "files": []}
                elif parsed.path == "/api/codex/files":
                    data = {"files": FILES}
                elif parsed.path == "/api/codex/cleaning/profile":
                    data = {"row_count": 2, "blocked": False, "tables": [{"id": "T1", "columns": ["code", "value"], "row_count": 2, "fields": [], "issues": []}],
                            "inputs": [{"name": FILES[0]["name"]}, {"name": FILES[1]["name"], "available_sheets": ["Data", "Other"]}]}
                elif parsed.path == "/api/codex/run":
                    assert body["cleanPlan"]["confirmed"] is True
                    assert body["cleanPlan"]["version"] == 1
                    assert body["cleanPlan"]["text"] == "保留原值，不得丢行。"
                    assert len(body["cleanPlan"]["inputs"]) == 2
                    assert body["cleanPlan"]["inputs"][1]["sheets"] == ["Data"]
                    state["run"] = RUN
                    data = job() | {"status": "running"}
                elif parsed.path == "/api/codex/job":
                    assert parse_qs(parsed.query)["session"] == [SESSION]
                    data = job()
                elif parsed.path == "/api/codex/cleaning/replay":
                    assert body["id"] == RUN and body["confirm"] is True
                    state["run"] = REPLAY
                    data = job() | {"status": "running"}
                elif parsed.path == "/api/codex/clean-results":
                    data = {"sessionId": SESSION, "runId": state["run"], "runs": [{"id": state["run"], "updatedAt": "2026-10-29T00:00:00Z"}] if state["run"] else [],
                            "groups": {"main": [], "reports": [], "issues": [], "auxiliary": []}, "inputs": FILES, "otherFiles": [],
                            "cleaning": {"status": "completed", "scriptSha256": "a" * 64, "rules": {"version": 1}, "verification": {"status": "passed"}} if state["run"] else None}
                else:
                    data = {}
                route.fulfill(json=data)

            page.route("**/api/**", api)
            page.goto(f"http://127.0.0.1:{server.server_port}/index.html")
            page.wait_for_function("window.Store && window.CodexUI && window.TaskManager")
            page.evaluate("TaskManager.createTask('cleaning fixture','clean')")
            page.evaluate("CodexUI.refresh(Store.getState().activeModuleId)")
            summary = page.locator("summary").filter(has_text="数据检查与处理范围")
            expect(summary).to_contain_text("2 个文件")
            summary.click()
            page.get_by_role("button", name="检查所选数据", exact=True).click()
            expect(page.locator(".codex-panel")).to_contain_text("结构检查完成")
            page.get_by_label(FILES[1]["name"] + " 选择工作表", exact=True).select_option(["Data"])
            page.evaluate("TaskManager.openPlan()")
            page.locator("#task-summary-draft").fill("保留原值，不得丢行。")
            page.locator("#task-summary-save").click()
            page.locator("#task-rules-execute").click()
            page.wait_for_function("document.querySelector('#rules-dialog').open === false")
            expect(page.locator("#module-space")).to_contain_text("清洗完成")
            # Result files remain compact in the existing attachment disclosure.
            page.locator("summary").filter(has_text="清洗结果").first.click()
            replay = page.get_by_role("button", name="按原脚本另建版本重跑", exact=True)
            expect(replay).to_be_visible()
            bundle = page.get_by_role("link", name="下载复现包", exact=True)
            expect(bundle).not_to_have_attribute("href", __import__("re").compile("inputs=1"))
            page.get_by_label("复现包包含原始输入", exact=False).check()
            expect(bundle).to_have_attribute("href", __import__("re").compile("inputs=1"))
            replay.click()
            page.wait_for_function("document.querySelector('.codex-panel').textContent.includes('固定核验')")
            assert len([c for c in calls if c[0] == "/api/codex/run"]) == 1
            assert len([c for c in calls if c[0] == "/api/codex/cleaning/replay"]) == 1
            assert not errors, errors
            browser.close()
        print("CLEANING_UI_PASS: file/sheet selection, fixed profile, rule confirmation, frozen-plan submission, persistent polling, replay and opt-in inputs")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
