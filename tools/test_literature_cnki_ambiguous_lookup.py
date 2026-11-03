"""Offline, serial detail inspection of incomplete same-title CNKI rows."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

import literature_cnki_fulltext as cnki
import literature_fulltext_browser as browser
from test_literature_cnki_fulltext import Clock, Context, Locator, ui, version_record, version_rows
from test_literature_metadata import ABSTRACT


ROOT = Path(__file__).resolve().parents[1]


class RowLocator(Locator):
    """Preserve the real visible row selected by the production locator chain."""
    def nth(self, index):
        return RowLocator(self.page, self.selector, index, self.row)

    def locator(self, selector):
        if self.selector not in cnki.ROWS or selector != "a":
            raise AssertionError((self.selector, selector))
        return RowLocator(self.page, selector, row=self.index)

    def click(self, **options):
        if self.selector != "a":
            return super().click(**options)
        if options.get("no_wait_after") is not True:
            raise AssertionError(options)
        self.page.title_clicks += 1
        self.page.open_row(self.row)


class AmbiguousLookupTests(unittest.TestCase):
    def setUp(self):
        temp_root = ROOT / ".tmp-literature-tests"
        temp_root.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "job"
        self.clock = Clock()
        self.context = Context(self.clock)
        self.record = version_record()
        self.context.initial_ui = version_rows()
        self.context.initial_ui["lookup_complete"] = True
        # Row titles are complete; both versions lack usable row identity.
        # The detail, rather than the incomplete row, must decide the version.
        for row in self.context.initial_ui["rows"]:
            row.update(authors="", authors_complete=False, year="")
        self.clicks, self.details, self.max_active_details = [], [], 0
        self.versions = [
            {"year": "2025", "authors": ["另一位作者"]},
            {"year": "2026", "authors": self.record["authors"].split(";")},
        ]
        self.owner = None
        self.after_open = None
        self.context.next_setup = self.setup_lookup

    def setup_lookup(self, page):
        self.owner = page
        original_goto = page.goto

        def goto(url, **options):
            response = original_goto(url, **options)
            page.snap.update(ready_state="complete", loading_pending=False, download_pending=False)
            return response

        page.goto = goto
        page.locator = lambda selector: RowLocator(page, selector)
        page.open_row = self.open_row

    def open_row(self, index):
        self.clicks.append(index)
        version = copy.deepcopy(self.versions[index])
        child = self.context.new_page(opener=self.owner)
        child.url = version.pop("url", "https://kns.cnki.net/kcms2/article/abstract?v=fixture-" + str(index))
        title = version.pop("title", self.record["title"])
        child.ui = ui(title=title, query=self.record["title"])
        metadata = {"title": title, "year": version.pop("year", "2026"),
            "authors": version.pop("authors", self.record["authors"].split(";")),
            "abstract": ABSTRACT, "abstract_method": "explicit_abstract_dom",
            "abstract_complete": True, "ready_state": "complete", "loading_pending": False,
            "verification": False, "keywords": ["heat stress", "growth"], **version}
        child.metadata = metadata
        child.snapshot_reads = child.metadata_reads = 0
        child.snap.update(citation_title=title, citation_authors=metadata["authors"],
            citation_year=metadata["year"], citation_date=metadata["year"],
            ready_state=metadata["ready_state"], loading_pending=metadata["loading_pending"],
            verification=metadata["verification"])
        original_evaluate = child.evaluate

        def evaluate(script):
            if "literature_metadata_snapshot" in script:
                child.metadata_reads += 1
                return copy.deepcopy(child.metadata)
            if "literature_fulltext_snapshot" in script:
                child.snapshot_reads += 1
            return original_evaluate(script)

        child.evaluate = evaluate
        self.details.append(child)
        self.max_active_details = max(self.max_active_details,
            sum(not item.closed for item in self.details))
        self.owner.emit("popup", child)
        if self.after_open:
            self.after_open(child, index)

    def fetcher(self):
        fetcher = browser.FulltextBrowserFetcher({}, self.path,
            runtime_factory=self.context.runtime, clock=self.clock.time, sleep=self.clock.sleep)
        self.addCleanup(fetcher.close)
        return fetcher

    def run_lookup(self, *, fetcher=None, enabled=True, timeout_sec=120, manual_resume=False):
        fetcher = fetcher or self.fetcher()
        opts = {"metadata_only": True, "metadata_timeout_sec": timeout_sec}
        if enabled:
            opts["cnki_probe_versions"] = True
        if manual_resume:
            opts["cnki_manual_resume"] = True
        return fetcher, cnki.run_cnki(fetcher, self.record, opts)

    def assert_no_downloads(self):
        self.assertFalse(self.context.pages[0].closed)
        self.assertFalse(self.context.pages[0].gotos)
        self.assertTrue(all(item.download_clicks == 0 for item in self.context.pages))

    def test_initial_ambiguous_rows_are_opened_serially_then_unique_version_selected(self):
        fetcher, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertTrue(result.get("metadata_only"))
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertEqual(self.max_active_details, 1)
        self.assertTrue(all(item.closed for item in self.details[:-1]))
        self.assertIs(fetcher._page, self.details[-1])
        self.assertFalse(self.details[-1].closed)
        self.assertFalse(self.owner.closed)
        self.assertTrue(all(item.metadata_reads for item in self.details[:-1]))
        self.assert_no_downloads()
        # These are identity outcomes, never exclusions under study criteria.
        persisted = json.loads((self.path / "fulltext-browser.json").read_text(encoding="utf-8"))
        probe = persisted["cnki_flow"]["version_probe"]
        self.assertEqual([row["status"] for row in probe["rows"]], ["mismatch", "match"])
        self.assertEqual(probe["parent_target_id"], self.owner.target)
        self.assertNotIn(ABSTRACT, json.dumps(persisted, ensure_ascii=False))
        self.assertTrue(fetcher.complete_paper().get("closed"))
        self.assertTrue(self.owner.closed)
        self.assertTrue(self.details[-1].closed)
        self.assert_no_downloads()

    def test_correct_first_version_is_not_selected_until_second_is_checked(self):
        self.versions.reverse()
        fetcher, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 0])
        self.assertEqual(self.max_active_details, 1)
        self.assertTrue(all(item.closed for item in self.details[:-1]))
        self.assert_no_downloads()

    def test_two_strong_matches_are_not_guessed(self):
        self.versions[0] = copy.deepcopy(self.versions[1])
        fetcher, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous", result)
        self.assertEqual(self.clicks, [0, 1])
        self.assertIs(fetcher._page, self.owner)
        self.assertFalse(self.owner.closed)
        self.assertTrue(all(item.closed for item in self.details))
        self.assert_no_downloads()

    def test_disabled_probe_never_opens_the_ambiguous_rows(self):
        _, result = self.run_lookup(enabled=False)
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous", result)
        self.assertEqual(self.clicks, [])
        self.assertEqual(self.details, [])
        self.assert_no_downloads()

    def test_other_visible_title_is_not_opened_during_version_probe(self):
        other = copy.deepcopy(self.context.initial_ui["rows"][0])
        other["index"] = 2
        other["anchors"][0]["text"] = "另一个完全不同的试验"
        self.context.initial_ui["rows"].append(other)
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assert_no_downloads()

    def test_unofficial_popup_is_not_read_as_a_detail_or_replaced(self):
        self.versions[0]["url"] = "https://publisher.example/unrelated"
        _, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0])
        self.assertFalse(self.owner.closed)
        self.assertFalse(self.details[0].closed)
        self.assertEqual(self.details[0].metadata_reads, 0)
        self.assert_no_downloads()

    def test_challenge_preserves_current_detail_and_resume_does_not_reclick(self):
        self.versions[0]["verification"] = True
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        self.assertEqual(self.clicks, [0])
        child = self.details[0]
        self.assertFalse(child.closed)
        self.assertFalse(self.owner.closed)
        first.close()
        child.snap["verification"] = child.metadata["verification"] = False
        second, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        self.assertIs(second._page, self.details[-1])
        self.assert_no_downloads()

    def test_loading_detail_is_preserved_and_resume_does_not_reclick(self):
        self.versions[0].update(ready_state="loading", loading_pending=True)
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        self.assertEqual(self.clicks, [0])
        child = self.details[0]
        self.assertFalse(child.closed)
        first.close()
        child.snap.update(ready_state="complete", loading_pending=False)
        child.metadata.update(ready_state="complete", loading_pending=False)
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        self.assert_no_downloads()

    def test_unknown_detail_identity_is_preserved_not_classified_as_mismatch(self):
        self.versions[0].update(year="", authors=[])
        _, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0])
        self.assertFalse(self.details[0].closed)
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_second_unknown_version_prevents_selection_of_a_first_strong_match(self):
        self.versions[0] = copy.deepcopy(self.versions[1])
        self.versions[1].update(year="", authors=[])
        _, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1])
        self.assertTrue(self.details[0].closed)
        self.assertFalse(self.details[1].closed)
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_reopened_winner_must_still_match_its_saved_identity(self):
        def change_winner(child, index):
            if len(self.details) == 3:
                child.metadata["authors"] = ["重开后变化的作者"]
                child.snap["citation_authors"] = ["重开后变化的作者"]
        self.after_open = change_winner
        _, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertFalse(self.owner.closed)
        self.assertFalse(self.details[-1].closed)
        self.assert_no_downloads()

    def test_incomplete_lookup_coverage_does_not_open_any_version(self):
        self.context.initial_ui["lookup_complete"] = False
        _, result = self.run_lookup()
        self.assertEqual(result.get("lookup_diagnostic"), "ambiguous", result)
        self.assertEqual(self.clicks, [])
        self.assertEqual(self.details, [])
        self.assert_no_downloads()

    def test_result_rows_changed_during_probe_do_not_retarget_next_click(self):
        def reorder_after_open(child, index):
            if index == 0:
                self.owner.ui["rows"][1]["anchors"][0]["text"] = "被替换的结果"
        self.after_open = reorder_after_open
        _, result = self.run_lookup()
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0])
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_probe_identity_checkpoint_is_saved_before_temporary_detail_closes(self):
        closed_with_checkpoint = []

        def observe_close(child, index):
            original_close = child.close

            def close(**options):
                persisted = json.loads((self.path / "fulltext-browser.json").read_text(encoding="utf-8"))
                probe = persisted["cnki_flow"]["version_probe"]
                status = probe["rows"][index]["status"]
                self.assertIn(status, {"match", "mismatch"})
                closed_with_checkpoint.append((index, status))
                return original_close(**options)

            child.close = close

        self.after_open = observe_close
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(closed_with_checkpoint, [(0, "mismatch"), (1, "match")])
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assert_no_downloads()

    def test_failed_temporary_close_is_retried_without_reopening_the_same_version(self):
        close_attempts = []

        def fail_first_close(child, index):
            if len(self.details) != 1:
                return
            original_close = child.close

            def close(**options):
                close_attempts.append(child.target)
                if len(close_attempts) == 1:
                    raise RuntimeError("fixture temporary close failure")
                return original_close(**options)

            child.close = close

        self.after_open = fail_first_close
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        self.assertEqual(self.clicks, [0])
        child = self.details[0]
        self.assertFalse(child.closed)
        reads_before_resume = child.metadata_reads
        first.close()
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        # A resumed close performs one fresh identity/access check; it must
        # not reopen the version or reclassify its saved location verdict.
        self.assertEqual(child.metadata_reads, reads_before_resume + 1)
        self.assertGreaterEqual(len(close_attempts), 2)
        self.assert_no_downloads()

    def assert_closing_resume_preserves_changed_access(self, changes, reason):
        close_attempts = []

        def fail_first_close(child, index):
            if len(self.details) != 1:
                return
            original_close = child.close

            def close(**options):
                close_attempts.append(child.target)
                if len(close_attempts) == 1:
                    raise RuntimeError("fixture temporary close failure")
                return original_close(**options)

            child.close = close

        self.after_open = fail_first_close
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        child = self.details[0]
        saved = copy.deepcopy(first._binding["cnki_flow"]["version_probe"])
        self.assertEqual(saved["phase"], "closing")
        self.assertEqual(saved["rows"][0]["status"], "mismatch")
        self.assertEqual(close_attempts, [child.target])
        first.close()
        child.snap.update(changes)
        child.metadata.update(changes)
        protected, result = self.run_lookup()
        self.assertEqual(result.get("reason"), reason, result)
        self.assertEqual(self.clicks, [0])
        self.assertFalse(child.closed)
        self.assertFalse(self.owner.closed)
        self.assertEqual(close_attempts, [child.target])
        self.assertEqual(protected._binding["cnki_flow"]["version_probe"], saved)
        protected.close()
        for values in (child.snap, child.metadata):
            values.update(verification=False, login=False, ready_state="complete",
                          loading_pending=False, download_pending=False)
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        self.assertEqual(close_attempts, [child.target, child.target])
        self.assert_no_downloads()

    def test_closing_resume_keeps_new_verification_page_until_cleared(self):
        self.assert_closing_resume_preserves_changed_access({"verification": True}, "verification")

    def test_closing_resume_keeps_new_login_page_until_cleared(self):
        self.assert_closing_resume_preserves_changed_access({"login": True}, "login")

    def test_closing_resume_keeps_new_loading_page_until_ready(self):
        self.assert_closing_resume_preserves_changed_access(
            {"ready_state": "loading", "loading_pending": True}, "page_not_ready")

    def test_closing_resume_keeps_pending_download_until_settled(self):
        self.assert_closing_resume_preserves_changed_access({"download_pending": True}, "page_not_ready")

    def second_version_after_challenge(self, *, clear=True):
        self.versions[1]["verification"] = True
        first, result = self.run_lookup()
        self.assertEqual(result.get("reason"), "verification", result)
        self.assertEqual(self.clicks, [0, 1])
        self.assertTrue(self.details[0].closed)
        child = self.details[1]
        self.assertFalse(child.closed)
        flow = first._binding["cnki_flow"]
        self.assertEqual(flow["version_probe"]["active_index"], 1)
        self.assertTrue(flow["pending_popup"]["opener_verified"])
        self.assertTrue(flow["pending_popup"]["adopted"])
        self.assertEqual(flow["target_id"], child.target)
        first.close()
        child.opener = lambda: None
        if clear:
            child.snap["verification"] = child.metadata["verification"] = False
            self.versions[1]["verification"] = False
        return child

    def mutate_saved_binding(self, change):
        path = self.path / "fulltext-browser.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        change(value)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def assert_second_version_preserved(self, child, result):
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1])
        self.assertFalse(child.closed)
        self.assert_no_downloads()

    def test_explicit_resume_after_second_version_verification_lost_opener_continues_same_index(self):
        child = self.second_version_after_challenge()
        _, result = self.run_lookup(manual_resume=True)
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_lost_opener_without_explicit_resume_does_not_claim_second_version(self):
        child = self.second_version_after_challenge()
        _, result = self.run_lookup()
        self.assert_second_version_preserved(child, result)

    def persist_detached_recovery_then_interrupt_budget(self):
        child = self.second_version_after_challenge()
        fetcher = self.fetcher()
        original_write = fetcher._write_binding
        interrupted = []

        def write():
            original_write()
            probe = fetcher._binding.get("cnki_flow", {}).get("version_probe", {})
            if probe.get("opener_recovery") and not interrupted:
                interrupted.append(True)
                self.clock.sleep(121)

        fetcher._write_binding = write
        _, result = self.run_lookup(fetcher=fetcher, manual_resume=True)
        self.assertTrue(interrupted)
        self.assertEqual(result.get("reason"), "cnki_version_probe_budget", result)
        self.assertEqual(self.clicks, [0, 1])
        proof = fetcher._binding["cnki_flow"]["version_probe"]["opener_recovery"]
        self.assertEqual(proof["target_id"], child.target)
        self.assertEqual(proof["parent_target_id"], self.owner.target)
        self.assertFalse(child.closed)
        fetcher.close()
        return child

    def test_saved_detached_recovery_survives_budget_and_continues_without_new_explicit_resume(self):
        child = self.persist_detached_recovery_then_interrupt_budget()
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertTrue(child.closed)
        self.assert_no_downloads()

    def test_saved_detached_recovery_does_not_override_later_identity_change(self):
        child = self.persist_detached_recovery_then_interrupt_budget()
        child.snap["citation_authors"] = child.metadata["authors"] = ["预算中断后变化的作者"]
        _, result = self.run_lookup()
        self.assert_second_version_preserved(child, result)
        self.assertFalse(self.owner.closed)

    def test_open_current_shows_exact_adopted_probe_child_after_lost_opener_without_navigation(self):
        child = self.second_version_after_challenge()
        fetcher = self.fetcher()
        saved = copy.deepcopy(fetcher._binding)
        before = (len(self.context.pages), len(self.owner.gotos), list(self.clicks), child.fronts)
        result = fetcher.open_current()
        self.assertTrue(result.get("opened"), result)
        self.assertEqual((len(self.context.pages), len(self.owner.gotos), self.clicks), before[:3])
        self.assertEqual(child.fronts, before[3] + 1)
        self.assertEqual(fetcher._binding, saved)
        self.assertFalse(child.closed)
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_open_current_does_not_show_unadopted_detached_probe_child(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved["cnki_flow"]["pending_popup"].update(adopted=False))
        fetcher = self.fetcher()
        before = child.fronts
        result = fetcher.open_current()
        self.assertFalse(result.get("opened"), result)
        self.assertEqual(child.fronts, before)
        self.assertEqual(self.clicks, [0, 1])
        self.assertFalse(child.closed)
        self.assert_no_downloads()

    def test_open_current_does_not_show_probe_child_with_nonempty_other_opener(self):
        child = self.second_version_after_challenge()
        child.opener = lambda: self.context.pages[0]
        fetcher = self.fetcher()
        before = child.fronts
        result = fetcher.open_current()
        self.assertFalse(result.get("opened"), result)
        self.assertEqual(child.fronts, before)
        self.assertEqual(self.clicks, [0, 1])
        self.assertFalse(child.closed)
        self.assert_no_downloads()

    def test_lost_opener_with_unadopted_witness_cannot_claim_second_version(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved["cnki_flow"]["pending_popup"].update(adopted=False))
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_with_wrong_paper_flow_cannot_claim_second_version(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved["cnki_flow"].update(paper_hash="0" * 64))
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_with_wrong_title_flow_cannot_claim_second_version(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved["cnki_flow"].update(title_hash="0" * 64))
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_with_wrong_flow_target_cannot_claim_second_version(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved["cnki_flow"].update(target_id="researcher-existing"))
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_with_wrong_bound_target_cannot_claim_second_version(self):
        child = self.second_version_after_challenge()
        self.mutate_saved_binding(lambda saved: saved.update(target_id="researcher-existing"))
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_explicit_resume_does_not_override_nonempty_other_opener(self):
        child = self.second_version_after_challenge()
        child.opener = lambda: self.context.pages[0]
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_resume_keeps_remaining_verification(self):
        child = self.second_version_after_challenge(clear=False)
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)
        self.assertFalse(self.owner.closed)

    def test_lost_opener_resume_keeps_loading_second_version(self):
        child = self.second_version_after_challenge()
        child.snap.update(ready_state="loading", loading_pending=True)
        child.metadata.update(ready_state="loading", loading_pending=True)
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)
        self.assertFalse(self.owner.closed)

    def test_lost_opener_resume_requires_live_original_parent(self):
        child = self.second_version_after_challenge()
        self.owner.closed = True
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_manual_metadata_recovery_does_not_enable_pdf_mode(self):
        child = self.second_version_after_challenge()
        fetcher = self.fetcher()
        result = cnki.run_cnki(fetcher, self.record,
            {"cnki_manual_resume": True, "cnki_probe_versions": True})
        self.assert_second_version_preserved(child, result)

    def test_lost_opener_resume_checks_frozen_parent_query_and_rows(self):
        child = self.second_version_after_challenge()
        self.owner.ui["queries"] = ["另一个题名"]
        self.owner.ui["rows"][0]["anchors"][0]["text"] = "另一个检索结果"
        _, result = self.run_lookup(manual_resume=True)
        self.assert_second_version_preserved(child, result)

    def test_explicit_closing_resume_lost_opener_closes_existing_verified_child_only(self):
        close_attempts = []

        def fail_first_close(child, index):
            if len(self.details) != 1:
                return
            original_close = child.close

            def close(**options):
                close_attempts.append(child.target)
                if len(close_attempts) == 1:
                    raise RuntimeError("fixture close failure before lost opener")
                return original_close(**options)

            child.close = close

        self.after_open = fail_first_close
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        self.assertEqual(self.clicks, [0])
        child = self.details[0]
        self.assertEqual(first._binding["cnki_flow"]["version_probe"]["phase"], "closing")
        first.close()
        child.opener = lambda: None
        _, result = self.run_lookup(manual_resume=True)
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertEqual(close_attempts, [child.target, child.target])
        self.assertTrue(child.closed)
        self.assert_no_downloads()

    def test_explicit_closing_resume_lost_opener_rejects_changed_identity(self):
        def fail_close(child, index):
            if len(self.details) == 1:
                child.close = lambda **options: (_ for _ in ()).throw(RuntimeError("fixture close failure"))
        self.after_open = fail_close
        first, _ = self.run_lookup()
        child = self.details[0]
        first.close()
        child.opener = lambda: None
        child.metadata["authors"] = ["关闭断点后身份变化"]
        child.snap["citation_authors"] = ["关闭断点后身份变化"]
        _, result = self.run_lookup(manual_resume=True)
        self.assertNotEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0])
        self.assertFalse(child.closed)
        self.assertFalse(self.owner.closed)
        self.assert_no_downloads()

    def test_closed_probe_child_can_resume_saved_closing_phase_without_reopening(self):
        def interrupt_close(child, index):
            if len(self.details) == 1:
                child.close = lambda **options: (_ for _ in ()).throw(RuntimeError("fixture close interrupted"))
        self.after_open = interrupt_close
        first, blocked = self.run_lookup()
        self.assertNotEqual(blocked.get("status"), "ok", blocked)
        self.assertEqual(self.clicks, [0])
        child = self.details[0]
        reads = child.metadata_reads
        first.close()
        child.closed = True
        _, result = self.run_lookup()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertEqual(child.metadata_reads, reads)
        self.assert_no_downloads()

    def test_saved_checkpoints_increase_only_as_the_fixed_probe_queue_advances(self):
        fetcher = self.fetcher()
        original_write = fetcher._write_binding
        checkpoints = []

        def record_checkpoint():
            original_write()
            flow = copy.deepcopy(fetcher._binding.get("cnki_flow", {}))
            checkpoint = cnki._version_probe_checkpoint(flow)
            if checkpoint:
                checkpoints.append(checkpoint)
                self.assertEqual(checkpoint, cnki._version_probe_checkpoint(flow))

        fetcher._write_binding = record_checkpoint
        _, result = self.run_lookup(fetcher=fetcher)
        self.assertEqual(result.get("status"), "ok", result)
        self.assertGreater(len({item["step"] for item in checkpoints}), 4)
        self.assertEqual(len({item["key"] for item in checkpoints}), 1)
        self.assertEqual(len(checkpoints[0]["key"]), 64)
        self.assertEqual({item["max_steps"] for item in checkpoints}, {9})
        self.assertEqual([item["step"] for item in checkpoints],
            sorted(item["step"] for item in checkpoints))
        self.assertLessEqual(checkpoints[-1]["step"], 9)
        self.assert_no_downloads()

    def test_small_budgets_resume_fixed_probe_without_repeating_completed_clicks(self):
        first, result = self.run_lookup(timeout_sec=12)
        self.assertEqual(result.get("reason"), "cnki_version_probe_budget", result)
        initial_checkpoint = result.get("cnki_probe_checkpoint")
        self.assertIsInstance(initial_checkpoint, dict)
        first.close()
        no_progress, waiting = self.run_lookup(timeout_sec=0.1)
        self.assertEqual(waiting.get("reason"), "cnki_version_probe_budget", waiting)
        self.assertEqual(waiting.get("cnki_probe_checkpoint"), initial_checkpoint)
        no_progress.close()
        checkpoints = [initial_checkpoint]
        for _ in range(8):
            current, result = self.run_lookup(timeout_sec=12)
            if result.get("status") == "ok":
                break
            self.assertEqual(result.get("reason"), "cnki_version_probe_budget", result)
            checkpoints.append(result["cnki_probe_checkpoint"])
            current.close()
        self.assertEqual(result.get("status"), "ok", result)
        self.assertEqual(self.clicks, [0, 1, 1])
        self.assertEqual(len({item["key"] for item in checkpoints}), 1)
        self.assertEqual([item["step"] for item in checkpoints],
            sorted(item["step"] for item in checkpoints))
        self.assert_no_downloads()


if __name__ == "__main__":
    unittest.main()
