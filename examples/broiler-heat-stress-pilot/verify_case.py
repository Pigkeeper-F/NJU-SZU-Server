"""Offline integrity checks for the published broiler pilot snapshot."""
from __future__ import annotations

import csv
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name: str):
    return json.loads((ROOT / name).read_text(encoding='utf-8-sig'))


def csv_rows(name: str):
    with (ROOT / name).open(encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames
        return columns, list(reader)


def main():
    provenance = load('provenance.json')
    candidates = load('candidates.json')
    schema = load('field-definitions.json')
    fields = schema['fields']
    keys = {field['key'] for field in fields}
    assert len(fields) == len(keys) == provenance['confirmed_fields'] == 75
    assert len({field['label'] for field in fields}) == len(fields)
    assert all(field['meaning'] and field['valueType'] in ('text', 'number') for field in fields)
    assert len(candidates['records']) == candidates['count'] == provenance['source_counters']['candidates'] == 10
    assert all('snippet' not in record and 'abstract' not in record for record in candidates['records'])
    ids = {record['candidate_id'] for record in candidates['records']}
    assert len(ids) == 10
    config = load('reuse-config.json')
    assert config['fieldDefinitions'] == fields
    assert config['targetFields'] == [field['label'] for field in fields]
    assert config['inclusion'] == load('run-config.snapshot.json')['inclusion'][2:]

    _, literature = csv_rows('literature.csv')
    columns, rows = csv_rows('parameters.csv')
    assert len(literature) == len(ids)
    assert {row['paper_id'] for row in literature} == ids
    assert 'evidence_quote' not in columns
    assert len(rows) == provenance['source_counters']['parameterRows'] == 259
    assert len({row['row_id'] for row in rows}) == len(rows)
    assert all(row['field'] in keys and row['paper_id'] in ids for row in rows)
    assert all(row['evidence_where'] for row in rows)
    assert all(row['review_status'] == 'unreviewed' for row in literature)
    assert all(row['screening_status'] == 'pending_review' for row in literature)
    assert Counter(row['validation_status'] for row in rows) == {'ok': 251, 'pending_review': 8}

    extracted = {}
    extraction_rows = {}
    for file in sorted((ROOT / 'extraction').glob('PMID-*.json')):
        paper = load(file.relative_to(ROOT))
        extracted[paper['paper_id']] = len(paper['rows'])
        for row in paper['rows']:
            assert 'quote' not in row['evidence']
            assert row['field'] in keys
            extraction_rows[row['row_id']] = row
    assert extracted == provenance['extracted_rows_by_paper']
    assert sum(extracted.values()) == len(rows)
    for row in rows:
        original = extraction_rows[row['row_id']]
        assert row['field'] == original['field']
        assert row['evidence_where'] == original['evidence']['where']
        assert row['unit_raw'] == original['unit_raw']
        assert row['conditions_json'] == json.dumps(original['conditions'], ensure_ascii=False, separators=(',', ':')) or json.loads(row['conditions_json']) == original['conditions']
        raw = original['value_raw']
        assert row['value_raw'] == str(raw) or (isinstance(raw, (dict, list)) and json.loads(row['value_raw']) == raw)

    validation = load('validation.json')
    assert validation['counts']['parameters_total'] == len(rows)
    assert validation['counts']['ok'] == 251 and validation['counts']['pending'] == 8
    assert validation['counts']['blocking'] == 0
    assert {row['row_id'] for row in rows if row['validation_status'] == 'pending_review'} == {item['row_id'] for item in validation['pending']}
    status = load('material-status.json')
    assert len(status['papers']) == len(ids)
    assert all(paper['local_files_included'] is False for paper in status['papers'])
    assert Counter(paper['source_fulltext_status'] for paper in status['papers']) == {'fetched_html': 3, 'abstract_only': 1, 'unavailable': 6}
    assert load('extraction-check.json')['ok'] == 3

    for file in ROOT.rglob('*'):
        if not file.is_file() or file.suffix not in ('.json', '.csv', '.md'):
            continue
        text = file.read_text(encoding='utf-8-sig')
        assert not re.search(r'[A-Za-z]:[\\/](?:Users|file download|claudecode)[\\/]', text), file
    print('BROILER_CASE_CHECK_PASS: 10 candidates, 75 fields, 259 parameter rows; 8 pending; no source quotations or local materials distributed.')


if __name__ == '__main__':
    main()
