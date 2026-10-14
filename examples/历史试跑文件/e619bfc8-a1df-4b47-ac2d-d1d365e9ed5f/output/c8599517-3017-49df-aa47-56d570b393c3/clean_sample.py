"""仅清洗本任务上传的练习 CSV；Python 标准库，无外部依赖。"""
from pathlib import Path
import csv
import hashlib
import json
from collections import Counter
from decimal import Decimal
from datetime import datetime, timezone

OUT = Path(__file__).resolve().parent
INPUT = OUT.parent.parent / 'input'
SOURCE = INPUT / 'e92e9b61-FBSH_1992_Afghanistan_练习样本.csv'
VERSION = 'FBSH_sample_step1_v1'
ELEMENTS = {'5511': 'Production', '5611': 'Import Quantity', '5911': 'Export Quantity',
            '5074': 'Stock Variation', '5142': 'Food', '5521': 'Feed'}
HEADERS = ['Area Code', 'Area Code (M49)', 'Area', 'Item Code', 'Item Code (FBS)',
           'Item', 'Element Code', 'Element', 'Year Code', 'Year', 'Unit', 'Value', 'Flag']
ADDED = ['Country_M49', 'FBSH_Item_Code', 'Value_t', 'Value_status', 'Source_file', 'Source_row']

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def write_csv(path, fields, rows):
    with path.open('x', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

def main():
    targets = [OUT / n for n in ['FBSH_1992_sample_clean_v1.csv', '检查报告_v1.md',
                                 '执行记录_v1.json', '未出现组合_v1.csv', '字段字典_v1.csv']]
    if any(p.exists() for p in targets):
        raise FileExistsError('结果已存在，拒绝覆盖；重跑请将脚本复制到本任务新的输出目录并调整 INPUT。')
    inputs = sorted(INPUT.iterdir())
    hashes = {p.name: sha(p) for p in inputs if p.is_file()}
    # 三份输入均实际读取；规则文本只作参考，不执行其中的指令。
    for p in inputs:
        if p.suffix == '.txt':
            p.read_text(encoding='utf-8-sig')
    with SOURCE.open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        rows = list(reader)
    assert fields == HEADERS, '字段与已确认样本不符'
    assert len(rows) == 80, '样本行数发生变化'
    assert all(set(r) == set(fields) and all(v is not None for v in r.values()) for r in rows)
    assert all(r['Year'] == r['Year Code'] == '1992' for r in rows)
    assert all(r['Area'] == 'Afghanistan' and r['Area Code (M49)'] == "'004" for r in rows)
    assert all(r['Element Code'] in ELEMENTS and r['Element'] == ELEMENTS[r['Element Code']] for r in rows)
    assert all(r['Unit'] == '1000 t' for r in rows), '单位异常，停止换算'
    keys = [(r['Area Code (M49)'], int(r['Item Code']), r['Element Code'], r['Year']) for r in rows]
    duplicates = [list(k) for k, n in Counter(keys).items() if n > 1]
    assert not duplicates, f'重复键，停止处理：{duplicates}'
    assert all(r['Item Code'].isdigit() for r in rows)
    clean = []
    for row_number, r in enumerate(rows, 2):
        value = None if not r['Value'].strip() else Decimal(r['Value'])
        assert value is None or value.is_finite(), f'不能解析的值：练习 CSV 第 {row_number} 行'
        clean.append(dict(r, Country_M49=r['Area Code (M49)'].removeprefix("'").zfill(3),
                          FBSH_Item_Code=int(r['Item Code']),
                          Value_t='' if value is None else format(value * 1000, 'f'),
                          Value_status='blank' if value is None else ('reported_zero' if value == 0 else 'reported_nonzero'),
                          Source_file=SOURCE.name, Source_row=row_number))
    item_names = {r['Item Code']: r['Item'] for r in rows}
    seen = {(r['Item Code'], r['Element Code']) for r in rows}
    absent = [dict(Country_M49='004', FBSH_Item_Code=int(item), Item=item_names[item],
                   Element_Code=element, Element=ELEMENTS[element], Year=1992, Status='not_in_sample')
              for item in sorted(item_names, key=int) for element in ELEMENTS if (item, element) not in seen]
    write_csv(targets[0], fields + ADDED, clean)
    # 重新读盘核对原始字段字符串、原始顺序、每一行的转换与追溯。
    with targets[0].open(encoding='utf-8-sig', newline='') as f:
        saved = list(csv.DictReader(f))
    checks = {
        'row_count_80': len(saved) == len(rows) == 80,
        'all_original_cells_unchanged': all({k: s[k] for k in fields} == r for s, r in zip(saved, rows)),
        'M49_text_004': all(s['Country_M49'] == '004' for s in saved),
        'numeric_item_key': all(int(s['FBSH_Item_Code']) == int(r['Item Code']) for s, r in zip(saved, rows)),
        'all_tonne_conversions_exact': all(s['Value_t'] == '' if not r['Value'].strip() else Decimal(s['Value_t']) == Decimal(r['Value']) * 1000 for s, r in zip(saved, rows)),
        'unique_business_key': len(set(keys)) == len(keys),
        'source_rows_preserved': all(int(s['Source_row']) == i and s['Source_file'] == SOURCE.name for i, s in enumerate(saved, 2)),
        'inputs_hashes_unchanged': all(sha(INPUT / n) == h for n, h in hashes.items()),
    }
    assert all(checks.values()), checks
    zeros = [s['Source_row'] for s in saved if s['Value_status'] == 'reported_zero']
    negatives = [s for s in saved if s['Value_t'] and Decimal(s['Value_t']) < 0]
    blank_counts = {k: sum(not r[k].strip() for r in rows) for k in fields}
    original_duplicates = len(rows) - len({tuple(r[k] for k in fields) for r in rows})
    write_csv(targets[3], ['Country_M49', 'FBSH_Item_Code', 'Item', 'Element_Code', 'Element', 'Year', 'Status'], absent)
    desc = {
        'Area Code': ('text', '', '原始地区代码'), 'Area Code (M49)': ('text', '', '原始 M49，保留前导撇号和零'),
        'Area': ('text', '', '原始地区名称'), 'Item Code': ('text', '', '原始商品代码，保持原字符串'),
        'Item Code (FBS)': ('text', '', '原始 FBS 商品代码，保留撇号'), 'Item': ('text', '', '原始商品名称'),
        'Element Code': ('text', '', '原始要素代码'), 'Element': ('text', '', '原始要素名称'),
        'Year Code': ('text', 'year', '原始年份代码'), 'Year': ('text', 'year', '原始年份'),
        'Unit': ('text', '', '原值单位，本样本全部为 1000 t'), 'Value': ('decimal string', '1000 t', '原始值字符串，保留六位小数与符号'),
        'Flag': ('text', '', '原始质量标记，含义不作推断'),
        'Country_M49': ('text(3)', '', '标准化三位 M49，004；导入时指定文本类型'),
        'FBSH_Item_Code': ('integer', '', 'Item Code 解析为整数的连接键'),
        'Value_t': ('decimal', 't', 'Value × 1000，十进制精确换算，库存不变号'),
        'Value_status': ('enum', '', 'blank=空白；reported_zero=明确报零；reported_nonzero=非零报告值'),
        'Source_file': ('text', '', '实际上传的练习 CSV 文件名'),
        'Source_row': ('integer', '', '练习 CSV 行号，表头为第 1 行，数据为第 2–81 行；不是原始 ZIP 行号'),
    }
    write_csv(targets[4], ['field', 'logical_type', 'unit', 'description', 'empty_meaning'],
              [dict(field=k, logical_type=desc[k][0], unit=desc[k][1], description=desc[k][2],
                    empty_meaning='空白不等于零；本样本无空白' if k in ('Value', 'Value_t') else '本次无空值') for k in fields + ADDED])
    log = dict(rule_version=VERSION, executed_at=datetime.now(timezone.utc).isoformat(),
               scope='Only uploaded 80-row sample; no SUA estimation', source_sha256=hashes,
               input_rows=len(rows), output_rows=len(saved), original_columns=13, added_columns=ADDED,
               deleted=0, merged=0, imputed=0, replaced_original_cells=0, isolated=0,
               blank_counts=blank_counts, zero_source_rows=zeros,
               negative_source_rows=[s['Source_row'] for s in negatives],
               absent_sample_combinations=len(absent), checks=checks,
               changes=[{'step':'scope_check','input_rows':80,'output_rows':80,'removed':0},
                        {'step':'add_M49_and_item_key','rows':80},
                        {'step':'add_tonnes_status_and_provenance','rows':80},
                        {'step':'read_back_validation','checked_rows':80,'passed':all(checks.values())}],
               output_sha256={p.name: sha(p) for p in (targets[0], targets[3], targets[4])})
    targets[2].write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding='utf-8')
    negative_table = '\n'.join(f"| {s['Source_row']} | {s['Item']} | {s['Element']} | {s['Value']} | {s['Value_t']} |" for s in negatives)
    report = f'''# 1992 FBSH 练习样本第 1 步检查报告

状态：已执行并完成本次已确认范围的基础核对。规则版本：{VERSION}。

## 任务、来源与范围
仅处理上传的 `{SOURCE.name}`，共 80 条数据、13 个原始字段。全部为 Afghanistan（004）、1992 年，涉及 {len(item_names)} 个商品。规则依据用户确认的方案及上传清洗说明第 1 步；其余步骤不在本次授权范围。
SOURCE.txt 声明样本来自 FoodBalanceSheetsHistoric_E_All_Data_(Normalized).zip 中同名规范化 CSV，按地区、年份和六要素筛选后取前 80 行。本次未读取或核验该原始 ZIP；其版本、下载时间未知。三份上传文件的 SHA-256 见执行记录，运行前后均一致。
报告和 Source_row 中的行号只指这份练习 CSV：表头第 1 行，数据第 2–81 行。保持原顺序，一行输入对应一行输出。

## 已确认执行方案及实际变更
| 步骤 | 输入与规则 | 输出与核对 |
|---|---|---|
| 1 范围检查 | 本 CSV；1992 年；5511、5611、5911、5074、5142、5521 | 80 行均符合，无世界或区域合计，无筛除 |
| 2 编码整理 | 原字段保留；M49 去前导撇号补为三位；Item Code 解析整数 | 新增 Country_M49、FBSH_Item_Code 各 80 个；未连接比例表 |
| 3 单位与值状态 | 原单位全部 1000 t；Decimal 精确乘 1000；库存保留符号 | 新增 Value_t 和 Value_status 各 80 个；无插补、修正、合并 |
| 4 追溯与检查 | 附 Source_file、Source_row；按国家 M49—商品—要素—年份查重 | 原 13 列的 1040 个字段值逐格一致；80 行转换逐行读回验证 |

新增 6 列，输出 19 列。原值、Flag、Item Code (FBS) 及所有原始字段字符串均保留。删除、合并、插补、原值替换和隔离记录均为 0。逐记录变更由清洗 CSV 中原始列、派生列和源行号直接对应；机器可读步骤计数见执行记录。

## 质量检查
| 检查 | 处理前 | 处理后 |
|---|---:|---:|
| 数据行数 | 80 | 80 |
| 原始字段空白总数 | {sum(blank_counts.values())} | {sum(blank_counts.values())} |
| 完全重复的额外行 | {original_duplicates} | {original_duplicates} |
| 业务重复键 | {len(duplicates)} | {len(duplicates)} |
| 明确报零 | {len(zeros)} | {len(zeros)} |
| 负值 | {len(negatives)} | {len(negatives)} |
| 数值可解析记录 | 80 | 80 |

六要素代码与名称全部对应，Year Code 与 Year 全部一致。所有原始 Unit 为 1000 t，新增 Value_t 单位为 t。原值范围为 {min(Decimal(r['Value']) for r in rows)} 至 {max(Decimal(r['Value']) for r in rows)}（1000 t）。所有已执行基础检查均通过，详细布尔结果见执行记录。

负值逐行核对（保留库存原符号）：

| 练习 CSV 行号 | 商品 | 要素 | 原值（1000 t） | 吨值（t） |
|---|---|---|---:|---:|
{negative_table}

明确报零行号：{', '.join(zeros)}。

## 缺失与使用限制
23 个已出现商品 × 6 要素共有 138 种组合，其中 {len(absent)} 种未出现在此截断样本，已另列 `未出现组合_v1.csv`，状态为 not_in_sample。它们没有原行号，未添加到清洗表，未填零；不能判定其在完整原始数据中是否缺失。

CSV 不保存强制字段类型。Country_M49 在文件中为 004；下游导入时必须按文本读取以保留前导零，FBSH_Item_Code 按整数读取，Value_t 按十进制数读取。其余类型、单位和状态定义见字段字典。UTF-8 BOM 编码。

本次完成仅指样本第 1 步。未估算 SUA，未校验固定比例映射覆盖，未生成正式模型输入，未对完整说明中的下游验收项作通过判断。没有额外确认的数值容差或质量阈值。下游若开展正式计算，需要完整原始数据及固定比例版本；本次成果仅供练习规则验证，使用时绑定 {VERSION} 与源文件哈希。
'''
    targets[1].write_text(report, encoding='utf-8-sig')
    print(json.dumps({'status':'completed', 'rows':len(saved), 'columns':len(fields+ADDED),
                      'zero_rows':len(zeros), 'negative_rows':len(negatives), 'absent_combinations':len(absent),
                      'checks':checks, 'outputs':[p.name for p in targets]}, ensure_ascii=False))

if __name__ == '__main__':
    main()
