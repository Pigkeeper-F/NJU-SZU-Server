"""Local-only PDF downloads through Chrome's persistent CDP default context.

This launches its own temporary Chrome profile/port, never the research browser.
No remote HTTP is permitted. Optional LITERATURE_CDP_TEST_REPORT saves sanitized
test traces to a caller-selected report file; no URL queries/body are logged.
"""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import inspect
import hashlib
import io
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

from playwright.sync_api import APIRequestContext, Response as BrowserResponse, sync_playwright
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject

import literature_fulltext_browser as mod
from literature_material_collection import MaterialCollection
from literature_materials import MaterialsStore
from test_literature_fulltext_browser import Clock


DOI = "10.1234/local-cdp-fixture"
TITLE = "Local PDF download integration fixture"


def fixture_pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    stream = DecodedStreamObject()
    stream.set_data(b"\n" * 65536)
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


PDF = fixture_pdf()


class PersistentCDPTests(unittest.TestCase):
    reports = []

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="literature-isolated-cdp-")
        self.base = Path(self.tmp.name).resolve()
        self.events = []
        self.original_response_body = BrowserResponse.body
        original_body = self.original_response_body
        def inspected_body(response):
            try:
                value = original_body(response)
            except Exception as error:
                self.events.append({"event": "response_body_error", "type": type(error).__name__})
                raise
            if "application/pdf" in response.headers.get("content-type", ""):
                self.events.append({"event": "pdf_response_body", "bytes": len(value),
                    "starts_pdf": value.startswith(b"%PDF"), "starts_html": value.lstrip().lower().startswith((b"<!doctype", b"<html"))})
            return value
        BrowserResponse.body = inspected_body
        self.server_started_file = threading.Event()
        self.secondary_done = threading.Event()
        self.secondary = None
        self.expiring_links_issued = 0
        self.material_blobs = {}
        self.playwright = sync_playwright().start()
        executable = self.playwright.chromium.executable_path
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.cdp_url = f"http://127.0.0.1:{port}"
        flags = [executable, "--headless=new", f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1", f"--user-data-dir={self.base / 'chrome-profile'}",
            "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            "--disable-component-update", "--disable-default-apps", "--disable-sync", "about:blank"]
        self.chrome = subprocess.Popen(flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        for attempt in range(100):
            try:
                with urlopen(self.cdp_url + "/json/version", timeout=.2) as response:
                    response.read()
                break
            except Exception:
                if attempt == 99:
                    raise RuntimeError("Isolated fixture CDP startup failed")
                time.sleep(.1)
        self.browser = self.playwright.chromium.connect_over_cdp(self.cdp_url)
        self.context = self.browser.contexts[0]  # Same attach contract as production.
        self.context.route("**/*", lambda route: route.continue_() if urlsplit(route.request.url).hostname == "127.0.0.1" else route.abort())
        self.context.on("page", self.attach_trace)
        def context_response(value):
            if "application/pdf" in value.headers.get("content-type", ""):
                try:
                    navigation = value.request.is_navigation_request()
                    owner = value.request.frame.page
                    page_closed = owner.is_closed()
                except Exception:
                    navigation, page_closed = None, None
                self.events.append({"event": "context_pdf_response", "status": value.status,
                    "navigation": navigation, "page_closed": page_closed})
        self.context.on("response", context_response)
        for page in self.context.pages:
            self.attach_trace(page)

        owner = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                parsed = urlsplit(self.path)
                values = parse_qs(parsed.query)
                kind = values.get("kind", ["attachment"])[0]
                owner.events.append({"event": "http", "path": parsed.path, "kind": kind})
                if parsed.path == "/materials/article":
                    links = ''.join(f'<a href="{owner.origin}/materials/supplement.{ext}">Supplementary data {ext.upper()}</a><br>'
                                    for ext in owner.material_blobs)
                    body = f'''<!DOCTYPE html><meta name="citation_title" content="{TITLE}">
                        <meta name="citation_doi" content="{DOI}"><h1>{TITLE}</h1>
                        <article><section><h2>Results</h2><p>{'Measured broiler growth results. ' * 50}</p></section>
                        <section id="supplementary-material"><h2>Supplementary material</h2>{links}</section></article>'''.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif parsed.path == "/materials/supplement.xlsx":
                    body = b'''<!doctype html><main aria-busy="true">Generating supplementary spreadsheet</main>
                        <script>setTimeout(()=>{const a=document.createElement('a');
                        a.href='/materials/files/supplement.xlsx';a.download='supplement.xlsx';
                        document.body.append(a);document.querySelector('main').setAttribute('aria-busy','false');a.click();},1200)</script>'''
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif parsed.path.startswith(("/materials/supplement.", "/materials/files/supplement.")):
                    ext = parsed.path.rsplit(".", 1)[-1]
                    body = owner.material_blobs[ext]
                    mime = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "zip": "application/zip"}[ext]
                    self.send_response(200)
                    self.send_header("Content-Type", mime)
                    self.send_header("Content-Disposition", 'attachment; filename="supplement.' + ext + '"')
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif parsed.path == "/article":
                    target = f"{owner.origin}/doi/pdf/{DOI}?kind={kind}"
                    popup = 'target="_blank"' if values.get("popup") == ["1"] else ""
                    body = f'''<!DOCTYPE html><meta name="citation_title" content="{TITLE}">
                      <meta name="citation_doi" content="{DOI}"><h1>{TITLE}</h1>
                      <a id="download" href="{target}" {popup} onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Download PDF</a>'''.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                elif parsed.path == "/doi/pdf/" + DOI:
                    if kind == "captcha":
                        self.send_response(403)
                        self.send_header("Content-Type", "text/html")
                        self.end_headers()
                        self.wfile.write(b'<h1>Are you a robot</h1><div id="captcha">Verify you are human</div>')
                        return
                    if kind in {"redirect", "expiring"}:
                        signature = "signature=fixture-signed-query"
                        if kind == "expiring":
                            owner.expiring_links_issued += 1
                            stamp = "20200101T000000Z" if owner.expiring_links_issued == 1 else time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
                            signature = "X-Amz-Date=" + stamp + "&X-Amz-Expires=300&X-Amz-Signature=fixture-signed-query"
                        self.send_response(302)
                        self.send_header("Location", owner.origin + "/cdn/fixture.pdf?" + signature + "&kind=inline")
                        self.end_headers()
                        return
                    self.serve_pdf(kind)
                elif parsed.path == "/cdn/fixture.pdf":
                    self.serve_pdf(kind)
                else:
                    self.send_error(404)

            def serve_pdf(self, kind):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Disposition", ('inline' if kind == 'inline' else 'attachment') + '; filename="fixture.pdf"')
                    self.send_header("Content-Length", str(len(PDF)))
                    self.end_headers()
                    if kind == "slow":
                        self.wfile.write(PDF[:1024])
                        self.wfile.flush()
                        owner.server_started_file.set()
                        owner.secondary_done.wait(6)
                    self.wfile.write(PDF[1024:] if kind == "slow" else PDF)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http_thread.start()
        self.clock = Clock()

        @contextmanager
        def runtime():
            yield self.context
        self.fetcher = mod.FulltextBrowserFetcher({}, self.base / "job", runtime_factory=runtime,
            clock=self.clock.time, sleep=self.clock.sleep,
            on_progress=lambda message: self.events.append({"event": "progress", "message": message}))
        self.fetcher._pace = lambda _: None
        def tick(page):
            page.wait_for_timeout(20)
            self.clock.sleep(.2)
        self.fetcher._wait_tick = tick
        original_attention = self.fetcher._attention
        def attention(reason, *args, **kwargs):
            caller = inspect.currentframe().f_back
            self.events.append({"event": "attention", "reason": reason,
                "caller": caller.f_code.co_name, "line": caller.f_lineno})
            return original_attention(reason, *args, **kwargs)
        self.fetcher._attention = attention
        original_read = self.fetcher._read_download
        def read_download(download, path=None):
            self.events.append({"event": "read_download", "stage": "begin"})
            value = original_read(download, path)
            self.events.append({"event": "read_download", "stage": "end", "bytes": len(value) if value else 0})
            return value
        self.fetcher._read_download = read_download

    def attach_trace(self, page):
        def popup(child):
            try:
                opener = child.opener()
                proof = "same_parent" if opener is page else "none" if opener is None else "other_parent"
                closed = child.is_closed()
            except Exception:
                proof, closed = "unavailable", None
            self.events.append({"event": "popup", "opener": proof, "closed": closed})
        def response(value):
            try:
                if value.request.is_navigation_request():
                    self.events.append({"event": "response", "status": value.status,
                        "mime": value.headers.get("content-type", "").split(";", 1)[0]})
            except Exception:
                pass
        page.on("popup", popup)
        page.on("response", response)
        page.on("download", lambda _: self.events.append({"event": "download"}))

    def tearDown(self):
        self.reports.append({"test": self.id(), "events": self.events})
        BrowserResponse.body = self.original_response_body
        if self.secondary is not None:
            self.secondary_done.set()
            self.secondary.join(8)
        self.fetcher.close()
        try:
            session = self.browser.new_browser_cdp_session()
            session.send("Browser.close")  # Only the process launched above.
        except Exception:
            pass
        try:
            self.chrome.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.chrome.terminate()
            self.chrome.wait(timeout=8)
        self.playwright.stop()
        self.server.shutdown()
        self.server.server_close()
        assert self.base.parent == Path(tempfile.gettempdir()).resolve()
        for attempt in range(20):
            try:
                self.tmp.cleanup()
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(.2)

    @classmethod
    def tearDownClass(cls):
        destination = os.environ.get("LITERATURE_CDP_TEST_REPORT")
        if destination:
            path = Path(destination).resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(cls.reports, ensure_ascii=False, indent=2), encoding="utf-8")

    def acquire(self, kind, popup=False):
        source = f"{self.origin}/article?kind={kind}&popup={int(popup)}"
        target = f"{self.origin}/doi/pdf/{DOI}?kind={kind}"
        record = {"paper_id": "CDP-FIXTURE", "title": TITLE, "doi": DOI, "source_url": source}
        opened = self.fetcher.fetch_page(source, {"record": record})
        self.assertEqual(opened["status"], "ok", self.events)
        parent = self.fetcher._page
        out = self.base / "job" / "main.pdf"
        result = self.fetcher.fetch_pdf(target, out, {"record": record})
        self.events.append({"event": "result", "status": result.get("status"), "reason": result.get("reason"),
            "saved_bytes": out.stat().st_size if out.exists() else 0, "download_events": sum(item["event"] == "download" for item in self.events)})
        try:
            active = self.fetcher._page
            self.events.append({"event": "active_pdf_viewer", "closed": active.is_closed(),
                "pdf_embeds": active.locator('embed[type="application/pdf"]').count(),
                "local_dom": active.evaluate("() => ({contentType:document.contentType, tags:document.documentElement.outerHTML.slice(0,1600)})")})
            if kind == "inline":
                session = self.context.new_cdp_session(active)
                try:
                    tree = session.send("Page.getResourceTree")["frameTree"]
                    self.events.append({"event": "resource_tree", "frame_mime": tree["frame"].get("mimeType"),
                        "resources": [{"type": item.get("type"), "mime": item.get("mimeType")} for item in tree.get("resources", [])]})
                    try:
                        resource = session.send("Page.getResourceContent", {"frameId": tree["frame"]["id"], "url": target})
                        data = base64.b64decode(resource["content"]) if resource.get("base64Encoded") else resource["content"].encode()
                        self.events.append({"event": "resource_body", "bytes": len(data), "starts_pdf": data.startswith(b"%PDF"), "starts_html": data.lstrip().startswith(b"<!doctype")})
                    except Exception as error:
                        self.events.append({"event": "resource_body_error", "type": type(error).__name__})
                finally:
                    session.detach()
        except Exception as error:
            self.events.append({"event": "active_pdf_viewer_error", "type": type(error).__name__})
        self.assertEqual(result["status"], "saved", self.events)
        self.assertEqual(out.read_bytes(), PDF)
        if kind not in {"inline", "redirect"} or popup:
            self.assertEqual(parent.locator('#download').get_attribute('href'), target)
        elif kind == "inline":
            self.assertEqual(parent.url, target)
        return result

    def test_attachment_same_page(self):
        self.acquire("attachment")

    def test_attachment_target_blank(self):
        self.acquire("attachment", popup=True)

    def test_inline_same_page(self):
        self.acquire("inline")

    def test_inline_target_blank(self):
        self.acquire("inline", popup=True)

    def test_observed_redirect_to_signed_inline_pdf(self):
        result = self.acquire("redirect", popup=True)
        self.assertEqual(result["acquisition_method"], "observed_native_pdf")
        self.assertNotIn("signature=", result["url"])
        diagnostic = self.base / "job" / "fulltext" / "download-diagnostics.jsonl"
        self.assertNotIn("fixture-signed-query", diagnostic.read_text(encoding="utf-8"))

    def test_inline_direct_pdf_navigation_uses_same_recovery(self):
        target = f"{self.origin}/doi/pdf/{DOI}?kind=inline"
        out = self.base / "job" / "direct.pdf"
        result = self.fetcher.fetch_pdf(target, out, {"record": {"paper_id": "CDP-DIRECT", "title": TITLE, "doi": DOI}})
        self.assertEqual(result["status"], "saved", self.events)
        self.assertEqual(result["acquisition_method"], "observed_native_pdf")
        self.assertEqual(out.read_bytes(), PDF)

    def prepared_retained_native(self, kind="redirect"):
        source = f"{self.origin}/article?kind={kind}&popup=1"
        entry = f"{self.origin}/doi/pdf/{DOI}?kind={kind}"
        record = {"paper_id": "CDP-RESUME", "title": TITLE, "doi": DOI, "source_url": source}
        self.assertEqual(self.fetcher.fetch_page(source, {"record": record})["status"], "ok")
        parent = self.fetcher._page
        with parent.expect_popup() as popup:
            parent.locator('#download').click()
        child = popup.value
        child.wait_for_load_state('domcontentloaded')
        self.assertEqual(child.evaluate('() => document.contentType'), 'application/pdf')
        self.fetcher._binding.update(target_id=mod.literature_browser._target_id(self.context, child),
            pdf_cleanup_target_ids=[mod.literature_browser._target_id(self.context, parent)],
            pdf_click_pending=True, pending_url_hash=mod._url_hash(entry), attention_reason="verification")
        self.fetcher._write_binding()
        self.fetcher.close()
        @contextmanager
        def runtime():
            yield self.context
        self.fetcher = mod.FulltextBrowserFetcher({}, self.base / 'job', runtime_factory=runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        return record, entry, parent, child

    def test_expired_retained_native_refreshes_parent_once_without_getting_old_signature(self):
        record, entry, parent, old_child = self.prepared_retained_native("expiring")
        self.assertTrue(mod._signed_pdf_expired(old_child.url))
        old_id = self.fetcher._binding["target_id"]
        before = sum(item["event"] == "http" for item in self.events)
        out = self.base / "job" / "refreshed.pdf"
        denied = self.fetcher.fetch_pdf(entry, out, {"record": record})
        self.assertEqual(denied["status"], "attention")
        self.assertEqual(sum(item["event"] == "http" for item in self.events), before)
        self.fetcher._blocked = None
        saved = self.fetcher.fetch_pdf(entry, out, {"record": record, "refresh_expired_pdf": True})
        self.assertEqual(saved["status"], "saved", self.events)
        self.assertEqual(out.read_bytes(), PDF)
        self.assertEqual(parent.locator("#download").get_attribute("data-clicks"), "2")
        self.assertEqual(self.expiring_links_issued, 2)
        # Exactly the fresh entry, redirected PDF, and verified PDF file GET.
        self.assertEqual(sum(item["event"] == "http" for item in self.events), before + 3)
        self.assertFalse(old_child.is_closed())
        self.assertIn(old_id, self.fetcher._binding["pdf_cleanup_target_ids"])
        self.assertEqual(self.fetcher._binding["pdf_parent_fallback"]["expired_native"]["target_id"], old_id)
        self.assertFalse(self.fetcher._binding.get("pdf_click_pending"))
        diagnostics = (self.base / "job" / "fulltext" / "download-diagnostics.jsonl").read_text(encoding="utf-8")
        self.assertEqual(diagnostics.count('"code": "expired_pdf_parent_refresh"'), 1)
        self.assertNotIn("fixture-signed-query", diagnostics)

    def test_retained_native_after_human_handoff_saves_without_click_or_navigation(self):
        record, entry, parent, child = self.prepared_retained_native()
        before = sum(event['event'] == 'http' for event in self.events)
        native_url = child.url
        preflight = self.fetcher.inspect_materials(record, {"replenish_materials": True, "main_pdf_first": True})
        self.assertTrue(preflight["main_pdf_ready"])
        self.assertEqual(preflight["main_pdf_links"][0]["url"], entry)
        self.assertEqual(sum(event['event'] == 'http' for event in self.events), before)
        out = self.base / 'job' / 'resumed.pdf'
        saved = self.fetcher.fetch_pdf(entry, out, {"record": record})
        self.assertEqual(saved['status'], 'saved')
        self.assertEqual(out.read_bytes(), PDF)
        self.assertEqual(child.url, native_url)
        self.assertEqual(parent.locator('#download').get_attribute('data-clicks'), '1')
        self.assertEqual(sum(event['event'] == 'http' for event in self.events), before + 1)
        diagnostic = (self.base / 'job' / 'fulltext' / 'download-diagnostics.jsonl').read_text(encoding='utf-8')
        records = [json.loads(line) for line in diagnostic.splitlines()]
        resumed = [item for item in records if item['code'] == 'native_pdf_resume']
        self.assertEqual(len(resumed), 1)
        self.assertNotIn('status', resumed[0])
        self.assertNotIn('fixture-signed-query', diagnostic)

    def test_retained_inline_uses_browser_download_when_api_channel_returns_html(self):
        record, entry, parent, child = self.prepared_retained_native()
        old_get, api_calls = APIRequestContext.get, []
        def html_channel(*args, **kwargs):
            api_calls.append(True)
            class HTMLResponse:
                status, headers = 200, {"content-type": "text/html"}
                url = child.url
                def body(self):
                    return b"<html>API client interstitial</html>"
            return HTMLResponse()
        APIRequestContext.get = html_channel
        try:
            out = self.base / "job" / "native-browser.pdf"
            result = self.fetcher.fetch_pdf(entry, out, {"record": record})
            self.assertEqual(result["status"], "saved", self.events)
            self.assertEqual(out.read_bytes(), PDF)
            self.assertEqual(api_calls, [])
            self.assertEqual(parent.locator("#download").get_attribute("data-clicks"), "1")
            self.assertTrue(any(item["event"] == "download" for item in self.events))
            self.assertFalse(child.is_closed())
            self.assertEqual(child.locator("a[id^=literature-save-]").count(), 0)
        finally:
            APIRequestContext.get = old_get

    def test_retained_native_rejects_missing_owner_wrong_identity_and_unsolved_auth(self):
        record, entry, parent, _ = self.prepared_retained_native()
        original = dict(self.fetcher._binding)
        before = sum(event['event'] == 'http' for event in self.events)
        self.assertIsNone(self.fetcher._retained_native_pdf_entry(dict(record, doi='10.1234/wrong'), expected_url=entry))
        self.fetcher._binding['pdf_cleanup_target_ids'] = []
        self.assertIsNone(self.fetcher._retained_native_pdf_entry(record, expected_url=entry))
        self.fetcher._binding = dict(original)
        self.fetcher._binding['pending_url_hash'] = mod._url_hash('https://wrong.test/other.pdf')
        self.assertIsNone(self.fetcher._retained_native_pdf_entry(record, expected_url=entry))
        self.fetcher._binding = dict(original)
        parent.evaluate("() => { const input=document.createElement('input'); input.type='password'; document.body.append(input); }")
        self.assertIsNone(self.fetcher._retained_native_pdf_entry(record, expected_url=entry))
        self.assertEqual(sum(event['event'] == 'http' for event in self.events), before)

    def test_explicit_original_detail_retry_preserves_old_expired_native_evidence(self):
        record, entry, parent, child = self.prepared_retained_native("expiring")
        source = "https://www.sciencedirect.com/science/article/pii/LOCALFIXTURE"
        html = f'''<!DOCTYPE html><meta name="citation_title" content="{TITLE}">
            <meta name="citation_doi" content="{DOI}"><h1>{TITLE}</h1>
            <a id="download" href="{entry}" target="_blank" onclick="window.mainClicks=(window.mainClicks||0)+1">View PDF</a>
            <div class="js-react-modal"><div class="modal-content" style="position:fixed;inset:0;background:white;z-index:9999">
            <p>ADVERTISEMENT</p><h2>Other users also viewed these articles</h2>
            <button aria-label="close window" onclick="this.parentElement.style.display='none'">×</button>
            <button onclick="window.badDownload=true">Download (6) PDFs</button></div></div>'''
        self.context.route("https://www.sciencedirect.com/**", lambda route: route.fulfill(content_type="text/html", body=html))
        parent.goto(source)
        parent.wait_for_load_state("domcontentloaded")
        child_id = self.fetcher._binding["target_id"]
        self.fetcher._binding.update(target_id=mod.literature_browser._target_id(self.context, parent),
            pdf_cleanup_target_ids=[child_id])
        self.fetcher._page = parent
        self.fetcher._write_binding()
        out = self.base / "job" / "original-retry.pdf"
        self.assertFalse(self.fetcher._retry_original_detail_pdf(entry, out, {"record": record}))
        self.assertFalse(self.fetcher._retry_original_detail_pdf(entry, out, {"record": dict(record, doi="10.1234/wrong"), "refresh_expired_pdf": True}))
        result = self.fetcher.fetch_pdf(entry, out, {"record": record, "refresh_expired_pdf": True})
        self.assertEqual(result["status"], "saved", self.events)
        self.assertEqual(out.read_bytes(), PDF)
        self.assertEqual(parent.evaluate("() => [window.mainClicks, !!window.badDownload]"), [1, False])
        self.assertFalse(child.is_closed())
        self.assertIn(child_id, self.fetcher._binding["pdf_cleanup_target_ids"])
        audit = self.fetcher._binding["pdf_parent_fallback"]["explicit_retry"]
        self.assertEqual(audit["evidence"], "owned_expired_native_pages")
        self.assertEqual(audit["previous_click_state"], {})
        self.assertEqual(audit["pending_url_hash"], mod._url_hash(entry))

    def test_pdf_http403_captcha_is_verification_not_subscription(self):
        source = f'{self.origin}/article?kind=captcha&popup=0'
        target = f'{self.origin}/doi/pdf/{DOI}?kind=captcha'
        record = {'paper_id': 'CDP-CAPTCHA', 'title': TITLE, 'doi': DOI, 'source_url': source}
        self.assertEqual(self.fetcher.fetch_page(source, {'record': record})['status'], 'ok')
        out = self.base / 'job' / 'blocked.pdf'
        result = self.fetcher.fetch_pdf(target, out, {'record': record})
        self.assertEqual((result['status'], result['reason']), ('attention', 'verification'))
        self.assertFalse(out.exists())
        self.assertFalse(self.fetcher._page.is_closed())

    def test_second_cdp_attach_while_attachment_is_transferring(self):
        def attach_late():
            try:
                if not self.server_started_file.wait(15):
                    raise RuntimeError("Fixture file transfer did not start")
                with sync_playwright() as secondary_playwright:
                    second = secondary_playwright.chromium.connect_over_cdp(self.cdp_url)
                    self.events.append({"event": "secondary_attach", "contexts": len(second.contexts),
                        "pages": len(second.contexts[0].pages)})
            except Exception as error:
                self.events.append({"event": "secondary_attach_error", "type": type(error).__name__})
            finally:
                self.secondary_done.set()
        self.secondary = threading.Thread(target=attach_late, daemon=True)
        self.secondary.start()
        self.acquire("slow", popup=True)
        self.secondary.join(8)
        self.assertTrue(any(item["event"] == "secondary_attach" for item in self.events), self.events)

    def test_original_format_supplements_download_and_reuse_through_production_collector(self):
        from openpyxl import Workbook
        from test_literature_materials import docx_blob
        workbook = Workbook()
        workbook.active.append(["Temperature", "Response"])
        workbook.active.append([35, 12.5])
        sheet = io.BytesIO()
        workbook.save(sheet)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            output.writestr("data.csv", "Temperature,Response\n35,12.5\n")
        self.material_blobs = {"pdf": PDF, "docx": docx_blob(), "xlsx": sheet.getvalue(), "zip": archive.getvalue()}
        observer = self.browser.new_browser_cdp_session()
        observer.on("Browser.downloadWillBegin", lambda item: self.events.append({"event": "browser_download_begin",
            "filename": item.get("suggestedFilename"), "frame_id": item.get("frameId")}))
        observer.on("Browser.downloadProgress", lambda item: self.events.append({"event": "browser_download_progress",
            "state": item.get("state"), "received": item.get("receivedBytes"), "total": item.get("totalBytes")}))
        if os.environ.get("LITERATURE_CDP_OBSERVE_DOWNLOADS") == "1":
            observer.send("Browser.setDownloadBehavior", {"behavior": "allowAndName", "downloadPath": str(self.base / "isolated-download-observation"),
                                                          "eventsEnabled": True})
        source = self.origin + "/materials/article"
        record = {"paper_id": "CDP-MATERIALS", "title": TITLE, "doi": DOI, "source_url": source}
        result = self.fetcher.fetch_page(source, {"record": record})
        self.assertEqual(result["status"], "ok", self.events)
        parent = self.fetcher._page
        discovery = self.fetcher.capture_material_discovery(record)
        self.assertEqual(discovery["status"], "checked")
        self.assertEqual(len(discovery["links"]), 4)
        store = MaterialsStore(self.base / "job", [record])
        closed = []
        original_complete = self.fetcher.complete_material
        def after_durable_save():
            flow = dict(self.fetcher._binding.get("material_flow") or {})
            persisted = json.loads(store.path.read_text(encoding="utf-8"))
            material = next(item for item in persisted["papers"][0]["materials"] if item["material_id"] == flow["material_id"])
            self.assertEqual(material["download_status"], "downloaded")
            actual = (store.job_dir / material["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(actual).hexdigest(), material["sha256"])
            child = self.fetcher._find_target_page(flow.get("child_target_id")) if flow.get("child_target_id") else None
            was_open = child is not None and not child.is_closed()
            outcome = original_complete()
            self.assertTrue(outcome["closed"])
            self.assertTrue(child is None or child.is_closed())
            closed.append({"format": material["format"], "bytes": len(actual), "child_was_open": was_open,
                           "manifest_saved_before_close": True})
            return outcome
        self.fetcher.complete_material = after_durable_save
        collector = MaterialCollection(store, record, self.fetcher, lambda: {"status": "ok"})
        started = time.monotonic()
        attention = collector.observe(discovery)
        self.assertIsNone(attention, (attention, self.events))
        saved = store.paper(record)["materials"]
        self.assertEqual(len(saved), 4)
        for item in saved:
            ext = Path(item["filename"]).suffix.lstrip(".")
            self.assertEqual((store.job_dir / item["path"]).read_bytes(), self.material_blobs[ext])
            self.assertEqual(item["download_status"], "downloaded")
            self.assertEqual(item["format"], ext)
        downloads = sum(event["event"] == "download" for event in self.events)
        self.assertEqual(downloads, 4, self.events)
        self.assertGreaterEqual(time.monotonic() - started, 1.2)
        self.assertEqual(len(closed), 4)
        self.assertTrue(any(item["format"] == "xlsx" and item["child_was_open"] for item in closed))
        self.assertFalse(parent.is_closed())
        before = sum(event["event"] == "http" for event in self.events)
        reopened_store = MaterialsStore(store.job_dir, [record])
        again = MaterialCollection(reopened_store, record, self.fetcher,
            lambda: self.fail("Verified local originals must be reused before browser acquisition"))
        self.assertIsNone(again.observe(discovery))
        self.assertEqual(sum(event["event"] == "http" for event in self.events), before)
        self.assertEqual(sum(event["event"] == "download" for event in self.events), downloads)
        self.assertTrue(self.fetcher.complete_paper()["closed"])
        self.assertTrue(parent.is_closed())
        self.events.append({"event": "material_integration_verified", "formats": sorted(self.material_blobs),
            "downloads": downloads, "delayed_generation": True, "byte_identical": True,
            "reuse_new_http_requests": 0, "saved_before_cleanup": closed, "article_closed_after_complete": True})


if __name__ == "__main__":
    unittest.main()
