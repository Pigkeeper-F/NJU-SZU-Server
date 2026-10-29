"""Isolated browser regression for sidebar navigation; no real account or model."""
import functools
import http.server
import json
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright, expect
from test_cleaning_ui import ROOT, Quiet


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}/index.html"
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1400, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("dialog", lambda dialog: dialog.accept())
            page.route("**/js/guard.js", lambda route: route.fulfill(body="/* fixture */", content_type="application/javascript"))
            page.route("**/api/**", lambda route: route.fulfill(json={"loggedIn": False, "models": [], "files": [], "runs": []}))
            page.goto(base)
            page.wait_for_function("window.TaskManager && window.WorkspaceUI")
            tabs = page.locator("#module-tabs > .module-tab")
            expect(tabs).to_have_count(7)
            expect(page.locator(".work-area .task-bar")).to_have_count(0)
            expect(page.locator("#sidebar .task-bar")).to_have_count(1)
            expect(page.locator('[data-view="records"]')).to_have_count(0)
            expect(page.locator(".sidebar-flow-btn")).to_have_count(0)
            expect(page.locator('#task-start option[value="research"]')).to_have_count(0)
            task_summary = page.locator("#sidebar-task-section > summary")
            task_summary.click()

            def create(name):
                page.locator("#task-new").click()
                page.locator("#task-name").fill(name)
                page.locator("#task-start").select_option("clean")
                page.locator("#task-form button[type=submit]").click()
                expect(page.locator("#rules-dialog")).to_be_visible()
                page.locator("#rules-dialog-close").click()

            create("侧栏测试一")
            first = page.locator("#task-select").input_value()
            page.locator("#conversation-mode").select_option("notes")
            page.locator("#composer-input").fill("第一任务的清洗记录")
            page.locator("#btn-send").click()
            page.locator('[data-module-type="download-data"]').click()
            expect(page.locator("#section-name")).to_have_text("下载数据")
            expect(tabs).to_have_count(7)
            expect(page.locator('[data-module-type="plotting"]')).to_be_disabled()
            page.locator('[data-module-type="calculation"]').click()
            page.get_by_label("计算路径", exact=True).select_option("direct")
            expect(page.locator('[data-module-type="plotting"]')).to_be_enabled()
            page.locator('[data-module-type="clean-data"]').click()
            expect(page.locator("#module-space")).to_contain_text("第一任务的清洗记录")
            create("侧栏测试二")
            expect(page.locator("#module-space")).not_to_contain_text("第一任务的清洗记录")
            page.locator("#task-select").select_option(first)
            expect(page.locator("#module-space")).to_contain_text("第一任务的清洗记录")

            with page.expect_download() as download_info:
                page.locator("#backup-project").click()
            payload = json.loads(Path(download_info.value.path()).read_text(encoding="utf-8"))
            assert payload["app"] == "yanxu-workspace"
            assert "research_tasks_v1" in payload["data"]
            with page.expect_file_chooser():
                page.locator("#import-project").click()
            with page.expect_navigation():
                page.locator("#import-file").set_input_files({"name": "fixture-backup.json", "mimeType": "application/json", "buffer": json.dumps(payload).encode()})
            expect(page.locator("#task-select")).to_have_value(first)
            expect(page.locator("#module-space")).to_contain_text("第一任务的清洗记录")

            page.goto(base + "?view=records")
            expect(page.locator("#records-view")).to_be_visible()
            page.locator("#records-search").fill("第一任务的清洗记录")
            expect(page.locator("#records-list")).to_contain_text("第一任务的清洗记录")
            page.get_by_role("button", name="返回工作台", exact=True).click()
            expect(page.locator("#records-view")).to_be_hidden()
            expect(page.locator("#task-summary")).to_be_visible()
            assert "view=records" not in page.url
            page.evaluate("WorkspaceUI.switchView('records')")
            page.locator('[data-module-type="clean-data"]').click()
            expect(page.locator("#records-view")).to_be_hidden()
            workspace_summary = page.locator("#sidebar-workspace-section > summary")
            workspace_summary.click()
            expect(tabs.first).to_be_hidden()
            workspace_summary.click()
            expect(tabs.first).to_be_visible()
            expect(tabs).to_have_count(7)
            previews = ROOT / ".workbench/test-fixtures/sidebar-layout"
            previews.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(previews / "desktop.png"))
            page.set_viewport_size({"width": 375, "height": 850})
            page.locator("#btn-sidebar-toggle").click()
            expect(page.locator("#sidebar")).to_have_css("width", "52px")
            assert page.locator("#main").bounding_box()["x"] >= page.locator("#sidebar").bounding_box()["width"]
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(previews / "mobile.png"))

            page.set_viewport_size({"width": 1400, "height": 1000})
            page.evaluate("TaskManager.createTask('旧九步兼容', 'research')")
            page.evaluate("Store.appendMessage(Store.getState().activeModuleId, '旧流程记录仍在', 'user')")
            page.goto(base + "?flow=1")
            page.evaluate("Store.setSidebar({collapsed:false})")
            expect(page.locator(".sidebar-flow-btn")).to_be_visible()
            assert page.evaluate("Store.getState().modules.some(m=>m.messages.some(x=>x.text==='旧流程记录仍在'))")
            assert not errors, errors
            browser.close()
        print("WORKSPACE_NAVIGATION_PASS: seven modules, task switching, backup/restore, records deep link, folding and legacy preservation")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
