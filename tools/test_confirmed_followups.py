"""Offline traceability checks for independent, never auto-run followups."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('confirmed_builder', Path(__file__).with_name('build-confirmed-research.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ConfirmedFollowupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = builder.build_bundle()

    def test_ten_preserved_baselines_and_scholar_catalog_are_unchanged(self):
        self.assertEqual(len(self.bundle['entries']), 10)
        index = builder.load(builder.PREP / '五库检索_篇关摘筛选_全文分流方案索引_v1.0_方法已确认.json')
        by_id = {item['id']: item for item in index['entries']}
        for item in self.bundle['entries']:
            if item['source'] == 'google-scholar':
                self.assertEqual(len(item['queries']), 136 if item['line'] == 'production' else 169)
            else:
                original = builder.load(builder.WORKSPACE / by_id[item['id']]['files']['query_json']['path'])
                self.assertEqual(item['query'], original['query'])
                self.assertEqual(item['queries'], [])

    def test_nine_followups_have_parent_rules_no_automatic_run_and_distinct_ids(self):
        entries = {item['id']: item for item in self.bundle['entries']}
        supplements = self.bundle['followups']
        self.assertEqual(len(supplements), 9)
        self.assertEqual(len({item['id'] for item in supplements}), 9)
        for item in supplements:
            self.assertEqual(item['role'], 'supplement')
            self.assertEqual(item['executionMode'], 'independent_prepared_task')
            self.assertIs(item['autoStart'], False)
            self.assertEqual(item['screeningPolicy'], entries[item['parentPresetId']]['screeningPolicy'])
            self.assertEqual(item['queries'], [], 'Native-source supplements must not become a Scholar plan')
            self.assertEqual(item['status'], 'ready_to_prepare_pending_source_validation')
            self.assertIsNone(item['reportedCount'])

    def test_wanfang_v05_is_exact_and_new_f43_variants_report_the_removed_operand(self):
        original = builder.load(builder.PREP / '万方生产检索式_v0.5_800字符内单项收紧_待网页核对.json')
        entries = {item['id']: item for item in self.bundle['entries']}
        for item in self.bundle['followups']:
            if item['id'].endswith('-V05'):
                self.assertEqual(item['query'], original['query'])
                self.assertEqual(item['derivation']['changes'], [])
                continue
            base = original['query'] if item['parentPresetId'] == 'WANFANG-PRODUCTION' else entries[item['parentPresetId']]['query']
            expected, removed = builder.without_final_result_block(base)
            self.assertEqual(item['query'], expected)
            self.assertEqual(item['derivation']['removedOperand'], removed)
            self.assertIn('日增重' if item['source'] in ('cnki', 'wanfang') else 'growth', removed) if item['line'] == 'production' else self.assertIn('CH4', removed)
            self.assertIn('F43', item['basisRefs'])
            self.assertEqual(item['basisEvidence']['decisionSnapshot']['id'], 'F43')
            self.assertIn('未逐词人工确认', item['derivation']['approvalBoundary'])
            if item['source'] == 'wanfang':
                self.assertLessEqual(len(item['query']), 800)

    def test_transform_fails_closed_if_query_blocks_change(self):
        with self.assertRaises(ValueError):
            builder.without_final_result_block('(TITLE(a) AND TITLE(b))')
        with self.assertRaises(ValueError):
            builder.without_final_result_block('(TITLE(a) AND TITLE(b) AND TITLE(c) AND TITLE(d))')


if __name__ == '__main__':
    unittest.main()
