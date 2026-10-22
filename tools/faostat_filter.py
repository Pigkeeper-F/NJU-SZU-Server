"""Stream a FAOSTAT TM ZIP into year-specific CSVs without changing cell values."""
import argparse
import csv
import hashlib
import io
import json
import os
import stat
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath
import unicodedata

MAX_OUTPUT = 2 * 1024 ** 3
MAX_UNCOMPRESSED = 32 * 1024 ** 3
FILTER_COLUMNS = {
    "reporterCodes": "Reporter Country Code",
    "partnerCodes": "Partner Country Code",
    "itemCodes": "Item Code",
    "elementCodes": "Element Code",
    "elementNames": "Element",
}
NAME_FILTERS = {
    "itemNames": ("itemCodes", "_ItemCodes.csv", "Item Code", "Item"),
    "reporterNames": ("reporterCodes", "_ReporterCountries.csv", "Reporter Country Code", "Reporter Countries"),
    "partnerNames": ("partnerCodes", "_PartnerCountries.csv", "Partner Country Code", "Partner Countries"),
    "elementNames": ("elementCodes", "_Elements.csv", "Element Code", "Element"),
}
QUERY_ALIASES = {"小麦": "Wheat", "进口数量": "Import quantity", "进口量": "Import quantity", "出口数量": "Export quantity", "出口量": "Export quantity"}


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def file_sha(file):
    result = hashlib.sha256()
    with open(file, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def local_path(value):
    absolute = os.path.abspath(value)
    if os.name == "nt" and not absolute.startswith("\\\\?\\"):
        return "\\\\?\\UNC\\" + absolute[2:] if absolute.startswith("\\\\") else "\\\\?\\" + absolute
    return absolute


def normalized_name(value):
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def resolve_official_config(package, config):
    """Resolve exact names using dictionaries inside the same original ZIP."""
    filters = {key: list(values) for key, values in (config.get("filters") or {}).items()}
    mappings = []
    for name_key, (code_key, suffix, code_column, name_column) in NAME_FILTERS.items():
        requested = filters.pop(name_key, [])
        # Code-only configurations remain valid; exact-name resolution is only needed for names.
        if not requested:
            continue
        candidates = [entry for entry in package.infolist() if entry.filename.lower().endswith(suffix.lower())]
        if len(candidates) != 1 or candidates[0].file_size > 64 * 1024 * 1024:
            raise ValueError("缺少唯一的官方名称字典：" + suffix)
        member = candidates[0]
        with package.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="", errors="strict") as text:
            reader = csv.DictReader(text)
            if not reader.fieldnames or code_column not in reader.fieldnames or name_column not in reader.fieldnames:
                raise ValueError("官方字典字段不完整：" + member.filename)
            rows = []
            for row in reader:
                if len(rows) >= 100000:
                    raise ValueError("官方字典行数异常")
                if row.get(code_column) and row.get(name_column):
                    rows.append((reader.line_num, row))
        matched_codes = set()
        for value in requested:
            query = QUERY_ALIASES.get(value, value)
            matches = [(line, row) for line, row in rows if normalized_name(row[name_column]) == normalized_name(query)]
            unique = {(row[code_column], normalized_name(row[name_column])) for _, row in matches}
            if not matches:
                raise ValueError(f"官方字典未精确匹配名称 {value!r}；未采用子串或相似商品替代（{member.filename}）")
            if name_key != "elementNames" and len(unique) != 1:
                choices = "; ".join(f"{row[name_column]} [{row[code_column]}]" for _, row in matches)
                raise ValueError(f"官方名称 {value!r} 对应多个条目，请选择：{choices}")
            for line, row in matches:
                matched_codes.add(row[code_column])
                mappings.append({"field": name_key, "requested": value, "query": query, "name": row[name_column], "code": row[code_column],
                                 "sourceFile": member.filename, "sourceRow": line, "unit": row.get("Unit")})
        if filters.get(code_key):
            selected = matched_codes.intersection(filters[code_key])
            if not selected:
                raise ValueError("方案中的名称与明确代码冲突：" + name_key)
            filters[code_key] = sorted(selected)
        else:
            filters[code_key] = sorted(matched_codes)
    resolved = {**config, "filters": filters}
    return resolved, mappings


def filter_archive(archive, config, output_dir, on_progress=emit):
    years = config.get("years")
    if not isinstance(years, list) or not 1 <= len(years) <= 20 or any(type(y) is not int or not 1961 <= y <= 2100 for y in years) or len(set(years)) != len(years):
        raise ValueError("筛选年份无效")
    filters = config.get("filters") or {}
    if any(key not in set(FILTER_COLUMNS) | set(NAME_FILTERS) for key in filters):
        raise ValueError("存在不支持的筛选条件")
    if any(not isinstance(values, list) or len(values) > 1000 or any(not isinstance(v, str) or not v or len(v) > 100 for v in values) for values in filters.values()):
        raise ValueError("筛选代码或指标格式无效")
    archive = local_path(archive)
    output_dir = Path(local_path(output_dir))
    output_dir.mkdir(parents=True, exist_ok=True)
    handles = {}
    paths = {}
    rows_read = rows_selected = 0
    counts = Counter()
    seen_years = Counter()
    units_by_element = Counter()
    csv.field_size_limit(1024 * 1024)
    try:
        with zipfile.ZipFile(archive) as package:
            entries = package.infolist()
            if not 1 <= len(entries) <= 100:
                raise ValueError("压缩包文件数量异常")
            names = set()
            for entry in entries:
                name = entry.filename.replace("\\", "/")
                parts = PurePosixPath(name).parts
                if name.startswith("/") or ":" in name or ".." in parts or stat.S_ISLNK(entry.external_attr >> 16) or name in names:
                    raise ValueError("压缩包包含不安全或重复的文件名")
                names.add(name)
                if entry.flag_bits & 1:
                    raise ValueError("不支持加密的官方压缩包")
            candidates = [e for e in entries if not e.is_dir() and e.filename.lower().endswith(".csv") and "normalized" in e.filename.lower()]
            if len(candidates) != 1:
                candidates = [e for e in entries if not e.is_dir() and e.filename.lower().endswith(".csv") and "trade" in e.filename.lower() and "matrix" in e.filename.lower()]
            if len(candidates) != 1:
                raise ValueError("无法唯一识别贸易矩阵主CSV，未猜选文件")
            member = candidates[0]
            if member.file_size <= 0 or member.file_size > MAX_UNCOMPRESSED:
                raise ValueError("主CSV大小异常或超过32GiB处理上限")
            for entry in entries:
                if entry is member or entry.is_dir():
                    continue
                if entry.file_size > 64 * 1024 * 1024:
                    raise ValueError("配套代码文件大小异常")
                with package.open(entry) as extra:
                    for _ in iter(lambda: extra.read(1024 * 1024), b""):
                        pass
            resolved_config, official_mappings = resolve_official_config(package, config)
            filters = resolved_config["filters"]
            if official_mappings:
                on_progress(stage="lookup", resolvedConfig=resolved_config, officialMappings=official_mappings,
                            message="已从官方字典核对名称与代码：" + "; ".join(dict.fromkeys(f"{m['requested']} → {m['name']} [{m['code']}]" for m in official_mappings)))
            with package.open(member) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="", errors="strict") as text:
                reader = csv.reader(text, strict=True)
                header = next(reader)
                if len(set(header)) != len(header) or "Year" not in header:
                    raise ValueError("原始CSV缺少Year或包含重复字段")
                year_index = header.index("Year")
                conditions = []
                for key, values in filters.items():
                    if values:
                        column = FILTER_COLUMNS[key]
                        if column not in header:
                            raise ValueError("原始CSV缺少筛选字段：" + column)
                        conditions.append((header.index(column), set(values)))
                writers = {}
                for year in years:
                    file = output_dir / f"FAOSTAT_TM_{year}.csv"
                    paths[year] = file
                    handles[year] = open(file, "x", encoding="utf-8-sig", newline="")
                    writers[year] = csv.writer(handles[year])
                    writers[year].writerow(header)
                wanted = {str(year): year for year in years}
                last = time.monotonic()
                on_progress(stage="filter", rowsRead=0, rowsSelected=0, member=member.filename, uncompressedBytes=member.file_size)
                for row in reader:
                    rows_read += 1
                    if len(row) != len(header):
                        raise ValueError(f"原始CSV第{rows_read + 1}行字段数量异常，未跳过")
                    year_text = row[year_index]
                    if len(year_text) != 4 or not year_text.isdigit():
                        raise ValueError(f"原始CSV第{rows_read + 1}行年份异常")
                    seen_years[year_text] += 1
                    selected = wanted.get(year_text)
                    if selected is not None and all(row[index] in accepted for index, accepted in conditions):
                        writers[selected].writerow(row)
                        counts[selected] += 1
                        rows_selected += 1
                        if "Unit" in header and "Element Code" in header and "Element" in header:
                            units_by_element[(row[header.index("Element Code")], row[header.index("Element")], row[header.index("Unit")])] += 1
                    if rows_read % 100000 == 0:
                        for year, handle in handles.items():
                            handle.flush()
                            if os.fstat(handle.fileno()).st_size > MAX_OUTPUT:
                                raise ValueError(f"{year}年结果超过2GiB上限")
                        if time.monotonic() - last > 0.7:
                            last = time.monotonic()
                            on_progress(stage="filter", rowsRead=rows_read, rowsSelected=rows_selected)
                # Reading the selected member to EOF verifies ZIP CRC; no archive members are extracted.
            missing = [str(year) for year in years if not counts[year]]
            if missing:
                raise ValueError("指定年份及条件下没有数据：" + ", ".join(missing))
            for handle in handles.values():
                handle.flush()
                os.fsync(handle.fileno())
                if os.fstat(handle.fileno()).st_size > MAX_OUTPUT:
                    raise ValueError("结果超过2GiB上限")
                handle.close()
            handles.clear()
            files = [{"name": paths[year].name, "year": year, "rows": counts[year], "size": paths[year].stat().st_size, "sha256": file_sha(paths[year])} for year in years]
            result = {"schema": 1, "dataset": "TM", "years": years, "filters": filters, "resolvedConfig": resolved_config, "officialMappings": official_mappings,
                      "unitsByElement": [{"elementCode": code, "element": name, "unit": unit, "rows": total} for (code, name, unit), total in sorted(units_by_element.items())], "member": member.filename,
                      "memberCRC32": f"{member.CRC:08x}", "zipCRCVerified": True, "sourceRows": rows_read,
                      "rowsSelected": rows_selected, "sourceYearCounts": dict(sorted(seen_years.items())), "columns": header,
                      "files": files, "method": "保留全部原始字段及单元格文本，仅按年份和明确条件筛选；未换算、插补、去重或合并。CSV按标准格式重新序列化。"}
            on_progress(stage="filtered", rowsRead=rows_read, rowsSelected=rows_selected)
            return result
    finally:
        for handle in handles.values():
            handle.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    config = json.loads(Path(local_path(args.config)).read_text(encoding="utf-8-sig"))
    result = filter_archive(args.archive, config, args.output_dir)
    Path(local_path(args.report)).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    emit(stage="completed", rowsRead=result["sourceRows"], rowsSelected=result["rowsSelected"])


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(stage="failed", error=str(error))
        sys.exit(1)
