"""Package the approved source records; never execute a research query."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
PREP = WORKSPACE / '研究方案/气候变化项目/运行准备'

def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def without_final_result_block(query):
    """Remove only the last AND operand inside the query's outer group.

    The current native baselines all contain (object AND environment AND
    target-result), followed by unchanged date/language/type restrictions.
    This bounded transform never rewrites terms or source-native field tags.
    """
    if not query.lstrip().startswith('('):
        raise ValueError('Expected an outer native-query group')
    depth, quote, outer_end, conjunctions = 0, None, None, []
    for index, char in enumerate(query):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                outer_end = index
                break
        elif (depth == 1 and query[index:index + 3].upper() == 'AND'
              and (index == 0 or not query[index - 1].isalnum())
              and (index + 3 == len(query) or not query[index + 3].isalnum())):
            conjunctions.append(index)
    if outer_end is None or len(conjunctions) != 2:
        raise ValueError('Native query shape changed; inspect the three positive blocks before deriving F43')
    start = conjunctions[-1]
    removed = query[start + 3:outer_end].strip()
    return query[:start].rstrip() + '\n' + query[outer_end:], removed


def build_followups(entries):
    """Independent preparation presets, not silently appended source runs."""
    result = []
    old_wanfang_path = PREP / '万方生产检索式_v0.5_800字符内单项收紧_待网页核对.json'
    old_wanfang = load(old_wanfang_path)
    discussion_path = WORKSPACE / '研究方案/气候变化项目/正式研究方案_讨论记录.json'
    f43 = next(item for item in load(discussion_path)['confirmed_decisions'] if item['id'] == 'F43')
    for entry in entries:
        if entry['source'] == 'google-scholar':
            continue  # Its 305-query catalog already includes fixed supplements.
        provenance = list(entry['provenance'])
        base_query, base_ref = entry['query'], entry['queryRef']
        if entry['id'] == 'WANFANG-PRODUCTION':
            # The later confirmed v1.1 policy explicitly retains this v0.5
            # exact query. Do not upgrade the old draft's own approval flag.
            base_query, base_ref = old_wanfang['query'], old_wanfang['id']
            provenance.append({'path': str(old_wanfang_path.relative_to(WORKSPACE)),
                               'sha256': hashlib.sha256(old_wanfang_path.read_bytes()).hexdigest()})
            result.append({
                **entry, 'id': 'WANFANG-PRODUCTION-SUPPLEMENT-V05',
                'label': '万方 · 生产 · 第二拨原v0.5宽式',
                'query': base_query, 'queries': [], 'queryRef': base_ref,
                'reportedCount': None, 'countNote': '曾有用户8k+反馈；不是当前完整覆盖/纳入数。',
                'parentPresetId': entry['id'], 'role': 'supplement',
                'basisRefs': ['WANFANG-PRODUCTION-STANDALONE-STRATEGY-01', entry['screeningPolicy']['id']],
                'derivation': {'kind': 'exact_preserved_query', 'originalQueryRef': base_ref,
                               'querySha256': hashlib.sha256(base_query.encode()).hexdigest(),
                               'changes': [], 'approvalBoundary': '后续已确认策略明确保留v0.5第二拨；不改旧文件确认状态。'},
                'executionMode': 'independent_prepared_task', 'autoStart': False,
                'status': 'ready_to_prepare_pending_source_validation',
                'followupReason': '恢复摘要内生产结果线索及被第一拨技术标题NOT挡住的候选；同文保留两拨命中关系。',
                'provenance': provenance,
            })
        wide, removed = without_final_result_block(base_query)
        result.append({
            **entry, 'id': entry['id'] + '-SUPPLEMENT-F43',
            'label': entry['label'] + ' · F43宽式查漏',
            'query': wide, 'queries': [], 'queryRef': 'F43-TECHNICAL-' + entry['id'],
            'reportedCount': None, 'countNote': '新技术实例未现场检索；历史主式数量不可挪用。',
            'parentPresetId': entry['id'], 'role': 'supplement',
            'basisRefs': ['F43', 'F54', 'FIVE-SOURCE-IMPLEMENTATION-AUTH-01'],
            'basisEvidence': {'path': str(discussion_path.relative_to(WORKSPACE)),
                              'jsonLocation': 'confirmed_decisions[id=F43]', 'decisionSnapshot': f43},
            'derivation': {'kind': 'remove_final_positive_result_block', 'originalQueryRef': base_ref,
                           'originalQuerySha256': hashlib.sha256(base_query.encode()).hexdigest(),
                           'removedOperand': removed,
                           'changes': ['仅移除生产结果词硬门槛' if entry['line'] == 'production' else '仅移除气体结果词硬门槛',
                                       '动物/来源、环境分支及原日期/语言/类型限制保持；结果资格仍按原篇关摘规则判断。'],
                           'approvalBoundary': 'F43宽式组织原则已确认；此表达式为代理技术落实，未逐词人工确认或现场验证。'},
            'executionMode': 'independent_prepared_task', 'autoStart': False,
            'status': 'ready_to_prepare_pending_source_validation',
            'followupReason': '完成已保留的F43查漏，覆盖目标结果仅在摘要/正文出现的可能研究；不等于已检全。',
            'provenance': provenance,
        })
    return result


def build_bundle():
    index = load(PREP / '五库检索_篇关摘筛选_全文分流方案索引_v1.0_方法已确认.json')
    catalog = load(PREP / 'GoogleScholar完整短式与补检清单_v1.0.json')
    entries = []
    for entry in index['entries']:
        files = entry['files']
        source = {'CNKI': 'cnki', 'WANFANG': 'wanfang', 'WOS': 'web-of-science', 'SCOPUS': 'scopus', 'SCHOLAR': 'google-scholar'}[entry['id'].split('-')[0]]
        line = 'production' if entry['line'] == '生产' else 'emission'
        if source == 'google-scholar':
            policy_path = PREP / 'GoogleScholar检索筛选与全文分流策略_v1.0_已确认待实施.json'
            query = None
            queries = [q for q in catalog['queries'] if q['line'] == line]
            if not queries:
                raise ValueError('Scholar line mapping empty: ' + line)
        else:
            query_path = WORKSPACE / files['query_json']['path']
            query_doc = load(query_path)
            query = query_doc['query']
            if not isinstance(query, str) or not query.strip():
                raise ValueError('Missing native query: ' + entry['id'])
            policy_path = WORKSPACE / files['policy_json']['path']
            queries = []
        # Include inherited scientific rules as well as each source's own
        # workflow. A reference id alone is not evidence supplied to screening.
        inherited = load(PREP / ('知网生产篇关摘纳排与全文下载策略_v1.4_已确认待实施.json' if line == 'production' else '知网排放篇关摘纳排与全文下载策略_v1.0_已确认待实施.json'))
        policy = load(policy_path)
        provenance = []
        for f in files.values():
            rel = f.get('path') if isinstance(f, dict) else f
            if isinstance(rel, str) and (WORKSPACE / rel).is_file():
                data = (WORKSPACE / rel).read_bytes()
                provenance.append({'path': rel, 'sha256': hashlib.sha256(data).hexdigest()})
        entries.append({
            'id': entry['id'], 'database': entry['database'], 'line': line,
            'label': entry['database'] + ' · ' + entry['line'], 'source': source,
            'query': query, 'queries': queries,
            'screeningPolicy': {'id': entry['policy_ref'], 'line': line,
                                'text': json.dumps({'sourcePolicy': policy, 'inheritedPolicy': inherited}, ensure_ascii=False)},
            'queryRef': entry['query_ref'], 'reportedCount': entry.get('current_reported_count'),
            'countNote': entry.get('count_note'), 'provenance': provenance,
        })
    bundle = {'id': 'climate-five-source-v1', 'authorization': 'FIVE-SOURCE-IMPLEMENTATION-AUTH-01',
              'indexRef': index['id'], 'catalogRef': catalog['id'], 'entries': entries,
              'note': '研究范围与纳排已确认；新增技术组合未逐条现场检验。创建配置不会启动检索。'}
    bundle['followups'] = build_followups(entries)
    bundle['followupWorkflow'] = {
        'mode': 'independent_prepared_task', 'autoStart': False,
        'steps': ['先处理对应主检索并保留题录和命中台账。',
                  '从补检待办准备同库独立任务，绑定原生产/排放筛选规则；创建不启动。',
                  '正式执行时核源端条件，按可访问批次逐项交账，受限保留断点。',
                  '题录按强身份核对已有记录，保留所有命中关系；疑似同题不强并，已得PDF核验复用。'],
        'completionBoundary': '待办已准备不等于补检已完成；主式完成不能代表本库完整覆盖。',
        'remainingValidation': ['源端实际解析与字段范围', '已知合格文献找回', '别名/缩写及字段外漏检的实际证据核查'],
    }
    return bundle


def main():
    bundle = build_bundle()
    destination = ROOT / 'config/confirmed-climate-research.json'
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'entries': len(bundle['entries']), 'followups': len(bundle['followups']),
                      'scholarQueries': sum(len(e['queries']) for e in bundle['entries']), 'file': str(destination)}, ensure_ascii=False))

if __name__ == '__main__':
    main()
