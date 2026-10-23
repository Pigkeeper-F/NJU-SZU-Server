"""Original-format material manifests, local reuse and bounded offline readers.

This module never opens a browser, follows a URL, executes Office content or
extracts ZIP members onto the filesystem. Downloading and reading are separate
states. Observed download URLs live only in the current store's memory.
"""
from __future__ import annotations

import copy
import csv
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import io
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import unicodedata
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
import zipfile

from literature_fulltext_reuse import contained_file, identity, match_identity, inspect_saved, UUID, _reparse


VERSION = 1
MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
DEFAULT_MAX_CHARS = 100000
MAX_ROWS = 2000
MAX_CELLS = 10000
MAX_ZIP_MEMBERS = 100
MAX_ZIP_MEMBER_BYTES = 16 * 1024 * 1024
MAX_ZIP_EXPANDED_BYTES = 32 * 1024 * 1024
MAX_ZIP_RATIO = 200
ROLES = {"main_pdf", "main_html", "supplement"}
DOWNLOAD_STATES = {"pending", "downloaded", "missing", "needs_attention"}
CHECK_STATES = {"uninspected", "checked", "none_declared", "none_found", "unknown", "needs_attention"}
READ_STATES = {"not_checked", "readable", "partial", "unreadable", "unsupported"}


class MaterialsError(ValueError):
    pass


def _now():
    return datetime.now(timezone.utc).isoformat()


def _norm(value):
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).casefold()


def _sha(blob):
    return hashlib.sha256(blob).hexdigest()


def _reason(value):
    text = re.sub(r"https?://\S+", "[链接已省略]", str(value or ""))
    return re.sub(r"\b(?:token|sid|session|password|api[_-]?key)\s*[=:]\s*\S+", "[敏感值已省略]", text, flags=re.I)[:1000]


def _filename(value):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value or "material.bin")).strip(" .")[:180]
    if not name:
        name = "material.bin"
    if name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        name = "_" + name
    return name


def _format(filename, supplied="", mime=""):
    extension = Path(str(filename or "")).suffix.lower().lstrip(".")
    value = str(supplied or extension).lower().lstrip(".")
    if value in {"bin", "aspx", "ashx", "php", "download"} and extension not in {"", "bin", "aspx", "ashx", "php", "download"}:
        value = extension
    if value in {"htm", "xhtml"}:
        return "html"
    if value in {"text", "plain", "html_text"}:
        return "txt"
    if not value or value in {"bin", "aspx", "ashx", "php", "download"}:
        known = {"application/pdf": "pdf", "text/csv": "csv", "text/tab-separated-values": "tsv",
            "application/zip": "zip", "text/plain": "txt", "text/html": "html",
            "application/json": "json", "application/xml": "xml",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"}
        value = known.get(str(mime).split(";")[0].lower(), value or "bin")
    return value


def _safe_path(job_dir, relative):
    raw = Path(str(relative or ""))
    if len(raw.parts) < 3 or raw.parts[0].casefold() != "fulltext" or raw.parts[1].casefold() not in {"files", "materials"}:
        return None
    return contained_file(job_dir, relative)


def _read_json(job_dir, relative):
    path = contained_file(job_dir, relative)
    if path is None:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _atomic_bytes(path, blob):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".material-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _new_file(job_dir, paper_id, material_id, filename, blob):
    job_dir = Path(job_dir).absolute()
    stem = re.sub(r"[^0-9A-Za-z._-]", "_", str(paper_id)).strip("._")[:80] or "paper"
    folder = job_dir / "fulltext" / "materials" / stem / material_id
    current = job_dir.parent
    for part in (job_dir.name, "fulltext", "materials", stem, material_id):
        current = current / part
        if _reparse(current):
            raise MaterialsError("材料目录包含链接或重解析目录，未写入文件。")
    if _reparse(job_dir.parent):
        raise MaterialsError("任务目录无法安全核验，未写入材料。")
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / _filename(filename)
    digest = _sha(blob)
    if destination.exists() or _reparse(destination):
        relative = destination.relative_to(job_dir).as_posix()
        existing = _safe_path(job_dir, relative)
        if existing is not None and _sha(existing.read_bytes()) == digest:
            return relative
        destination = folder / f"{destination.stem}.{digest[:16]}{destination.suffix}"
        if destination.exists() or _reparse(destination):
            existing = _safe_path(job_dir, destination.relative_to(job_dir).as_posix())
            if existing is None or _sha(existing.read_bytes()) != digest:
                raise MaterialsError("已有材料文件内容冲突，未覆盖原件。")
            return destination.relative_to(job_dir).as_posix()
    _atomic_bytes(destination, blob)
    return destination.relative_to(job_dir).as_posix()


def _material_file(job_dir, material):
    path = _safe_path(job_dir, material.get("path"))
    if path is None:
        return None
    try:
        if path.stat().st_size > MAX_DOWNLOAD_BYTES:
            raise MaterialsError("已存材料超过128MB本地校验上限，原文件保留，请人工核查。")
        blob = path.read_bytes()
    except OSError as error:
        raise MaterialsError("已存材料暂不可读，原文件保留，请稍后核查。") from error
    if (type(material.get("size")) is not int or material["size"] != len(blob)
        or not re.fullmatch(r"[0-9a-f]{64}", str(material.get("sha256") or ""))
        or _sha(blob) != material["sha256"]):
        raise MaterialsError("已存材料与清单大小或SHA256不符，原件保留，不会重新下载。")
    return blob


class _Text:
    def __init__(self, limit):
        self.limit = max(1, min(int(limit), 1000000))
        self.parts, self.locations, self.reasons = [], [], []
        self.chars = 0

    def note(self, reason):
        if reason not in self.reasons:
            self.reasons.append(reason)

    def add(self, text, position):
        text = ("" if text is None else str(text)).strip()
        if not text:
            return True
        separator = 1 if self.parts else 0
        available = self.limit - self.chars - separator
        if available <= 0:
            self.note(f"读取文字达到{self.limit}字符上限，原文件完整保留。")
            return False
        chosen = text[:available]
        start = self.chars + separator
        self.parts.append(chosen)
        self.chars = start + len(chosen)
        self.locations.append({"position": position, "start": start, "end": self.chars})
        if len(chosen) < len(text):
            self.note(f"读取文字达到{self.limit}字符上限，原文件完整保留。")
            return False
        return True

    def result(self, *, unsupported=False):
        text = "\n".join(self.parts)
        state = "unsupported" if unsupported else ("partial" if text and self.reasons else "readable" if text else "unreadable")
        if not text and not self.reasons:
            self.note("未读出有效文字，可能为空文件或扫描图片；原件保留。")
        return {"read_status": state, "read_reason": "；".join(self.reasons),
                "text": text, "locations": self.locations}


def _decode(blob):
    encodings = ["utf-8-sig"]
    if blob.startswith((b"\xff\xfe", b"\xfe\xff")):
        encodings.insert(0, "utf-16")
    else:
        if b"\x00" in blob[:4096]:
            raise ValueError("Binary text")
        encodings.append("gb18030")
    for encoding in encodings:
        try:
            return blob.decode(encoding), encoding
        except UnicodeError:
            continue
    raise ValueError("Unsupported text encoding")


def _xml(blob):
    if b"<!DOCTYPE" in blob.upper() or b"<!ENTITY" in blob.upper():
        raise ValueError("XML declarations are not read")
    return ET.fromstring(blob)


def _safe_members(archive, output):
    total = 0
    found = archive.infolist()
    if len(found) > MAX_ZIP_MEMBERS:
        output.note(f"压缩包成员超过{MAX_ZIP_MEMBERS}个，仅检查首批，原包完整保留。")
    for member in found[:MAX_ZIP_MEMBERS]:
        name = member.filename.replace("\\", "/")
        path = PurePosixPath(name)
        mode = (member.external_attr >> 16) & 0xFFFF
        if (path.is_absolute() or ".." in path.parts or re.match(r"^[A-Za-z]:", name)
            or stat.S_ISLNK(mode) or member.flag_bits & 1):
            output.note("压缩包含不安全路径、链接或加密成员，未读取这些成员。")
            continue
        if member.is_dir():
            continue
        total += member.file_size
        if (member.file_size > MAX_ZIP_MEMBER_BYTES or total > MAX_ZIP_EXPANDED_BYTES
            or member.file_size / max(1, member.compress_size) > MAX_ZIP_RATIO):
            output.note("压缩包达到成员大小、展开总量或压缩比限制，未继续读取超限成员。")
            continue
        yield member


class _HTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1
        elif tag in {"p", "div", "br", "tr", "li", "h1", "h2", "h3"}:
            self.parts.append("\n")
    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"} and self.hidden:
            self.hidden -= 1
    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _read_blob(blob, format_name, output, *, max_rows, max_cells, depth=0, prefix=None):
    prefix = dict(prefix or {})
    def position(**values):
        return {**prefix, **values}
    if format_name in {"xls", "doc", "caj", "bin", "png", "jpg", "jpeg", "tif", "tiff", "gif", "bmp"}:
        output.note("此格式暂未接入结构读取或OCR，原始文件已保留。")
        return False
    if format_name == "pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(blob), strict=False)
            if reader.is_encrypted and not reader.decrypt(""):
                output.note("PDF需要密码，未绕过加密；原件保留。")
                return True
            count = len(reader.pages)
            if count > 1000:
                output.note("PDF超过1000页，仅检查首批页，原件完整保留。")
            for index in range(min(count, 1000)):
                text = reader.pages[index].extract_text() or ""
                if not text.strip():
                    output.note("部分PDF页未读出文字，可能含扫描页或图像，未执行OCR。")
                if not output.add(text, position(kind="page", page=index + 1)):
                    break
        except ImportError:
            output.note("本地缺少PDF读取依赖，原件保留。")
        except Exception:
            output.note("PDF文字暂不可读或加密依赖不足，不能据此认定文件未下载；请人工核查。")
        return True
    if format_name == "xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError:
            output.note("本地缺少Excel读取依赖，原始工作簿保留。")
            return False
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            safe = list(_safe_members(archive, output))
            if len(safe) != len([member for member in archive.infolist() if not member.is_dir()]):
                output.note("工作簿内部成员未全部通过安全限制，未打开工作簿。")
                return True
        workbook = load_workbook(io.BytesIO(blob), read_only=True, data_only=False, keep_links=False)
        cells = 0
        try:
            for sheet in workbook.worksheets:
                for row_index, cells_row in enumerate(sheet.iter_rows(), 1):
                    if row_index > max_rows:
                        output.note(f"工作表读取达到{max_rows}行上限，剩余行未进入本次文本。")
                        break
                    for cell in cells_row:
                        if cell.value is None:
                            continue
                        cells += 1
                        if cells > max_cells:
                            output.note(f"工作簿读取达到{max_cells}个非空单元格上限。")
                            return True
                        if cell.data_type == "f":
                            output.note("工作簿包含公式，保留公式文字，未执行重算。")
                        if not output.add(cell.value, position(kind="cell", sheet=sheet.title, cell=cell.coordinate,
                                                              row=cell.row, column=cell.column)):
                            return True
            return True
        finally:
            workbook.close()
    if format_name == "docx":
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            safe = {member.filename: member for member in _safe_members(archive, output)}
            parts = [name for name in safe if re.fullmatch(r"word/(?:document|footnotes|endnotes|header\d+|footer\d+|comments)\.xml", name)]
            if any(name.startswith("word/media/") for name in archive.namelist()):
                output.note("Word含图片，仅读取可提取文字和表格，未执行图像OCR。")
            if any(name.startswith("word/embeddings/") for name in archive.namelist()):
                output.note("Word含嵌入对象，未执行或读取嵌入对象，原件保留。")
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            table_count = paragraph_count = cell_count = 0
            for name in sorted(parts):
                root = _xml(archive.read(safe[name]))
                parent_map = {child: parent for parent in root.iter() for child in parent}
                for element in root.iter():
                    local = element.tag.rsplit("}", 1)[-1]
                    if local == "tbl":
                        table_count += 1
                        for row_index, table_row in enumerate(element.findall("w:tr", ns), 1):
                            if row_index > max_rows:
                                output.note(f"Word表格达到{max_rows}行读取上限。")
                                break
                            for column, cell in enumerate(table_row.findall("w:tc", ns), 1):
                                cell_count += 1
                                if cell_count > max_cells:
                                    output.note(f"Word达到{max_cells}个表格单元格读取上限。")
                                    return True
                                text = " ".join(node.text or "" for node in cell.findall(".//w:t", ns))
                                if not output.add(text, position(kind="table_cell", part=name, table=table_count, row=row_index, column=column)):
                                    return True
                    elif local == "p":
                        parent = parent_map.get(element)
                        in_table = False
                        while parent is not None:
                            if parent.tag.rsplit("}", 1)[-1] == "tbl":
                                in_table = True
                                break
                            parent = parent_map.get(parent)
                        if in_table:
                            continue
                        paragraph_count += 1
                        text = " ".join(node.text or "" for node in element.findall(".//w:t", ns))
                        if not output.add(text, position(kind="paragraph", part=name, paragraph=paragraph_count)):
                            return True
        return True
    if format_name == "zip":
        if depth:
            output.note("压缩包中的嵌套压缩包未展开，原包保留。")
            return False
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for member in _safe_members(archive, output):
                member_position = position(kind="zip_member", member=member.filename, size=member.file_size)
                if not output.add(f"压缩包成员：{member.filename}（{member.file_size}字节）", member_position):
                    break
                child_format = _format(member.filename)
                if not _read_blob(archive.read(member), child_format, output, max_rows=max_rows, max_cells=max_cells,
                                  depth=depth + 1, prefix={**prefix, "archive_member": member.filename}):
                    output.note("压缩包内部分成员格式暂不支持读取，原成员仍保留在原包中。")
        return True
    if format_name in {"csv", "tsv", "txt", "json", "xml", "html", "md", "ris", "bib"}:
        text, encoding = _decode(blob)
        if format_name in {"csv", "tsv"}:
            cells = 0
            for row_index, values in enumerate(csv.reader(io.StringIO(text), delimiter="\t" if format_name == "tsv" else ","), 1):
                if row_index > max_rows:
                    output.note(f"表格达到{max_rows}行读取上限。")
                    break
                for column, value in enumerate(values, 1):
                    cells += 1
                    if cells > max_cells:
                        output.note(f"表格达到{max_cells}个单元格读取上限。")
                        return True
                    if not output.add(value, position(kind="cell", row=row_index, column=column, encoding=encoding)):
                        return True
        elif format_name == "json":
            data = json.loads(text)
            count = 0
            def walk(value, path, level):
                nonlocal count
                if level > 40 or count >= max_cells:
                    output.note("JSON达到嵌套层级或条目读取上限。")
                    return
                if isinstance(value, dict):
                    for key, child in value.items():
                        walk(child, path + "[" + json.dumps(str(key), ensure_ascii=False) + "]", level + 1)
                elif isinstance(value, list):
                    for index, child in enumerate(value):
                        walk(child, f"{path}[{index}]", level + 1)
                else:
                    count += 1
                    output.add(json.dumps(value, ensure_ascii=False), position(kind="json_value", json_path=path))
            walk(data, "$", 0)
        elif format_name == "xml":
            root = _xml(blob)
            count = 0
            for element in root.iter():
                count += 1
                if count > max_cells:
                    output.note("XML达到条目读取上限。")
                    break
                if element.text and not output.add(element.text, position(kind="xml_element", element=element.tag, index=count)):
                    break
        else:
            if format_name == "html":
                parser = _HTML()
                parser.feed(text)
                text = "".join(parser.parts)
            for line, value in enumerate(text.splitlines(), 1):
                if line > max_rows:
                    output.note(f"文本达到{max_rows}行读取上限。")
                    break
                if not output.add(value, position(kind="line", line=line, encoding=encoding)):
                    break
        return True
    output.note("此原始格式暂未接入读取器，文件已保留，不能当作可读正文。")
    return False


def read_material(job_dir, material, *, max_chars=DEFAULT_MAX_CHARS, max_rows=MAX_ROWS, max_cells=MAX_CELLS):
    output = _Text(max_chars)
    if material.get("download_status") != "downloaded":
        output.note("材料尚未确认下载完成。")
        return output.result()
    try:
        blob = _material_file(job_dir, material)
        if blob is None:
            output.note("清单对应的原始文件缺失或路径无效，不能读取。")
            return output.result()
        supported = _read_blob(blob, _format(material.get("filename"), material.get("format"), material.get("mime_type")), output,
                               max_rows=max(1, min(int(max_rows), MAX_ROWS)), max_cells=max(1, min(int(max_cells), MAX_CELLS)))
        return output.result(unsupported=not supported)
    except MaterialsError as error:
        output.note(str(error))
    except Exception:
        output.note("此材料暂未通过对应格式的离线读取；原始文件保留，请人工核查。")
    return output.result()


def _file_like_url(url: str) -> bool:
    try:
        path = unquote(urlsplit(str(url or "")).path)
    except (ValueError, TypeError):
        return False
    suffix = re.compile(r"\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|zip|rar|7z|gz|tgz|txt|xml|json|png|jpe?g|tiff?|r|rds|sav|dta)$", re.I)
    return any(suffix.search(segment) for segment in path.split("/") if segment)


class MaterialsStore:
    def __init__(self, job_dir, targets):
        targets = list(targets)
        self.job_dir = Path(job_dir).absolute()
        self.path = self.job_dir / "fulltext" / "materials.json"
        loaded = _read_json(self.job_dir, "fulltext/materials.json")
        if self.path.exists() and (not isinstance(loaded, dict) or loaded.get("version") != VERSION or not isinstance(loaded.get("papers"), list)):
            raise MaterialsError("已有材料清单无法解析或版本不符，请先核查，未覆盖清单。")
        self.document = copy.deepcopy(loaded) if loaded else {"version": VERSION, "papers": []}
        self.targets = {str(record.get("paper_id") or record.get("candidate_id") or ""): record for record in targets}
        self.descriptors = {}
        for record in targets:
            self._paper(record)
        old_status = _read_json(self.job_dir, "fulltext/status.json")
        for item in (old_status or {}).get("items", []):
            if isinstance(item, dict) and item.get("paper_id") in self.targets:
                self.register_main(self.targets[item["paper_id"]], item, flush=False)

    def _paper(self, record):
        paper_id = str(record.get("paper_id") or record.get("candidate_id") or "")
        if not paper_id:
            raise MaterialsError("材料缺少所属文献标识。")
        matches = [paper for paper in self.document["papers"] if isinstance(paper, dict) and paper.get("paper_id") == paper_id]
        if len(matches) > 1:
            raise MaterialsError("材料清单有重复文献标识，请先核查。")
        if matches:
            return matches[0]
        paper = {"paper_id": paper_id, "title": str(record.get("title") or ""), "doi": str(record.get("doi") or ""),
                 "identity": identity(record), "reuse_disabled": bool(record.get("reuse_disabled")),
                 "main_pdf_status": "pending", "supplement_check": {"status": "uninspected", "reason": "尚未核查此文献的全部补充材料。"}, "materials": []}
        self.document["papers"].append(paper)
        return paper

    def paper(self, record):
        """Return this task's mutable paper record; flush explicitly after edits."""
        return self._paper(record)

    def completeness(self, record):
        """Whether every observed supplement for this paper is on disk.

        ``complete`` requires the article page to have been inspected and every
        observed supplement to have a verified/downloaded local file. A paper
        that declares no supplements is complete after a ``none_declared`` or
        ``checked`` inspection; an uninspected page is ``unverified``.
        """
        paper = self._paper(record)
        supplements = [material for material in paper.get("materials", [])
                       if material.get("role") == "supplement"]
        # When at least one real file URL was observed, fragment/landing links
        # are navigation duplicates, not additional attachments.
        file_like = [material for material in supplements
                     if _file_like_url(str((self.descriptors.get((paper["paper_id"], material.get("material_id"))) or {}).get("url") or ""))]
        if file_like:
            supplements = file_like
        downloaded = [material for material in supplements
                      if material.get("download_status") == "downloaded"
                      and _material_file(self.job_dir, material) is not None]
        pending = [material for material in supplements if material not in downloaded]
        check = paper.get("supplement_check") or {}
        state = str(check.get("status") or "uninspected")
        if state in {"checked", "none_declared", "none_found"} and not pending:
            status = "complete"
        elif state in {"checked", "none_declared", "none_found"}:
            status = "partial"
        else:
            status = "unverified"
        return {
            "status": status,
            "check_status": state,
            "expected": len(supplements),
            "downloaded": len(downloaded),
            "pending": len(pending),
            "missing": [
                {"material_id": str(material.get("material_id") or ""),
                 "label": str(material.get("label") or material.get("filename") or ""),
                 "download_status": str(material.get("download_status") or "")}
                for material in pending
            ],
        }

    def _descriptor(self, record, descriptor):
        role = descriptor.get("role") or "supplement"
        if role not in ROLES:
            raise MaterialsError("材料角色无效。")
        url = str(descriptor.get("url") or descriptor.get("source_url") or "")
        parsed = urlsplit(url)
        if url and (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password):
            raise MaterialsError("材料入口不是可核对的HTTP官方页面链接。")
        raw_name = descriptor.get("filename") or unquote(parsed.path.rsplit("/", 1)[-1]) or "material.bin"
        filename = _filename(raw_name)
        format_name = _format(filename, descriptor.get("format"), descriptor.get("mime_type"))
        label = _reason(descriptor.get("label") or filename)[:500]
        supplied_key = str(descriptor.get("source_key") or "")
        source_key = supplied_key if re.fullmatch(r"[0-9a-f]{64}", supplied_key) else (_sha((url or supplied_key).encode("utf-8")) if url or supplied_key else "")
        material_id = str(descriptor.get("material_id") or "")
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}", material_id):
            material_id = "material-" + _sha(json.dumps([role, label, filename, source_key], ensure_ascii=False).encode())[:24]
        value = {"material_id": material_id, "role": role, "label": label, "filename": filename,
                 "format": format_name, "mime_type": str(descriptor.get("mime_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream"),
                 "source_key": source_key}
        if url:
            value["url"] = url
        return value

    def _upsert(self, record, descriptor):
        paper = self._paper(record)
        descriptor = self._descriptor(record, descriptor)
        matches = [material for material in paper["materials"] if material.get("material_id") == descriptor["material_id"]]
        if not matches and descriptor.get("role") == "supplement":
            # The same attachment can be discovered first via a landing
            # fragment and later via its real file URL. Merge by label+filename
            # and upgrade the recorded URL to the file-like one.
            matches = [material for material in paper["materials"]
                       if material.get("role") == "supplement"
                       and material.get("label") == descriptor.get("label")
                       and material.get("filename") == descriptor.get("filename")]
        if len(matches) > 1:
            raise MaterialsError("同一文献的材料标识重复，请先核查。")
        if matches:
            material = matches[0]
            existing = self.descriptors.get((paper["paper_id"], material["material_id"])) or {}
            old_url = str(existing.get("url") or "")
            new_url = str(descriptor.get("url") or "")
            if new_url and (not old_url or (_file_like_url(new_url) and not _file_like_url(old_url))):
                existing.update({"url": new_url,
                                 "mime_type": descriptor.get("mime_type") or existing.get("mime_type"),
                                 "format": descriptor.get("format") or existing.get("format"),
                                 "label": descriptor.get("label") or existing.get("label"),
                                 "filename": descriptor.get("filename") or existing.get("filename"),
                                 "source_key": descriptor.get("source_key") or existing.get("source_key")})
                self.descriptors[(paper["paper_id"], material["material_id"])] = existing
        else:
            material = {key: value for key, value in descriptor.items() if key != "url"}
            material.update(path="", size=0, sha256="", download_status="pending", read_status="not_checked", read_reason="")
            paper["materials"].append(material)
        self.descriptors[(paper["paper_id"], material["material_id"])] = descriptor
        return paper, material, descriptor

    def register_main(self, record, item, *, flush=True):
        if item.get("status") not in {"fetched_pdf", "fetched_html"}:
            return None
        role = "main_pdf" if item["status"] == "fetched_pdf" else "main_html"
        descriptor = {"material_id": role.replace("_", "-"), "role": role,
                      "label": "正文PDF" if role == "main_pdf" else "网页正文文本（非原始HTML文件）",
                      "filename": Path(str(item.get("path") or "main.txt")).name,
                      "format": "pdf" if role == "main_pdf" else "txt"}
        paper, material, _ = self._upsert(record, descriptor)
        if role == "main_html":
            checked = inspect_saved(self.job_dir, item, record, for_reuse=False)
            if checked["status"] != "valid":
                material.update(download_status="needs_attention", download_reason=_reason(checked["reason"]),
                                read_status="unreadable", read_reason=_reason(checked["reason"]))
                if flush:
                    self.flush()
                return material
        path = _safe_path(self.job_dir, item.get("path"))
        if path is None:
            material.update(download_status="missing", read_status="not_checked", read_reason="原全文状态对应的文件缺失或路径无效。")
            if role == "main_pdf":
                paper["main_pdf_status"] = "missing"
        else:
            if path.stat().st_size > MAX_DOWNLOAD_BYTES:
                raise MaterialsError("正文文件超过128MB材料校验上限，原件保留，请人工核查。")
            blob = path.read_bytes()
            recorded = item.get("content_sha256") or item.get("observed_content_sha256")
            size_mismatch = type(item.get("size")) is int and item["size"] > 0 and item["size"] != len(blob)
            if (recorded and recorded != _sha(blob)) or size_mismatch:
                material.update(download_status="needs_attention", read_status="unreadable", read_reason="正文文件大小或SHA与原状态不符，需核查。")
                if role == "main_pdf":
                    paper["main_pdf_status"] = "needs_attention"
            else:
                if material.get("sha256") != _sha(blob) or material.get("path") != str(item["path"]):
                    material.update(read_status="not_checked", read_reason="")
                material.update(path=str(item["path"]), size=len(blob), sha256=_sha(blob), download_status="downloaded")
                if role == "main_pdf":
                    paper["main_pdf_status"] = "downloaded"
        if flush:
            self.flush()
        return material

    def record_discovery(self, record, discovery):
        paper = self._paper(record)
        discovery = discovery if isinstance(discovery, dict) else {"status": "unknown", "reason": "补充材料发现结果无法核查。"}
        state = discovery.get("status") or "unknown"
        state = "none_declared" if state in {"none", "no_supplements"} else state
        if state not in CHECK_STATES:
            state = "unknown"
        entries = discovery.get("supplements") if isinstance(discovery.get("supplements"), list) else discovery.get("links") or []
        observed = []
        for descriptor in entries:
            if isinstance(descriptor, dict):
                _, _, normalized = self._upsert(record, {**descriptor, "role": "supplement"})
                observed.append(normalized)
        if observed and state == "none_declared":
            state = "checked"
        previous = paper.get("supplement_check", {}).get("status")
        if not (state in {"unknown", "uninspected"} and previous in {"checked", "none_declared"}):
            paper["supplement_check"] = {"status": state, "reason": _reason(discovery.get("reason"))}
        if discovery.get("main_pdf_status") in {"pending", "downloaded", "missing", "needs_attention"}:
            paper["main_pdf_status"] = discovery["main_pdf_status"]
        self.flush()
        return observed

    def pending_supplements(self, record):
        paper = self._paper(record)
        candidates = []
        for material in paper["materials"]:
            if material.get("role") != "supplement":
                continue
            if material.get("download_status") == "downloaded" and _material_file(self.job_dir, material) is not None:
                continue
            descriptor = self.descriptors.get((paper["paper_id"], material["material_id"]))
            if descriptor is not None:
                candidates.append((copy.deepcopy(descriptor), _file_like_url(str(descriptor.get("url") or ""))))
        if any(file_like for _, file_like in candidates):
            return [descriptor for descriptor, file_like in candidates if file_like]
        return [descriptor for descriptor, _ in candidates]

    def _fingerprint(self, material):
        return (material.get("role"), _norm(material.get("label")), _norm(material.get("filename")), material.get("format"))

    def find_reusable(self, record, descriptor):
        paper, material, descriptor = self._upsert(record, descriptor)
        if material.get("download_status") == "downloaded":
            if _material_file(self.job_dir, material) is not None:
                return material
        fingerprint = self._fingerprint(descriptor)
        matches = []
        if record.get("reuse_disabled"):
            return None
        for folder in sorted(self.job_dir.parent.iterdir(), key=lambda path: path.name):
            same_job = folder == self.job_dir
            if not folder.is_dir() or _reparse(folder) or (not same_job and not UUID.fullmatch(folder.name)):
                continue
            metadata = _read_json(folder, "job.json")
            if not same_job and (not isinstance(metadata, dict) or metadata.get("deletedAt") or metadata.get("status") in {"running", "preparing"}):
                continue
            document = self.document if same_job else _read_json(folder, "fulltext/materials.json")
            if not isinstance(document, dict) or document.get("version") != VERSION or not isinstance(document.get("papers"), list):
                continue
            try:
                if same_job:
                    source_targets = self.targets
                else:
                    from literature_fulltext import load_targets
                    config = _read_json(folder, "run_config.json")
                    if not isinstance(config, dict):
                        continue
                    input_path = "dedupe/dedupe.json" if (folder / "dedupe/dedupe.json").exists() else "candidates.json"
                    if contained_file(folder, input_path) is None:
                        continue
                    source_targets = {target["paper_id"]: target for target in load_targets(folder, config)}
            except (OSError, ValueError, KeyError):
                continue
            for source_paper in document.get("papers", []):
                if not isinstance(source_paper, dict) or not isinstance(source_paper.get("materials"), list):
                    continue
                source_target = source_targets.get(source_paper.get("paper_id"))
                if not source_target or source_target.get("reuse_disabled") or not match_identity(identity(source_target), identity(record)):
                    continue
                for source in source_paper.get("materials", []):
                    if not isinstance(source, dict) or source is material or source.get("download_status") != "downloaded":
                        continue
                    same_observed_link = bool(source.get("source_key") and source.get("source_key") == descriptor.get("source_key")
                                              and source.get("role") == descriptor.get("role"))
                    if not same_observed_link and self._fingerprint(source) != fingerprint:
                        continue
                    blob = _material_file(folder, source)
                    if blob is not None:
                        matches.append((folder, source_paper, source, blob))
        if not matches:
            return None
        if len({source[2]["sha256"] for source in matches}) != 1:
            raise MaterialsError("同篇同名材料存在不同版本，未自动选择，请人工确认。")
        folder, source_paper, source, blob = matches[0]
        relative = _new_file(self.job_dir, paper["paper_id"], material["material_id"], source["filename"], blob)
        material.update(path=relative, filename=source["filename"], format=source["format"], mime_type=source.get("mime_type") or descriptor["mime_type"],
                        size=len(blob), sha256=_sha(blob), download_status="downloaded", read_status=source.get("read_status") or "not_checked",
                        read_reason=source.get("read_reason") or "", reused_from={"job_id": folder.name, "paper_id": source_paper["paper_id"],
                        "material_id": source["material_id"], "sha256": source["sha256"], "reused_at": _now()})
        self.flush()
        return material

    def save_download(self, record, descriptor, result):
        paper, material, descriptor = self._upsert(record, descriptor)
        blob = result.get("bytes")
        if not isinstance(blob, bytes):
            source = _safe_path(self.job_dir, result.get("path"))
            if source is None or source.stat().st_size > MAX_DOWNLOAD_BYTES:
                raise MaterialsError("未收到可核对的原始材料文件。")
            blob = source.read_bytes()
        if not blob or len(blob) > MAX_DOWNLOAD_BYTES:
            raise MaterialsError("材料为空或超过128MB单文件上限，未把它标为已下载。")
        filename = _filename(result.get("filename") or result.get("suggested_filename") or descriptor["filename"])
        relative = _new_file(self.job_dir, paper["paper_id"], material["material_id"], filename, blob)
        material.update(filename=filename, format=_format(filename, result.get("format") or ("" if result.get("filename") or result.get("suggested_filename") else descriptor.get("format")), result.get("mime_type") or descriptor.get("mime_type")),
                        mime_type=str(result.get("mime_type") or descriptor["mime_type"]), path=relative, size=len(blob), sha256=_sha(blob),
                        download_status="downloaded", downloaded_at=_now())
        material.pop("reused_from", None)
        read = read_material(self.job_dir, material)
        material.update(read_status=read["read_status"], read_reason=read["read_reason"])
        if material["role"] == "main_pdf":
            paper["main_pdf_status"] = "downloaded"
        self.flush()
        return material

    def mark_problem(self, record, descriptor, status="needs_attention", reason=""):
        paper, material, _ = self._upsert(record, descriptor)
        if status not in DOWNLOAD_STATES:
            raise MaterialsError("材料下载状态无效。")
        material.update(download_status=status, download_reason=_reason(reason), read_status="not_checked", read_reason=_reason(reason))
        if material["role"] == "main_pdf":
            paper["main_pdf_status"] = status
        self.flush()
        return material

    def read_materials(self, record, **limits):
        results = []
        for material in self._paper(record)["materials"]:
            read = read_material(self.job_dir, material, **limits)
            material.update(read_status=read["read_status"], read_reason=read["read_reason"])
            results.append({**copy.deepcopy(material), "content": {"text": read["text"], "locations": read["locations"]}})
        self.flush()
        return results

    def paper_ready(self, record):
        paper = self._paper(record)
        main = paper.get("main_pdf_status") == "downloaded" or (paper.get("main_pdf_status") == "missing"
            and any(material.get("role") == "main_html" and material.get("download_status") == "downloaded" for material in paper["materials"]))
        checked = paper.get("supplement_check", {}).get("status") in {"checked", "none_declared", "none_found"}
        if not main or not checked:
            return False
        try:
            for material in paper["materials"]:
                required = material.get("role") == "supplement" or (paper.get("main_pdf_status") == "downloaded" and material.get("role") == "main_pdf")
                required = required or (paper.get("main_pdf_status") == "missing" and material.get("role") == "main_html")
                if required and (material.get("download_status") != "downloaded" or _material_file(self.job_dir, material) is None):
                    return False
        except MaterialsError:
            return False
        return True

    def flush(self):
        if _reparse(self.job_dir) or _reparse(self.job_dir.parent) or _reparse(self.path.parent) or _reparse(self.path):
            raise MaterialsError("材料清单目录无法安全核验，未覆盖原清单。")
        self.document["generated_at"] = _now()
        _atomic_bytes(self.path, (json.dumps(self.document, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        return self.path


def extraction_materials(job_dir, paper_id, *, max_chars=DEFAULT_MAX_CHARS, main_path=""):
    """Read a manifest into bounded, position-aware inputs without editing it."""
    document = _read_json(job_dir, "fulltext/materials.json")
    if not isinstance(document, dict) or document.get("version") != VERSION:
        if (Path(job_dir) / "fulltext/materials.json").exists():
            raise MaterialsError("已有材料清单无法核验，不能忽略补充材料继续提取。")
        return {"manifest_present": False, "supplement_check": {"status": "uninspected", "reason": "旧任务没有材料清单，补充材料尚未核查。"}, "materials": []}
    papers = [paper for paper in document.get("papers", []) if isinstance(paper, dict) and paper.get("paper_id") == paper_id]
    if len(papers) != 1:
        return {"manifest_present": True, "supplement_check": {"status": "unknown", "reason": "此文献未能唯一关联材料清单。"}, "materials": []}
    paper = papers[0]
    materials = [material for material in paper.get("materials", []) if isinstance(material, dict)]
    attachments = [material for material in materials if material.get("role") == "supplement"]
    share = max(1, min(DEFAULT_MAX_CHARS, int(max_chars) // max(1, len(attachments))))
    output = []
    for material in materials:
        entry = copy.deepcopy(material)
        if material.get("role") in {"main_pdf", "main_html"} and material.get("path") == main_path:
            entry["content_ref"] = "fulltext"
            # Keep a small, explicitly bounded positional excerpt. Its offsets
            # belong to this excerpt, not to a differently normalized legacy
            # fulltext.text string.
            read = read_material(job_dir, material, max_chars=min(int(max_chars), 12000))
            entry.update(read_status=read["read_status"], read_reason=read["read_reason"],
                         content={"text": read["text"], "locations": read["locations"], "scope": "positioned_excerpt"})
        else:
            read = read_material(job_dir, material, max_chars=share if material.get("role") == "supplement" else min(int(max_chars), DEFAULT_MAX_CHARS))
            entry.update(read_status=read["read_status"], read_reason=read["read_reason"],
                         content={"text": read["text"], "locations": read["locations"]})
        output.append(entry)
    return {"manifest_present": True, "main_pdf_status": paper.get("main_pdf_status") or "pending",
            "supplement_check": copy.deepcopy(paper.get("supplement_check") or {"status": "uninspected", "reason": "尚未核查。"}),
            "materials": output}


def materials_fingerprint(job_dir, paper_id):
    """Input identity excludes reader timestamps and display-only read states."""
    document = _read_json(job_dir, "fulltext/materials.json")
    if document is None and not (Path(job_dir) / "fulltext/materials.json").exists():
        return None
    if not isinstance(document, dict) or document.get("version") != VERSION or not isinstance(document.get("papers"), list):
        raise MaterialsError("材料清单无效，不能复用旧提取输入。")
    papers = [paper for paper in document["papers"] if isinstance(paper, dict) and paper.get("paper_id") == paper_id]
    scope = {"reader": "materials-reader-v1", "paper_id": paper_id, "papers": []}
    for paper in papers:
        scope["papers"].append({"main_pdf_status": paper.get("main_pdf_status"), "supplement_check": paper.get("supplement_check"),
            "materials": [{key: material.get(key) for key in ("material_id", "role", "label", "filename", "path", "format", "mime_type", "size", "sha256", "download_status")}
                          for material in paper.get("materials", []) if isinstance(material, dict)]})
    return _sha(json.dumps(scope, ensure_ascii=False, sort_keys=True).encode("utf-8"))
