"""Task-owned browser, pacing and attention fixtures; no real site access."""
from contextlib import contextmanager
import copy
import json
from pathlib import Path
import tempfile
import unittest

import literature_fulltext_browser as mod


PDF = b"%PDF-1.7\n" + b"x" * (60 * 1024)


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def time(self):
        return self.now

    def sleep(self, amount):
        self.sleeps.append(amount)
        self.now += amount


class CDP:
    def __init__(self, page):
        self.page = page

    def send(self, name):
        assert name == "Target.getTargetInfo"
        return {"targetInfo": {"targetId": self.page.target}}

    def detach(self):
        pass


class Response:
    def __init__(self, status=200, headers=None, body=b""):
        self.status = status
        self.headers = headers or {"content-type": "text/html"}
        self._body = body

    def body(self):
        return self._body


class Download:
    def __init__(self, path):
        self._path = path

    def path(self):
        raise AssertionError("remote artifact paths are not required")

    def save_as(self, path):
        Path(path).write_bytes(Path(self._path).read_bytes())


def snapshot(**changes):
    value = {"text": "Visible article page", "page_title": "Heat stress in broilers",
             "citation_title": "Heat stress in broilers", "citation_doi": "10.1/test",
             "article_text": "Real article text", "article_html": "<article>Real article text</article>",
             "headings": [{"level": 2, "text": "Methods"}], "sections": [], "links": [],
             "container": "article", "container_verified": False, "origin": "dom_article_region"}
    value.update(changes)
    return value


class Page:
    def __init__(self, target, steps=None, url="about:blank"):
        self.target, self.url = target, url
        self.steps = list(steps or [])
        self.snapshot = snapshot()
        self.listeners = {}
        self.gotos, self.fronts, self.closed = [], 0, False

    def is_closed(self):
        return self.closed

    def bring_to_front(self):
        self.fronts += 1

    def close(self, **options):
        if not self.target.startswith("owned-"):
            raise AssertionError("researcher pages must not close")
        self.closed = True

    def on(self, event, listener):
        self.listeners.setdefault(event, []).append(listener)

    def remove_listener(self, event, listener):
        self.listeners[event].remove(listener)

    def goto(self, url, **options):
        self.gotos.append((url, options))
        self.url = url
        step = self.steps.pop(0) if self.steps else {}
        self.url = step.get("url", url)
        self.snapshot = copy.deepcopy(step.get("snapshot", snapshot()))
        if step.get("download"):
            for listener in self.listeners.get("download", []):
                listener(step["download"])
        if step.get("error"):
            raise step["error"]
        return step.get("response", Response())

    def wait_for_timeout(self, delay):
        assert delay == 200

    def evaluate(self, script):
        assert "literature_fulltext_snapshot" in script
        return copy.deepcopy(self.snapshot)


class Context:
    def __init__(self, steps=None):
        self.pages = [Page("researcher-blank"), Page("researcher-article", url="https://example.org/keep")]
        self.next_steps = steps or []
        self.creates = 0
        self.entries = 0
        self.exits = 0

    def new_page(self):
        self.creates += 1
        page = Page(f"owned-{self.creates}", self.next_steps)
        self.pages.append(page)
        return page

    def new_cdp_session(self, page):
        return CDP(page)

    def close(self):
        raise AssertionError("persistent browser context must not close")

    @contextmanager
    def runtime(self):
        self.entries += 1
        try:
            yield self
        finally:
            self.exits += 1


class BrowserTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "中文任务"
        self.clock = Clock()
        self.progress = []

    def tearDown(self):
        self.temp.cleanup()

    def fetcher(self, context):
        return mod.FulltextBrowserFetcher({}, self.path, runtime_factory=context.runtime,
                                          clock=self.clock.time, sleep=self.clock.sleep,
                                          on_progress=self.progress.append)

    def test_one_owned_tab_and_one_connection_reused_without_closing_researcher_tabs(self):
        context = Context()
        fetcher = self.fetcher(context)
        self.assertEqual(fetcher.ensure_ready(), {"status": "ok"})
        for index in range(3):
            self.assertEqual(fetcher.fetch_page(f"https://publisher.test/article/{index}", {})["status"], "ok")
        self.assertEqual(context.creates, 1)
        self.assertEqual(context.entries, 1)
        self.assertEqual(len(context.pages[-1].gotos), 3)
        self.assertFalse(context.pages[0].gotos)
        self.assertFalse(context.pages[1].gotos)
        self.assertEqual(self.clock.sleeps, [8, 8])
        fetcher.close()
        self.assertEqual(context.exits, 1)
        self.assertTrue(all(not p.closed for p in context.pages))

    def test_restart_reuses_exact_task_binding_and_pacing(self):
        context = Context()
        first = self.fetcher(context)
        first.fetch_page("https://kns.cnki.net/article/one", {})
        first.close()
        second = self.fetcher(context)
        second.fetch_page("https://kns.cnki.net/article/two", {})
        self.assertEqual(context.creates, 1)
        self.assertEqual(len(context.pages[-1].gotos), 2)
        self.assertEqual(self.clock.sleeps, [10])
        data = json.loads(second.binding_path.read_text(encoding="utf-8"))
        self.assertEqual(data["target_id"], "owned-1")
        self.assertNotIn("article/one", second.binding_path.read_text(encoding="utf-8"))

    def test_other_job_never_borrows_first_jobs_page(self):
        context = Context()
        first = self.fetcher(context)
        first.ensure_ready()
        second = mod.FulltextBrowserFetcher({}, self.path / "other", runtime_factory=context.runtime)
        second.ensure_ready()
        self.assertEqual(context.creates, 2)
        self.assertNotEqual(first._page.target, second._page.target)

    def test_open_current_does_not_create_or_navigate(self):
        context = Context()
        missing = self.fetcher(context)
        self.assertFalse(missing.open_current()["opened"])
        self.assertEqual(context.creates, 0)
        missing.ensure_ready()
        self.assertTrue(missing.open_current()["opened"])
        self.assertEqual(context.pages[-1].fronts, 1)
        self.assertFalse(context.pages[-1].gotos)

    def test_explicit_http_and_visible_errors_pause_immediately(self):
        cases = [(Response(429), {}, "rate_limited"), (Response(403), {}, "access_required"),
                 (Response(404), {}, "page_error"), (Response(), {"page_error": True}, "page_error"),
                 (Response(), {"verification": True}, "verification"),
                 (Response(), {"login": True}, "login"),
                 (Response(), {"access_required": True}, "access_required"),
                 (Response(), {"rate_limited": True}, "rate_limited"),
                 (Response(403), {"verification": True}, "verification")]
        for index, (response, changes, reason) in enumerate(cases):
            with self.subTest(reason=reason, index=index):
                self.path = Path(self.temp.name) / str(index)
                context = Context([{"response": response, "snapshot": snapshot(**changes)}])
                fetcher = self.fetcher(context)
                result = fetcher.fetch_page("https://kns.cnki.net/article/test", {})
                self.assertEqual((result["status"], result["reason"]), ("attention", reason))
                self.assertEqual(fetcher.fetch_page("https://example.test/another", {}), result)
                self.assertEqual(len(context.pages[-1].gotos), 1)
                self.assertEqual(context.creates, 1)

    def test_timeout_is_attention_and_original_page_remains(self):
        context = Context([{"error": TimeoutError("Page.goto: Timeout 60000ms exceeded")}])
        fetcher = self.fetcher(context)
        result = fetcher.fetch_page("https://publisher.test/slow", {"per_paper_timeout_sec": 300})
        self.assertEqual(result["reason"], "load_timeout")
        self.assertEqual(context.pages[-1].gotos[0][1]["timeout"], 60000)
        self.assertFalse(context.pages[-1].closed)

    def test_completion_closes_only_owned_page_after_saved_result_and_preserves_pacing(self):
        context = Context([{"response": Response(headers={"content-type": "application/pdf"}, body=PDF)}])
        fetcher = self.fetcher(context)
        out = self.path / "saved.pdf"
        self.assertEqual(fetcher.fetch_pdf("https://kns.cnki.net/a.pdf", out, {})["status"], "saved")
        first_owned = context.pages[-1]
        self.assertEqual(fetcher.complete_paper(), {"closed": True})
        self.assertTrue(out.exists())
        self.assertTrue(first_owned.closed)
        self.assertTrue(all(not page.closed for page in context.pages[:2]))
        binding = json.loads(fetcher.binding_path.read_text(encoding="utf-8"))
        self.assertNotIn("target_id", binding)
        self.assertIn("cnki.net", binding["last_request_at"])
        fetcher.fetch_page("https://kns.cnki.net/next", {})
        self.assertEqual(context.creates, 2)
        self.assertEqual(self.clock.sleeps, [10])
        self.assertEqual(sum(not page.closed for page in context.pages[2:]), 1)

    def test_completion_cannot_close_attention_or_any_researcher_page(self):
        context = Context([{"snapshot": snapshot(verification=True)}])
        fetcher = self.fetcher(context)
        fetcher.fetch_page("https://publisher.test/a", {})
        self.assertEqual(fetcher.complete_paper(), {"closed": False})
        self.assertTrue(all(not page.closed for page in context.pages))
        empty_context = Context()
        missing = self.fetcher(empty_context)
        self.assertEqual(missing.complete_paper(), {"closed": False})
        self.assertEqual(empty_context.creates, 0)

    def test_manual_resume_inspects_exact_bound_page_without_reloading_challenge(self):
        context = Context([{"snapshot": snapshot(verification=True)}])
        first = self.fetcher(context)
        url = "https://publisher.test/article/one"
        self.assertEqual(first.fetch_page(url, {})["reason"], "verification")
        first.close()
        context.pages[-1].snapshot = snapshot()
        second = self.fetcher(context)
        self.assertEqual(second.fetch_page(url, {})["status"], "ok")
        self.assertEqual(len(context.pages[-1].gotos), 1)
        self.assertEqual(context.creates, 1)
        self.assertNotIn("pending_url_hash", json.loads(second.binding_path.read_text(encoding="utf-8")))

    def test_pdf_response_is_real_validated_artifact_without_extra_http_or_tabs(self):
        context = Context([{"response": Response(headers={"content-type": "application/pdf"}, body=PDF)}])
        fetcher = self.fetcher(context)
        out = self.path / "saved.pdf"
        result = fetcher.fetch_pdf("https://publisher.test/a.pdf", out, {})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(out.read_bytes(), PDF)
        self.assertEqual(context.creates, 1)
        self.assertEqual(len(context.pages[-1].gotos), 1)

    def test_download_navigation_abort_uses_actual_download_file(self):
        downloaded = Path(self.temp.name) / "browser-artifact.pdf"
        downloaded.write_bytes(PDF)
        context = Context([{"error": RuntimeError("net::ERR_ABORTED"), "download": Download(str(downloaded))}])
        fetcher = self.fetcher(context)
        out = self.path / "saved.pdf"
        self.assertEqual(fetcher.fetch_pdf("https://publisher.test/download", out, {})["status"], "saved")
        self.assertEqual(out.read_bytes(), PDF)
        self.assertFalse(context.pages[-1].listeners["download"])

    def test_invalid_pdf_and_html_button_are_never_claimed_saved(self):
        context = Context([{"response": Response(headers={"content-type": "application/pdf"}, body=b"<html>not PDF</html>")}, {}])
        fetcher = self.fetcher(context)
        out = self.path / "no.pdf"
        self.assertEqual(fetcher.fetch_pdf("https://publisher.test/a.pdf", out, {})["status"], "fetch_error")
        self.assertFalse(out.exists())
        self.assertEqual(fetcher.fetch_pdf("https://publisher.test/button", out, {})["status"], "html_page")
        self.assertFalse(out.exists())

    def test_visible_legal_pdf_link_uses_same_page_with_pacing(self):
        context = Context([
            {"snapshot": snapshot(links=[{"url": "/paper.pdf", "text": "Download PDF"}])},
            {"response": Response(headers={"content-type": "application/pdf"}, body=PDF)},
        ])
        fetcher = self.fetcher(context)
        out = self.path / "legal.pdf"
        result = fetcher.fetch_pdf("https://publisher.test/article", out, {})
        self.assertEqual(result["status"], "saved")
        self.assertEqual(context.creates, 1)
        self.assertEqual([v[0] for v in context.pages[-1].gotos],
                         ["https://publisher.test/article", "https://publisher.test/paper.pdf"])
        self.assertEqual(self.clock.sleeps, [8])

    def test_evidence_has_body_structure_and_excludes_auth_links(self):
        data = snapshot(article_text="actual full body", container_verified=True,
                        sections=[{"heading": "Methods", "text": "actual full body"}],
                        links=[{"url": "/login?token=secret", "text": "Full text"},
                               {"url": "/paper.pdf", "text": "PDF"}])
        context = Context([{"snapshot": data}])
        result = self.fetcher(context).fetch_page("https://publisher.test/article", {})
        evidence = result["html_evidence"]
        self.assertEqual(evidence["article_text"], "actual full body")
        self.assertTrue(evidence["container_verified"])
        self.assertEqual(evidence["links"], [{"url": "https://publisher.test/paper.pdf", "text": "PDF", "kind": "pdf"}])
        self.assertNotIn("secret", json.dumps(evidence))

    def test_redirect_to_cnki_carries_ten_second_floor_to_next_access(self):
        context = Context([{"url": "https://kns.cnki.net/article/one"}, {}])
        fetcher = self.fetcher(context)
        fetcher.fetch_page("https://doi.org/10.1/one", {})
        fetcher.fetch_page("https://doi.org/10.1/two", {})
        self.assertEqual(self.clock.sleeps, [10])

    def test_constructor_requires_job_and_rejects_auth_url_without_access(self):
        with self.assertRaises(ValueError):
            mod.FulltextBrowserFetcher({})
        context = Context()
        result = self.fetcher(context).fetch_page("https://publisher.test/login?token=secret", {})
        self.assertEqual(result["status"], "fetch_error")
        self.assertEqual(context.creates, 0)


class LocalDOMTests(unittest.TestCase):
    """Evaluate the actual production JS on local fixture HTML only.

    This isolated headless browser never attaches to the researcher profile.
    All network requests are blocked, and only this test browser is closed.
    """
    @classmethod
    def setUpClass(cls):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise unittest.SkipTest("Playwright not installed for local DOM fixture") from exc
        cls.playwright = sync_playwright().start()
        if not Path(cls.playwright.chromium.executable_path).exists():
            cls.playwright.stop()
            raise unittest.SkipTest("Chromium not installed for local DOM fixture")
        cls.browser = cls.playwright.chromium.launch(headless=True, args=["--disable-background-networking"])
        cls.context = cls.browser.new_context()
        cls.blocked_requests = []
        def block(route):
            cls.blocked_requests.append(route.request.url)
            route.abort()
        cls.context.route("**/*", block)
        cls.page = cls.context.new_page()

    @classmethod
    def tearDownClass(cls):
        cls.context.close()
        cls.browser.close()
        cls.playwright.stop()

    def evaluate(self, html):
        self.page.set_content(html)
        return self.page.evaluate(mod._SNAPSHOT_JS)

    def test_pubmed_sources_with_database_names_are_included_but_related_articles_are_not(self):
        links = "".join(f'<a href="https://publisher.test/article/{n}">Publisher {n}</a>' for n in range(10))
        data = self.evaluate('<h1>Heat stress in broilers</h1><div class="full-text-links">'
                             '<a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC123/">PubMed Central</a>'
                             '<a href="https://mdpi.test/2076/paper">MDPI</a>' + links + '</div>'
                             '<section id="similar-articles"><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC999/">Related paper</a></section>')
        actual = [item["url"] for item in data["links"]]
        self.assertIn("https://pmc.ncbi.nlm.nih.gov/articles/PMC123/", actual)
        self.assertIn("https://mdpi.test/2076/paper", actual)
        self.assertNotIn("https://pmc.ncbi.nlm.nih.gov/articles/PMC999/", actual)
        self.assertEqual(len(actual), 8)

    def test_actual_visible_article_region_and_heading_sections_exclude_hidden_navigation_and_references(self):
        methods = "We measured growth and feed conversion in a controlled broiler experiment. " * 10
        results = "High temperature changed growth performance and daily feed intake in the study. " * 10
        data = self.evaluate('<meta name="citation_title" content="Heat stress in broilers">'
                             '<meta name="citation_doi" content="10.1000/example"><nav>TOP NAVIGATION</nav>'
                             '<article><h1>Heat stress in broilers</h1><div style="display:none">HIDDEN SECRET TEXT</div>'
                             '<h2>Materials and methods</h2><p>' + methods + '</p><h2>Results</h2><p>' + results + '</p>'
                             '<section class="references"><h2>References</h2><p>REFERENCE LIST REMOVAL</p></section></article>')
        self.assertTrue(data["container_verified"])
        self.assertEqual(data["citation_doi"], "10.1000/example")
        self.assertIn(methods.strip(), data["article_text"])
        self.assertNotIn("HIDDEN SECRET TEXT", data["article_text"])
        self.assertNotIn("TOP NAVIGATION", data["article_text"])
        self.assertNotIn("REFERENCE LIST REMOVAL", data["article_text"])
        self.assertEqual([s["heading"] for s in data["sections"]], ["Materials and methods", "Results"])
        for section in data["sections"]:
            self.assertGreater(len(section["text"]), 100)
            self.assertIn(section["text"], data["article_text"])

    def test_real_dom_error_challenge_login_and_ordinary_login_navigation(self):
        data = self.evaluate('<h1>404</h1><p>您所访问的页面不存在或已被删除！</p>')
        self.assertTrue(data["page_error"])
        self.assertFalse(data["container_verified"])
        data = self.evaluate('<h1>请完成验证</h1><div id="captcha">滑动验证</div>')
        self.assertTrue(data["verification"])
        data = self.evaluate('<h1>Sign in to access</h1><input type="password">')
        self.assertTrue(data["login"])
        data = self.evaluate('<nav>登录 / 注册</nav><article><h1>Publication abstract</h1><p>' + 'Abstract text. ' * 100 + '</p></article>')
        self.assertFalse(data["login"])
        self.assertFalse(data["container_verified"])


if __name__ == "__main__":
    unittest.main()
