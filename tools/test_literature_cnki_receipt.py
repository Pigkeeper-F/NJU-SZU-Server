"""Pure receipt transition tests; no browser or task files are used."""
import copy
import json
import unittest

import literature_cnki_receipt as receipts


QUERY = "TKA=('牛') AND TI=('气温')"


def state(page=None):
    return {"modeVerified": True, "editor": {"value": QUERY}, "button": {"index": 0},
            "years": [{"role": "from", "tag": "cnki-date", "value": "2000-01-01"},
                      {"role": "to", "tag": "cnki-date", "value": "2026-12-31"}],
            "pageNumber": page, "summaries": [], "syntaxError": False}


def snapshot(title=None):
    return {"results": [{"title": title, "doi": "10.123/test"}] if title else [],
            "visible_result_count": 1 if title else 0, "noResults": False}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.before, self.pre = snapshot(), state()
        self.after, self.post = snapshot("first page"), state(1)

    def create(self, **changes):
        args = dict(before_snapshot=self.before, before_state=self.pre, after_snapshot=self.after,
                    after_state=self.post, clicked_normally=True)
        args.update(changes)
        return receipts.create_receipt(QUERY, 2000, 2026, **args)

    def valid(self, receipt, **changes):
        args = dict(current_snapshot=self.after, current_state=self.post)
        args.update(changes)
        return receipts.validate_receipt(receipt, QUERY, 2000, 2026, **args)

    def test_witnessed_first_page_without_summary_creates_json_safe_receipt(self):
        receipt = self.create()
        self.assertTrue(self.valid(json.loads(json.dumps(receipt))))
        self.assertNotIn(QUERY, json.dumps(receipt))
        self.assertNotIn("first page", json.dumps(receipt))
        self.assertEqual(receipt["page_index"], 0)

    def test_editor_alone_or_existing_results_cannot_mint_receipt(self):
        for changes in ({"clicked_normally": False}, {"clicked_normally": 1},
                        {"after_snapshot": snapshot()}, {"before_snapshot": self.after},
                        {"before_snapshot": {**self.before, "noResults": True}},
                        {"before_snapshot": {**self.before, "visible_result_count": 2}}):
            with self.subTest(changes=changes):
                self.assertIsNone(self.create(**changes))

    def test_pre_and_post_query_dates_mode_and_button_are_required(self):
        for side in ("before_state", "after_state"):
            original = self.pre if side == "before_state" else self.post
            for kind in ("query", "date", "mode", "syntax"):
                changed = copy.deepcopy(original)
                if kind == "query": changed["editor"]["value"] += " "
                elif kind == "date": changed["years"][0]["value"] = "2000-12-31"
                elif kind == "mode": changed["modeVerified"] = False
                else: changed["syntaxError"] = True
                self.assertIsNone(self.create(**{side: changed}), (side, kind))
        self.assertIsNone(self.create(before_state={**self.pre, "button": None}))

    def test_block_or_loading_prevents_receipts(self):
        for key in receipts._BLOCKS:
            self.assertIsNone(self.create(after_snapshot={**self.after, key: True}), key)
            self.assertIsNone(self.create(before_snapshot={**self.before, key: True}), key)

    def test_rows_need_first_page_and_matching_independently_computed_fingerprint(self):
        for page in (None, 2, True):
            self.assertIsNone(self.create(after_state=state(page)))
        self.assertIsNone(self.create(result_fingerprint="0" * 64))
        self.assertIsNotNone(self.create(result_fingerprint=receipts._fingerprint(self.after)))

    def test_explicit_zero_results_need_no_pagination_but_not_contradictory_rows(self):
        zero = {**snapshot(), "noResults": True}
        receipt = self.create(after_snapshot=zero, after_state=state())
        self.assertTrue(self.valid(receipt, current_snapshot=zero, current_state=state()))
        self.assertIsNone(self.create(after_snapshot={**self.after, "noResults": True}))

    def test_resume_rejects_changed_query_dates_rows_page_and_missing_chain(self):
        receipt = self.create()
        self.assertFalse(self.valid(None))
        self.assertFalse(self.valid(receipt, current_snapshot=snapshot("resorted page")))
        self.assertFalse(self.valid(receipt, current_state=state(2)))
        self.assertFalse(self.valid(receipt, expected_page_index=1))
        for key, value in (("query_sha256", "0" * 64), ("evidence", {}), ("source", "wanfang"),
                           ("bounds", {"from": "2001-01-01", "to": "2026-12-31"})):
            self.assertFalse(self.valid({**receipt, key: value}))

    def test_next_page_requires_verified_old_page_one_real_click_and_exact_increment(self):
        receipt = self.create()
        args = dict(before_snapshot=self.after, before_state=self.post, after_snapshot=snapshot("second page"),
                    after_state=state(2), clicked_normally=True, expected_page_index=1)
        new = receipts.advance_receipt(receipt, QUERY, 2000, 2026, **args)
        self.assertIsNotNone(new)
        self.assertTrue(self.valid(new, current_snapshot=args["after_snapshot"], current_state=args["after_state"], expected_page_index=1))
        self.assertEqual(receipt["page_index"], 0, "Advancing does not mutate the stored old receipt")
        for changes in ({"clicked_normally": False}, {"after_state": state(3)}, {"expected_page_index": 2},
                        {"before_snapshot": snapshot("changed old page")}, {"after_snapshot": self.after}):
            self.assertIsNone(receipts.advance_receipt(receipt, QUERY, 2000, 2026, **{**args, **changes}))

    def test_multiple_next_transitions_can_resume_without_repeating_search(self):
        receipt = self.create()
        for index in range(1, 4):
            previous = self.after
            self.after = snapshot(f"page {index + 1}")
            receipt = receipts.advance_receipt(receipt, QUERY, 2000, 2026, before_snapshot=previous,
                before_state=state(index), after_snapshot=self.after, after_state=state(index + 1),
                clicked_normally=True, expected_page_index=index)
            self.assertIsNotNone(receipt)
            self.assertTrue(self.valid(receipt, current_state=state(index + 1), expected_page_index=index))


if __name__ == "__main__":
    unittest.main()
