"""Offline integrity and publication-boundary checks for task status records."""
from __future__ import annotations

import csv
import json
import re
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


def main():
    records = load('task-records.json')['records']
    events = load('historical-events.json')['events']
    provenance = load('provenance.json')
    assert len(records) == 5
    assert Counter(record['status'] for record in records) == {'failed': 3, 'cancelled': 1, 'waiting': 1}
    assert Counter(record['record_type'] for record in records) == {'literature_job': 1, 'workbench_run': 4}
    assert len({record['task_id'] for record in records}) == len(records)
    assert provenance['literature_deleted_excluded'] == 9
    assert provenance['nondeleted_literature_completed_not_classified_failed'] == 1
    assert dict(Counter(record['status'] for record in records)) == provenance['record_status_counts']
    assert len(events) == 10
    assert Counter(event['event_type'] for event in events) == {'attention': 9, 'error': 1}
    assert sum(event['error_class'] == 'researcher_confirmation' for event in events) == 1
    assert all(event['task_current_status'] == 'completed' for event in events)
    assert all(record['error_class'] == 'reported_plan_blocker' for record in records if record['status'] == 'failed')
    assert next(record for record in records if record['status'] == 'cancelled')['error_class'] == 'stopped'
    assert next(record for record in records if record['status'] == 'waiting')['error_class'] == 'discussion_required'
    assert next(event for event in events if event['event_type'] == 'error')['error_class'] == 'local_write_denied'
    for item in records + events:
        assert item['source_ref'] in provenance['source_sha256']
        assert item['message'] and item['recorded_at']
        assert item['interpretation'] and item['suggested_next_step']
        for file in item.get('retained_files', []):
            assert file['content_included'] is False
            assert not Path(file['name']).is_absolute() and '..' not in Path(file['name']).parts
            assert file['bytes'] >= 0 and re.fullmatch('[a-f0-9]{64}', file['sha256'])
    assert all(re.fullmatch('[a-f0-9]{64}', value) for value in provenance['source_sha256'].values())
    with (ROOT / 'task-records.csv').open(encoding='utf-8-sig', newline='') as handle:
        table = list(csv.DictReader(handle))
    assert len(table) == len(records)
    assert [row['task_id'] for row in table] == [record['task_id'] for record in records]
    for file in ROOT.iterdir():
        if file.suffix not in ('.json', '.csv'):
            continue
        text = file.read_text(encoding='utf-8-sig')
        assert not re.search(r'https?://', text), file
        assert not re.search(r'[A-Za-z]:[\\/]', text), file
        assert not re.search(r'(?i)(?:sk-[A-Za-z0-9]{20,}|bearer\s+[A-Za-z0-9._-]{10,})', text), file
    print('FAILED_TASK_RECORDS_CHECK_PASS: 5 task records; 10 historical events; 9 deleted literature jobs excluded.')


if __name__ == '__main__':
    main()
