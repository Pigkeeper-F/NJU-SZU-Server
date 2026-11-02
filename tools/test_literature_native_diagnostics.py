"""Pure failure-diagnostic checks; no browser, job data or source requests."""
import unittest

from literature_native_diagnostics import diagnose_native_failure, native_failure


class NativeDiagnosticsTests(unittest.TestCase):
    def assert_code(self, payload, code):
        self.assertEqual(payload["reason"], "results_unrecognized")
        self.assertEqual(payload["diagnostics"]["native_failure_code"], code)
        self.assertIn("本轮未确认检索完成", payload["message"])

    def form(self):
        return {"editor": {"value": "private query"}, "button": {"index": 0}}

    def test_entry_editor_and_search_control_failures_are_distinct(self):
        self.assert_code(diagnose_native_failure({}, phase="entry"), "native_entry_missing")
        self.assert_code(diagnose_native_failure({"entry": {"index": 0}}, phase="entry"), "native_editor_missing")
        self.assert_code(diagnose_native_failure({"editor": {"index": 0}}, phase="form"), "native_search_control_missing")

    def test_missing_year_controls_differ_from_unverified_bounds(self):
        state = self.form()
        self.assert_code(diagnose_native_failure(state, phase="form", require_years=True), "native_year_controls_missing")
        state["years"] = [{"role": "from", "value": "2000-12-31"}]
        self.assert_code(diagnose_native_failure(state, phase="form", require_years=True, years_match=False), "native_year_bounds_unverified")
        state.pop("years")
        state["dateSummaries"] = ["Publication years: not verified"]
        self.assert_code(diagnose_native_failure(state, phase="form", require_years=True), "native_year_bounds_unverified")

    def test_verified_embedded_years_need_no_visible_year_controls(self):
        payload = diagnose_native_failure(self.form(), phase="submit", require_years=True,
                                          years_match=True, query_matches=False)
        self.assert_code(payload, "native_query_write_unverified")

    def test_result_query_missing_and_mismatch_are_distinct(self):
        self.assert_code(diagnose_native_failure({"summaries": []}, phase="result"), "native_query_summary_missing")
        self.assert_code(diagnose_native_failure({"summaries": ["   "]}, phase="result"), "native_query_summary_missing")
        self.assert_code(diagnose_native_failure({"summaries": ["query"]}, phase="result", query_matches=False), "native_query_summary_mismatch")

    def test_result_year_and_page_failures_remain_distinct(self):
        state = {"summaries": ["query"]}
        self.assert_code(diagnose_native_failure(state, phase="result", query_matches=True,
                         require_years=True, years_match=False), "native_year_bounds_unverified")
        self.assert_code(diagnose_native_failure(state, phase="result", query_matches=True,
                         page_matches=False), "native_page_position_mismatch")
        self.assert_code(diagnose_native_failure(state, phase="result", query_matches=True,
                         require_page=True), "native_page_position_missing")

    def test_syntax_error_has_priority_over_missing_proof(self):
        self.assert_code(diagnose_native_failure({"syntaxError": True}, phase="result"), "native_syntax_error")

    def test_direct_failure_codes_cover_known_transaction_boundaries(self):
        for code in ("native_query_length_exceeded", "native_query_write_unverified",
                     "native_navigation_unverified", "native_resume_binding_unverified",
                     "native_source_scope_unverified", "native_page_loading"):
            with self.subTest(code=code):
                self.assert_code(native_failure(code, phase="submit"), code)

    def test_unknown_phase_or_code_does_not_echo_untrusted_input(self):
        payload = native_failure("secret-page-text", phase="https://private.invalid")
        self.assert_code(payload, "native_verification_incomplete")
        self.assertEqual(payload["diagnostics"]["native_failure_phase"], "verification")
        self.assertNotIn("secret-page-text", str(payload))
        self.assertNotIn("private.invalid", str(payload))

    def test_diagnostics_do_not_retain_queries_urls_credentials_or_raw_details(self):
        marker = "UNSAFE_RAW_VALUE"
        state = {"editor": {"value": marker}, "entry": {"href": marker},
                 "summaries": [marker], "dateSummaries": [marker]}
        payload = diagnose_native_failure(state, phase="result", query_matches=False)
        self.assertNotIn(marker, str(payload))
        payload = native_failure("native_editor_missing", details={"url": marker,
             "query": marker, "cookie": marker, "page_text": marker,
             "editor_present": marker, "query_matches": False, "years_match": 1})
        self.assertNotIn(marker, str(payload))
        self.assertIs(payload["diagnostics"]["query_matches"], False)
        self.assertNotIn("years_match", payload["diagnostics"])

    def test_unknown_evidence_never_invents_a_specific_failure_or_success(self):
        payload = diagnose_native_failure({"summaries": ["query"]}, phase="result")
        self.assert_code(payload, "native_verification_incomplete")
        self.assertNotIn("query_matches", payload["diagnostics"])
        self.assertNotIn("status", payload)
        self.assert_code(diagnose_native_failure(None), "native_verification_incomplete")


if __name__ == "__main__":
    unittest.main()
