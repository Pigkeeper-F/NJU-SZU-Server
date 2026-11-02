"""Isolated calendar tests; never open a browser or modify formal task data."""
import copy
from datetime import date
import json
import re
import shutil
import subprocess
import unittest
from unittest.mock import patch

import literature_cnki_dates as dates


class CalendarPage:
    url = "https://kns.cnki.net/kns8s/AdvSearch"

    def __init__(self):
        self.values = {"from": "", "to": ""}
        self.active = self.dropdown = None
        self.year, self.month, self.option_y = 2026, 9, -524
        self.blocked = self.block_after_click = self.block_after_wheel = False
        self.no_movement = self.no_write = self.disabled_day = False
        self.duplicate_input = self.wrong_picker = False
        self.lag_after_selection, self.label_reads_remaining = 0, 0
        self.clicks, self.wheels, self.scripts, self.hovers = [], [], [], []
        self.mouse = self

    def evaluate(self, script, *args):
        self.scripts.append(script)
        if script == dates.READ_DATES_JS:
            return {} if self.duplicate_input else copy.deepcopy(self.values)
        raise AssertionError("Only visible date input reading is authorized in this fixture")

    def locator(self, selector):
        return CalendarLocator(self, selector)

    def wheel(self, x, y):
        self.wheels.append((x, y))
        if not self.no_movement:
            self.option_y += 20 if y < 0 else -20
        if self.block_after_wheel:
            self.blocked = True


class CalendarLocator:
    def __init__(self, page, selector):
        self.page, self.selector = page, selector

    def count(self):
        return 2 if self.page.duplicate_input and "input.publishdate" in self.selector else 1

    def is_visible(self):
        if "input.publishdate" in self.selector:
            return True
        match = re.search(r'date-id="(datebox[01])"', self.selector)
        if not match or match[1] != self.page.active or self.page.wrong_picker:
            return False
        if "yearselect" in self.selector:
            return self.page.dropdown == "year"
        if "monthselect" in self.selector:
            return self.page.dropdown == "month"
        return True

    def is_enabled(self):
        return True

    def get_attribute(self, name):
        return "xdsoft_disabled" if name == "class" and " td[" in self.selector and self.page.disabled_day else None

    def wait_for(self, **kwargs):
        if not self.is_visible():
            raise TimeoutError("Widget did not become visible")

    def inner_text(self):
        if self.page.label_reads_remaining:
            self.page.label_reads_remaining -= 1
            return "2026"
        return str(self.page.year)

    def bounding_box(self):
        if ".xdsoft_option" in self.selector:
            y = self.page.option_y if "yearselect" in self.selector else 130
            return {"x": 10, "y": y, "width": 100, "height": 20}
        return {"x": 0, "y": 100, "width": 180, "height": 120}

    def hover(self, **kwargs):
        if not self.is_visible():
            raise AssertionError("Cannot hover a hidden dropdown")
        self.page.hovers.append(self.selector)

    def click(self, **kwargs):
        if kwargs.get("force"):
            raise AssertionError("Force clicks are forbidden")
        if not self.is_visible():
            raise AssertionError("Cannot click a hidden control")
        self.page.clicks.append(self.selector)
        if "input.publishdate" in self.selector:
            clicked = "datebox0" if "datebox0" in self.selector else "datebox1"
            self.page.active = None if self.page.active == clicked else clicked
            self.page.dropdown = None
        elif ".xdsoft_option" in self.selector:
            if not dates._inside(self.bounding_box(), {"x": 0, "y": 100, "width": 180, "height": 120}):
                raise AssertionError("Clipped options must be exposed by wheel before clicking")
            value = int(re.search(r'data-value="(\d+)"', self.selector)[1])
            if "yearselect" in self.selector:
                self.page.year = value
                self.page.label_reads_remaining = self.page.lag_after_selection
            else:
                self.page.month = value
            self.page.dropdown = None
        elif ".xdsoft_label.xdsoft_year" in self.selector:
            self.page.dropdown = "year"
        elif ".xdsoft_label.xdsoft_month" in self.selector:
            self.page.dropdown = "month"
        elif " td[" in self.selector:
            year, month, day = map(int, re.findall(r'data-(?:year|month|date)="(\d+)"', self.selector))
            if (year, month) != (self.page.year, self.page.month):
                raise AssertionError("Calendar month did not match the selected day")
            role = "from" if self.page.active == "datebox0" else "to"
            if not self.page.no_write:
                self.page.values[role] = f"{year:04d}-{month + 1:02d}-{day:02d}"
            self.page.active = None
        if self.page.block_after_click:
            self.page.blocked = True


class DateValueTests(unittest.TestCase):
    def test_complete_bounds_reject_bare_year_invalid_dates_and_same_year_narrowing(self):
        self.assertEqual(dates.parse_date_value(" 2000-01-01 "), date(2000, 1, 1))
        self.assertEqual(dates.parse_date_value("2026/12/31"), date(2026, 12, 31))
        for value in ("2000", "2026-02-29", "2000-01/01", "2000-01-01x", None):
            self.assertIsNone(dates.parse_date_value(value))
        self.assertTrue(dates.bounds_match({"from": "2000-01-01", "to": "2026-12-31"}, 2000, 2026))
        self.assertFalse(dates.bounds_match({"from": "2000-12-31", "to": "2026-12-31"}, 2000, 2026))
        self.assertFalse(dates.bounds_match({"from": "2000-01-01", "to": "2026-10-31"}, 2000, 2026))

    def test_invalid_parameters_and_inverted_ranges_fail(self):
        for role, year in (("unknown", 2000), ("from", True), ("to", "2026"), ("to", 10000)):
            self.assertIsNone(dates.year_bound_value(role, year))
        self.assertFalse(dates.bounds_match({}, True, 2026))
        self.assertFalse(dates.bounds_match({}, 2026, 2000))
        self.assertFalse(dates.bounds_match(None, 2000, 2026))

    def test_dom_reader_uses_unique_visible_publication_inputs_only(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node unavailable for isolated DOM script test")
        script = r'''
const payload = JSON.parse(require('fs').readFileSync(0,'utf8'));
const make = value => ({value, offsetWidth:1, offsetHeight:1, getClientRects:()=>[{}]});
const start=make('2000-01-01'), end=make('2026-12-31'), hidden={...make('1990-01-01'),hidden:true,offsetWidth:0,offsetHeight:0,getClientRects:()=>[]};
global.getComputedStyle=el=>({visibility:el.hidden?'hidden':'visible',display:el.hidden?'none':'block'});
const rows={'.tit-date-box input.publishdate#datebox0':[start,hidden],'.tit-date-box input.publishdate#datebox1':[end]};
global.document={querySelectorAll:selector=>rows[selector]||[]};
const read=eval('('+payload.script+')');const good=read();
rows['.tit-date-box input.publishdate#datebox0'].push(make('2001-01-01'));const duplicate=read();
rows['.tit-date-box input.publishdate#datebox0']=[start];end.disabled=true;const disabled=read();
process.stdout.write(JSON.stringify({good,duplicate,disabled}));
'''
        result = subprocess.run([node, "-e", script], input=json.dumps({"script": dates.READ_DATES_JS}),
                                text=True, encoding="utf-8", capture_output=True, check=True)
        values = json.loads(result.stdout)
        self.assertTrue(dates.bounds_match(values["good"], 2000, 2026))
        self.assertEqual(values["duplicate"], {})
        self.assertEqual(values["disabled"], {})


class CalendarUITests(unittest.TestCase):
    def setUp(self):
        self.page = CalendarPage()
        guard = patch.object(dates, "submission_allowed", side_effect=lambda page, source: not page.blocked)
        sleeper = patch.object(dates.time, "sleep")
        guard.start(); sleeper.start()
        self.addCleanup(guard.stop); self.addCleanup(sleeper.stop)

    def test_existing_exact_value_skips_all_actions(self):
        self.page.values["from"] = "2000-01-01"
        self.assertTrue(dates.set_year_bound(self.page, "from", 2000))
        self.assertEqual(self.page.clicks, []); self.assertEqual(self.page.wheels, [])

    def test_readonly_calendar_reaches_offscreen_year_with_more_than_twenty_real_wheels(self):
        self.assertTrue(dates.set_year_bound(self.page, "from", 2000))
        self.assertEqual(self.page.values["from"], "2000-01-01")
        self.assertGreaterEqual(len(self.page.wheels), 31)
        self.assertEqual(len([s for s in self.page.hovers if "yearselect" in s]), 1)
        self.assertEqual(self.page.values["to"], "")
        self.assertTrue(all(script == dates.READ_DATES_JS for script in self.page.scripts))

    def test_end_role_selects_december_31_in_its_own_picker(self):
        self.assertTrue(dates.set_year_bound(self.page, "to", 2026))
        self.assertEqual(self.page.values, {"from": "", "to": "2026-12-31"})
        self.assertFalse(any("datebox0" in selector for selector in self.page.clicks))

    def test_already_open_correct_picker_reuses_partial_year_scroll(self):
        self.page.active, self.page.dropdown, self.page.option_y = "datebox0", "year", -100
        self.assertTrue(dates.set_year_bound(self.page, "from", 2000))
        self.assertFalse(any("input.publishdate" in s for s in self.page.clicks))
        self.assertFalse(any(".xdsoft_label.xdsoft_year" in s for s in self.page.clicks))
        self.assertEqual(len([s for s in self.page.hovers if "yearselect" in s]), 1)
        self.assertLess(len(self.page.wheels), 31)

    def test_calendar_label_refresh_is_waited_for_before_selecting_the_day(self):
        self.page.lag_after_selection = 2
        self.assertTrue(dates.set_year_bound(self.page, "from", 2000))
        self.assertEqual(self.page.label_reads_remaining, 0)

    def test_same_year_wrong_day_is_changed_and_full_readback_is_required(self):
        self.page.values["from"] = "2000-12-31"
        self.assertTrue(dates.set_year_bound(self.page, "from", 2000))
        self.page.values["from"] = "2000-12-31"; self.page.no_write = True
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000))

    def test_no_progress_stops_after_three_stationary_observations(self):
        self.page.no_movement = True
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000))
        self.assertEqual(len(self.page.wheels), 3)
        self.assertFalse(any(".xdsoft_option" in selector for selector in self.page.clicks))

    def test_auth_or_access_block_stops_before_or_during_ui_actions(self):
        self.page.blocked = True
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000)); self.assertEqual(self.page.clicks, [])
        self.page.blocked = False; self.page.block_after_click = True
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000)); self.assertEqual(len(self.page.clicks), 1)
        self.page = CalendarPage(); self.page.block_after_wheel = True
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000)); self.assertEqual(len(self.page.wheels), 1)

    def test_wrong_picker_duplicate_inputs_and_disabled_day_fail_closed(self):
        for flag in ("wrong_picker", "duplicate_input", "disabled_day"):
            with self.subTest(flag=flag):
                self.page = CalendarPage(); setattr(self.page, flag, True)
                self.assertFalse(dates.set_year_bound(self.page, "to", 2026))
                self.assertEqual(self.page.values, {"from": "", "to": ""})

    def test_official_domain_and_time_budget_are_required(self):
        self.page.url = "https://kns.cnki.net.attacker.invalid/"
        self.assertFalse(dates.set_year_bound(self.page, "from", 2000)); self.assertEqual(self.page.clicks, [])
        self.page.url = CalendarPage.url
        with patch.object(dates, "_OPERATION_SECONDS", 0):
            self.assertFalse(dates.set_year_bound(self.page, "from", 2000))
        self.assertEqual(self.page.clicks, [])


if __name__ == "__main__":
    unittest.main()
