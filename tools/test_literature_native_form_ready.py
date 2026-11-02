"""Dynamic native form readiness; local fixtures, no source or browser requests."""
import copy
import unittest
from unittest.mock import patch

import literature_native_queries as native
from test_literature_native_queries import NativePage, NativeLocator, QUERIES


class Clock:
    value = 0

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class CheckedLocator(NativeLocator):
    def nth(self, index):
        return CheckedLocator(self.page, self.selector, index)

    def fill(self, value):
        assert self.index == self.page.native["editor"]["index"]
        super().fill(value)
        if self.page.after_fill:
            self.page.after_fill()

    def click(self, **kwargs):
        if self.selector == native.BUTTON_SELECTOR:
            assert self.index == self.page.native["button"]["index"], "stale button index"
            assert not kwargs.get("force"), "only normal clicks"
            self.page.clicked.append(self.index)
        super().click(**kwargs)


class Page(NativePage):
    def __init__(self):
        super().__init__("cnki")
        self.url = "https://kns.cnki.net/kns8s/AdvSearch?type=expert"
        self.probes = 0
        self.on_probe = self.after_fill = None
        self.clicked = []
        for row in self.native["years"]:
            row.update(tag="cnki-date", value="", options=[])

    def evaluate(self, script, args=None):
        if "literature_native_probe" in script:
            self.probes += 1
            if self.on_probe:
                self.on_probe(self.probes)
        return super().evaluate(script, args)

    def locator(self, selector):
        return CheckedLocator(self, selector)


class DynamicNativeFormTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.addCleanup(patch.stopall)
        patch.object(native.time, "monotonic", self.clock.monotonic).start()
        patch.object(native.time, "sleep", self.clock.sleep).start()
        self.page = Page()
        self.calendar_calls = []

    def calendar(self, page, role, year):
        self.calendar_calls.append((role, year))
        row = next(row for row in page.native["years"] if row["role"] == role)
        row["value"] = f"{year}-01-01" if role == "from" else f"{year}-12-31"
        # Visible calendar DOM injects unrelated buttons before final Search.
        page.native["button"]["index"] = 3 if role == "from" else 5
        return True

    def submit(self, calendar=None):
        self.failure, self.proof = {}, {}
        with patch("literature_cnki_dates.set_year_bound", side_effect=calendar or self.calendar):
            return native.submit(self.page, "cnki", QUERIES["cnki"], 2000, 2026,
                                 failure_out=self.failure, submission_out=self.proof,
                                 before_click_snapshot=lambda: {"results": [], "noResults": False})

    def test_waits_for_late_years_and_stable_controls_instead_of_first_editor(self):
        complete = copy.deepcopy(self.page.native)
        complete["button"]["index"] = 5
        self.page.native["years"] = []
        self.page.on_probe = lambda number: setattr(self.page, "native", copy.deepcopy(complete)) if number == 3 else None
        found = native.find_editor(self.page, "cnki", required_year_roles=("from", "to"))
        self.assertGreaterEqual(self.page.probes, 4)
        self.assertEqual(found["button"]["index"], 5)
        self.assertEqual(len(found["years"]), 2)
        self.assertEqual(self.page.submits, 0)

    def test_calendar_inserted_buttons_use_new_unique_search_index(self):
        self.assertTrue(self.submit())
        self.assertEqual(self.calendar_calls, [("from", 2000), ("to", 2026)])
        self.assertEqual(self.page.clicked, [5])
        self.assertEqual(self.page.fills, [QUERIES["cnki"]])
        self.assertTrue(self.proof["clicked_normally"])
        self.assertEqual(self.proof["before_state"]["button"]["index"], 5)
        self.assertTrue(native._visible_years(self.proof["before_state"], 2000, 2026))

    def test_initial_missing_dates_then_calendar_reindex_can_submit_once(self):
        complete = copy.deepcopy(self.page.native)
        self.page.native["years"] = []
        self.page.on_probe = lambda number: setattr(self.page, "native", copy.deepcopy(complete)) if number == 3 else None
        self.assertTrue(self.submit())
        self.assertEqual(self.page.clicked, [5])

    def test_wrong_calendar_bound_cannot_fill_or_click(self):
        def wrong(page, role, year):
            return self.calendar(page, role, year + 1)
        self.assertFalse(self.submit(wrong))
        self.assertEqual(self.page.fills, [])
        self.assertEqual(self.page.clicked, [])
        self.assertEqual(self.failure["diagnostics"]["native_failure_code"], "native_year_bounds_unverified")

    def test_editor_identity_change_after_dates_is_not_accepted(self):
        def changed(page, role, year):
            result = self.calendar(page, role, year)
            if role == "to":
                page.native["editor"]["label"] = "a different editor"
            return result
        self.assertFalse(self.submit(changed))
        self.assertEqual(self.page.fills, [])
        self.assertEqual(self.failure["diagnostics"]["native_failure_code"], "native_navigation_unverified")

    def test_truncated_query_date_change_or_late_button_shift_never_clicks(self):
        for mutation in ("truncate", "date", "button"):
            with self.subTest(mutation=mutation):
                self.page = Page()
                if mutation == "truncate":
                    self.page.truncate = True
                elif mutation == "date":
                    self.page.after_fill = lambda: self.page.native["years"][0].update(value="2010-01-01")
                else:
                    self.page.after_fill = lambda: self.page.native["button"].update(index=99)
                self.assertFalse(self.submit())
                self.assertEqual(self.page.clicked, [])
                self.assertEqual(self.failure["diagnostics"]["native_failure_code"], "native_query_write_unverified")

    def test_missing_years_timeout_does_not_submit_or_set_dates(self):
        self.page.native["years"] = []
        self.assertFalse(self.submit())
        self.assertEqual(self.calendar_calls, [])
        self.assertEqual(self.page.clicked, [])
        self.assertGreaterEqual(self.clock.value, 5)

    def test_button_disappearing_after_dates_does_not_navigate_or_submit(self):
        def hidden(page, role, year):
            result = self.calendar(page, role, year)
            if role == "to":
                page.native["button"] = None
            return result
        self.assertFalse(self.submit(hidden))
        self.assertEqual(self.page.entries, 0)
        self.assertEqual(self.page.clicked, [])

    def test_access_barrier_during_ready_wait_stops_without_actions(self):
        self.page.native["years"] = []
        self.page.on_probe = lambda number: setattr(self.page, "block", "captcha") if number == 2 else None
        self.assertFalse(self.submit())
        self.assertEqual(self.page.clicked, [])
        self.assertEqual(self.calendar_calls, [])
        self.assertLess(self.clock.value, 5)


if __name__ == "__main__":
    unittest.main()
