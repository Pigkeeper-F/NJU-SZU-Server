"""Offline, owned fake pages only; no browser, source, or model requests."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import literature_cnki_fulltext as cnki
import literature_fulltext_browser as browser
import literature_metadata as metadata
import test_literature_cnki_fulltext as fixtures
from test_literature_metadata import row, snapshot
from test_literature_fulltext_verification import snapshot as dom_snapshot


ROOT = Path(__file__).resolve().parents[1]
OPTS = {"metadata_only": True, "metadata_timeout_sec": 30}


class MetadataOnlyFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.clock = fixtures.Clock()
        self.context = fixtures.Context(self.clock)

    def fetcher(self):
        fetcher = browser.FulltextBrowserFetcher({}, self.path, runtime_factory=self.context.runtime,
            clock=self.clock.time, sleep=self.clock.sleep)
        fetcher._observe_materials = Mock(side_effect=AssertionError("metadata cannot inspect materials"))
        fetcher._read_download = Mock(side_effect=AssertionError("metadata cannot read files"))
        return fetcher

    def test_verified_detail_returns_before_material_scan_or_pdf_click(self):
        fetcher = self.fetcher()
        result = cnki.run_cnki(fetcher, fixtures.RECORD, OPTS)
        self.assertTrue(result["metadata_only"])
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("bytes", result)
        self.assertEqual(fetcher._page.title_clicks, 1)
        self.assertEqual(fetcher._page.download_clicks, 0)
        fetcher._observe_materials.assert_not_called()
        fetcher._read_download.assert_not_called()
        self.assertFalse(self.context.pages[0].gotos)

    def test_title_popup_is_owned_and_has_no_download_side_effect(self):
        def setup(page):
            def open_detail(owner):
                child = self.context.new_page(opener=owner)
                child.detail(child)
                owner.emit("popup", child)
            page.on_title = open_detail
        self.context.next_setup = setup
        fetcher = self.fetcher()
        self.assertTrue(cnki.run_cnki(fetcher, fixtures.RECORD, OPTS)["metadata_only"])
        self.assertEqual(fetcher._page.target, "owned-2")
        self.assertEqual(sum(p.download_clicks for p in self.context.pages), 0)
        fetcher._observe_materials.assert_not_called()

    def test_title_download_is_cancelled_never_read_or_saved(self):
        download = fixtures.Download()
        download.cancel = Mock()
        def setup(page):
            page.on_title = lambda p: p.emit("download", download)
        self.context.next_setup = setup
        fetcher = self.fetcher()
        result = cnki.run_cnki(fetcher, fixtures.RECORD, OPTS)
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("bytes", result)
        download.cancel.assert_called_once()
        fetcher._read_download.assert_not_called()
        fetcher._observe_materials.assert_not_called()

    def test_download_resume_is_refused_without_connecting_or_replaying(self):
        fetcher = self.fetcher()
        fetcher._binding["cnki_flow"] = {"step": "download_clicked"}
        result = cnki.run_cnki(fetcher, fixtures.RECORD, OPTS)
        self.assertEqual(result["reason"], "page_error")
        self.assertEqual(self.context.creates, 0)
        self.assertEqual(fetcher._binding["cnki_flow"]["step"], "download_clicked")

    def test_metadata_budget_cannot_shorten_interval_or_start_late_click(self):
        fetcher = self.fetcher()
        result = cnki.run_cnki(fetcher, fixtures.RECORD, {**OPTS, "metadata_timeout_sec": 2})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertEqual(fetcher._page.title_clicks, 0)
        self.assertLess(self.clock.now, 1002)

    def test_empty_lookup_times_out_at_metadata_budget(self):
        self.context.initial_ui = fixtures.ui(count=0)
        self.context.next_setup = lambda page: setattr(page, "wait_for_timeout", lambda ms: self.clock.sleep(ms/1000))
        result = cnki.run_cnki(self.fetcher(), fixtures.RECORD, {**OPTS, "metadata_timeout_sec": 2})
        self.assertEqual(result["reason"], "page_not_ready")
        self.assertLessEqual(self.clock.now, 1002.001)

    def test_safety_verification_stops_and_resumes_same_page(self):
        def setup(page):
            def challenge(p):
                p.detail(p)
                p.snap["text"] = "安全验证 请拖动滑块完成验证"
                p.snap["verification"] = True  # shared snapshot detector
            page.on_title = challenge
        self.context.next_setup = setup
        first = self.fetcher()
        self.assertEqual(cnki.run_cnki(first, fixtures.RECORD, OPTS)["reason"], "verification")
        page = first._page
        page.snap["text"] = "中国知网"
        page.snap["verification"] = False
        first.close()
        second = self.fetcher()
        self.assertTrue(cnki.run_cnki(second, fixtures.RECORD, OPTS)["metadata_only"])
        self.assertEqual(len(page.gotos), 1)
        self.assertEqual(page.title_clicks, 1)
        self.assertEqual(page.download_clicks, 0)

    def test_different_title_never_returns_verified_detail(self):
        def setup(page):
            def wrong(p):
                p.detail(p)
                p.snap["citation_title"] = "Different paper"
                p.ui["titles"] = ["Different paper"]
            page.on_title = wrong
            page.wait_for_timeout = lambda ms: self.clock.sleep(ms/1000)
        self.context.next_setup = setup
        result = cnki.run_cnki(self.fetcher(), fixtures.RECORD, OPTS)
        self.assertEqual(result["status"], "attention")
        self.assertNotIn("metadata_only", result)
        self.assertEqual(self.context.pages[-1].download_clicks, 0)


class MetadataRecordTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT)
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.record = row(source_key="cnki", doi="", result_url="https://kns.cnki.net/kcms2/article/abstract?v=old")

    def reader(self, snapshots):
        clock = [0.0]
        snapshots = list(snapshots)
        page = SimpleNamespace(url="https://kns.cnki.net/kcms2/article/abstract?v=fresh",
            on=Mock(), remove_listener=Mock(), goto=Mock(side_effect=AssertionError("must retain opened detail")))
        def evaluate(script):
            self.assertIn("literature_metadata_snapshot", script)
            return copy.deepcopy(snapshots.pop(0) if len(snapshots) > 1 else snapshots[0])
        page.evaluate = evaluate
        page.wait_for_timeout = lambda ms: clock.__setitem__(0, clock[0]+ms/1000)
        fetcher = metadata.MetadataBrowserFetcher.__new__(metadata.MetadataBrowserFetcher)
        fetcher.browser = SimpleNamespace(_page=page, _blocked=None, _reason=browser.FulltextBrowserFetcher._reason,
            fetch_cnki=Mock(return_value={"status": "ok", "metadata_only": True, "url": page.url}))
        return fetcher, clock, page

    def test_old_url_relocated_and_async_identity_waited_without_regoto(self):
        empty = {"ready_state": "complete", "title": ""}
        final = {**snapshot(self.record), "ready_state": "complete"}
        fetcher, clock, page = self.reader([empty, empty, empty, final, final, final])
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "verified")
        self.assertGreaterEqual(clock[0], 2.5)
        actual_record, opts = fetcher.browser.fetch_cnki.call_args.args
        self.assertEqual(actual_record["source_candidate_id"], self.record["candidate_id"])
        self.assertEqual(opts, {"metadata_only": True, "metadata_timeout_sec": 5})
        page.goto.assert_not_called()

    def test_stable_empty_or_title_only_page_is_retryable_not_mismatch(self):
        for title in ("", self.record["title"]):
            fetcher, clock, _ = self.reader([{"ready_state": "complete", "title": title}])
            with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
                result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=2)
            self.assertEqual(result["status"], "attention")
            self.assertEqual(result["reason"], "page_not_ready")
            self.assertNotIn("snapshot", result)

    def test_locator_success_cannot_bypass_strict_author_identity(self):
        value = {**snapshot(self.record, authors=["Other author"]), "ready_state": "complete"}
        fetcher, clock, _ = self.reader([value])
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "identity_mismatch")

    def test_complete_ahead_of_print_detail_is_pending_not_perpetually_loading(self):
        value = {**snapshot(self.record), "doi": "", "year": "", "source_identifiers": {}, "ready_state": "complete"}
        fetcher, clock, page = self.reader([value])
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["metadata_diagnostic"]["identity_ready"])
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "identity_mismatch")
        page.goto.assert_not_called()

    def test_official_url_id_can_establish_page_readiness_but_not_candidate_identity(self):
        value = {**snapshot(self.record), "doi": "", "year": "", "authors": [], "source_identifiers": {}, "ready_state": "complete"}
        fetcher, clock, page = self.reader([value])
        page.url = "https://kns.cnki.net/kcms/detail/detail.aspx?dbcode=CJFD&dbname=CJFD2026&filename=TEST202601001"
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["metadata_diagnostic"]["source_id_present"])
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "identity_mismatch")

    def test_dedicated_author_list_does_not_include_affiliation_links(self):
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
            url="https://kns.cnki.net/kcms2/article/abstract?v=fixture",
            nodes={"author1": {"text": "唐如雪"}, "author2": {"text": "张卢军"},
                   "institution": {"text": "南京农业大学动物科技学院"}, "date": {"text": "2026,58(11)"}},
            map={"#authorpart a": ["author1", "author2"],
                 ".wx-tit .author a": ["author1", "author2", "institution"], ".top-tip": ["date"]})
        self.assertEqual(data["authors"], ["唐如雪", "张卢军"])
        self.assertEqual(data["year"], "2026")

    def test_original_cnki_abstract_expands_once_before_validation(self):
        full = {**snapshot(self.record), "ready_state": "complete"}
        clipped = {**full, "abstract": full["abstract"][:50] + "..."}
        fetcher, clock, page = self.reader([clipped])
        control = SimpleNamespace(count=lambda: 1, is_visible=lambda: True, inner_text=lambda **kwargs: " 更多 ", click=Mock())
        page.locator = Mock(return_value=control)
        page.evaluate = lambda script: copy.deepcopy(full if control.click.called else clipped)
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        control.click.assert_called_once()
        page.locator.assert_called_once_with("#ChDivSummaryMore")
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "verified")

    def test_unrelated_text_on_abstract_control_cannot_trigger_a_click(self):
        value = {**snapshot(self.record), "abstract_complete": False, "ready_state": "complete"}
        fetcher, clock, page = self.reader([value])
        control = SimpleNamespace(count=lambda: 1, is_visible=lambda: True, inner_text=lambda **kwargs: "PDF下载", click=Mock())
        page.locator = Mock(return_value=control)
        with patch.object(metadata.time, "monotonic", side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record["result_url"], timeout_sec=5)
        control.click.assert_not_called()
        self.assertEqual(metadata.verify_snapshot(self.record, result["snapshot"], result["url"])["status"], "abstract_incomplete")

    def test_metadata_diagnostic_is_persisted_without_page_text_or_tokens(self):
        (self.path / "candidates.json").write_text(json.dumps({"records": [self.record]}), encoding="utf-8")
        diagnostic = {"phase": "metadata", "polls": 3, "ready_state": "complete", "identity_ready": False,
                      "title_present": True, "url": "https://secret.test/?token=hidden", "text": "private page"}
        fetcher = SimpleNamespace(fetch_record=Mock(return_value={"status": "attention", "reason": "page_not_ready",
            "metadata_diagnostic": diagnostic}))
        metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        state = metadata.read_status(self.path)
        saved = state["last_metadata_diagnostic"]
        self.assertEqual(saved["polls"], 3)
        self.assertNotIn("url", saved)
        self.assertNotIn("text", saved)
        self.assertEqual(state["items"][self.record["candidate_id"]]["metadata_diagnostic"], saved)

    def test_verification_returns_immediately_without_metadata_read(self):
        fetcher, clock, page = self.reader([])
        fetcher.browser.fetch_cnki.return_value = {"status": "attention", "reason": "verification"}
        self.assertEqual(fetcher.fetch_record(self.record, self.record["result_url"])["reason"], "verification")
        page.on.assert_not_called()

    def test_metadata_snapshot_cnki_challenge_requires_official_verify_page(self):
        script = """const vm=require('node:vm'),fs=require('node:fs');
const {source,cases}=JSON.parse(fs.readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(c=>{
  const document={title:'',readyState:'complete',body:{innerText:c.text},querySelectorAll:()=>[]};
  return vm.runInNewContext('('+source+')()', {document,location:new URL(c.url)}).verification;
})));"""
        cases = [
            {"url": "https://kns.cnki.net/verify/home", "text": "安全验证 请拖动滑块"},
            {"url": "https://kns.cnki.net/kcms2/article/abstract", "text": "本文探讨安全验证的实现方法"},
            {"url": "https://cnki.net.evil.test/verify/home", "text": "安全验证 请拖动滑块"},
            {"url": "https://kns.cnki.net/verify/home", "text": "页面正在加载"},
        ]
        result = subprocess.run(["node", "-e", script], input=json.dumps({"source": metadata.METADATA_SNAPSHOT_JS, "cases": cases}),
            capture_output=True, text=True, encoding="utf-8", check=True)
        self.assertEqual(json.loads(result.stdout), [True, False, False, True])

    def test_metadata_snapshot_uses_shared_active_challenge_detection(self):
        self.assertIn(browser._VERIFICATION_FUNCTION_JS, metadata.METADATA_SNAPSHOT_JS)
        for selector in ('.geetest_panel', '.verifybox', '#captcha', '.captcha'):
            with self.subTest(selector=selector):
                data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
                    body='个人登录\n南京大学\n共找到 1 条结果',
                    nodes={'shell': {'width': 320, 'height': 180}}, map={selector: ['shell']})
                self.assertFalse(data['verification'])
                self.assertEqual(data['verification_evidence'], [])
        for nodes, mapping in (
            ({'shell': {'text': '请拖动滑块完成验证', 'parent': 'hidden'},
              'hidden': {'style': {'opacity': '0'}}}, {'.captcha': ['shell']}),
            ({'frame': {'tagName': 'IFRAME', 'width': 1, 'height': 1}},
             {'iframe[src*="recaptcha"]': ['frame']}),
        ):
            data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS, nodes=nodes, map=mapping)
            self.assertFalse(data['verification'])
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
            nodes={'shell': {'text': '请拖动滑块完成验证'}}, map={'.captcha': ['shell']})
        self.assertTrue(data['verification'])
        self.assertIn('visible_challenge_widget:.captcha', data['verification_evidence'])
        # A result page may retain a stale challenge title and hidden preloaded
        # challenge text. Neither establishes a currently visible challenge.
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
            title='安全验证 - 中国知网',
            body='个人登录\n南京大学\n共找到 1 条结果\n热应激对蛋鸡生产性能的影响',
            nodes={'label': {'text': '安全验证', 'parent': 'hidden'},
                   'shell': {'text': '请拖动滑块完成验证', 'parent': 'hidden'},
                   'hidden': {'style': {'opacity': '0'}}},
            map={'h2': ['label'], '.captcha': ['shell']})
        self.assertFalse(data['verification'])
        self.assertEqual(data['verification_evidence'], [])

    def test_metadata_challenge_h1_is_not_bibliographic_identity(self):
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
            nodes={'heading': {'text': '安全验证'}}, map={'h1': ['heading']})
        self.assertTrue(data['verification'])
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS, title='安全验证', body='安全验证',
            nodes={'citation': {'name': 'citation_title', 'content': '安全验证'}}, map={'meta': ['citation']})
        self.assertFalse(data['verification'])
        data = dom_snapshot(script=metadata.METADATA_SNAPSHOT_JS,
            nodes={'citation': {'name': 'citation_title', 'content': 'A research paper'},
                   'shell': {'text': '请拖动滑块完成验证'}},
            map={'meta': ['citation'], '.captcha': ['shell']})
        self.assertTrue(data['verification'])

    def test_second_metadata_read_preserves_only_allowlisted_verification_evidence(self):
        fetcher, clock, page = self.reader([{'verification': True, 'verification_evidence': [
            'cnki_verify_route', 'https://kns.cnki.net/verify/home?v=private',
            {'token': 'private'}, 'cnki_verify_route', 'visible_challenge_widget:.captcha']}])
        with patch.object(metadata.time, 'monotonic', side_effect=lambda: clock[0]):
            result = fetcher.fetch_record(self.record, self.record['result_url'])
        self.assertEqual(result['reason'], 'verification')
        self.assertEqual(result['verification_evidence'], ['cnki_verify_route', 'visible_challenge_widget:.captcha'])
        self.assertEqual(fetcher.browser._blocked['reason'], 'verification')
        self.assertEqual(fetcher.browser._blocked['verification_evidence'], result['verification_evidence'])

    def test_verification_evidence_is_sanitized_persisted_and_cleared_on_resume(self):
        (self.path / 'candidates.json').write_text(json.dumps({'records': [self.record]}), encoding='utf-8')
        fetcher = SimpleNamespace(fetch_record=Mock(return_value={'status': 'attention', 'reason': 'verification',
            'verification_evidence': ['visible_challenge_widget:.captcha', 'private-token',
                                      {'url': 'https://example.test/?v=private'}, 'visible_challenge_widget:.captcha']}))
        first = metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        safe = ['visible_challenge_widget:.captcha']
        self.assertEqual(first['verification_evidence'], safe)
        state = metadata.read_status(self.path)
        self.assertEqual(state['last_verification_evidence'], safe)
        self.assertEqual(state['items'][self.record['candidate_id']]['verification_evidence'], safe)
        self.assertEqual(state['items'][self.record['candidate_id']]['attempts'][-1]['verification_evidence'], safe)
        stored = json.dumps(state)
        self.assertNotIn('private-token', stored)
        self.assertNotIn('example.test', stored)
        blocked = metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        self.assertEqual(blocked['verification_evidence'], safe)
        self.assertEqual(fetcher.fetch_record.call_count, 1)
        fetcher.fetch_record.return_value = {'status': 'ok', 'url': self.record['result_url'], 'snapshot': snapshot(self.record)}
        resumed = metadata.run({}, self.path, fetcher=fetcher, retry_attention=True, on_event=lambda *a, **k: None)
        self.assertEqual(resumed['counts']['verified'], 1)
        self.assertNotIn('verification_evidence', resumed)
        state = metadata.read_status(self.path)
        self.assertEqual(state['last_verification_evidence'], [])
        self.assertNotIn('verification_evidence', state['items'][self.record['candidate_id']])
        self.assertEqual(state['history'][-1]['verification_evidence'], safe)

    def test_not_ready_stops_next_record_and_normal_resume_keeps_history(self):
        records = [self.record, {**self.record, "candidate_id": "R2"}]
        (self.path / "candidates.json").write_text(json.dumps({"records": records}), encoding="utf-8")
        fetcher = SimpleNamespace(fetch_record=Mock(return_value={"status": "attention", "reason": "page_not_ready"}))
        result = metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        self.assertFalse(result["complete"])
        self.assertEqual(result["counts"]["pending"], 2)
        self.assertEqual(fetcher.fetch_record.call_count, 1)
        fetcher.fetch_record.return_value = {"status": "ok", "url": self.record["result_url"], "snapshot": snapshot(self.record)}
        result = metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        self.assertTrue(result["complete"])
        self.assertEqual(result["counts"]["verified"], 2)
        self.assertEqual(metadata.read_status(self.path)["history"][0]["reason"], "page_not_ready")

    def test_legacy_empty_mismatch_needs_explicit_retry_and_keeps_history(self):
        (self.path / "candidates.json").write_text(json.dumps({"records": [self.record]}), encoding="utf-8")
        old = {"candidate_id": "R1", "record_sha256": metadata.record_hash(self.record),
            "status": "identity_mismatch", "reason": "article_identity_not_verified", "observed_identity": {"title": ""}}
        metadata.common.atomic_write_json(self.path / "metadata" / "status.json",
            {"version": metadata.VERSION, "items": {"R1": old}, "history": []})
        fetcher = SimpleNamespace(fetch_record=Mock(return_value={"status": "ok", "url": self.record["result_url"], "snapshot": snapshot(self.record)}))
        metadata.run({}, self.path, fetcher=fetcher, on_event=lambda *a, **k: None)
        fetcher.fetch_record.assert_not_called()
        result = metadata.run({}, self.path, fetcher=fetcher, retry_attention=True, on_event=lambda *a, **k: None)
        self.assertEqual(result["counts"]["verified"], 1)
        self.assertEqual(metadata.read_status(self.path)["history"], [old])

    def test_explicit_resume_does_not_retry_actual_identity_conflict(self):
        (self.path / "candidates.json").write_text(json.dumps({"records": [self.record]}), encoding="utf-8")
        old = {"candidate_id": "R1", "record_sha256": metadata.record_hash(self.record),
            "status": "identity_mismatch", "reason": "article_identity_not_verified", "observed_identity": {"title": "different"}}
        metadata.common.atomic_write_json(self.path / "metadata" / "status.json",
            {"version": metadata.VERSION, "items": {"R1": old}, "history": []})
        fetcher = SimpleNamespace(fetch_record=Mock())
        metadata.run({}, self.path, fetcher=fetcher, retry_attention=True, on_event=lambda *a, **k: None)
        fetcher.fetch_record.assert_not_called()
        self.assertEqual(metadata.read_status(self.path)["history"], [])


if __name__ == "__main__":
    unittest.main()
