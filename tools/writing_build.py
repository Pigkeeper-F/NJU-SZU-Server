#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""文章撰写环节的稿件生成器（九步研究流程 · 环节⑥）。

在执行内核（/api/code/exec）里运行，工作目录就是本次执行目录：

  params.json           模块参数（{"journal": "目标期刊"} 等），由服务端写入
  upstream_manifest.json 上游产物清单（{"items":[{module,file,size,path}]}）
  upstream/<模块名>/…    上游模块的产物原件（图表 / 数据 / 文稿）
  manuscript.md         可选：AI 或人工写好的正文草稿（有就以它为正文来源）

产出（写回执行目录，界面上的"产物文件"列出来即���下载）：

  manuscript.tex        LaTeX 主稿（按目标期刊的结构约束组织）
  references.bib        参考文献（上游有 .bib 就带过来，没有就留占位条目）
  manuscript.md         正文副本（便于通读与评审）
  <图表文件>            从上游收拢的图表，平铺落在执行目录根下（\\includegraphics 直接引用）
  build_report.md       生成报告：收了什么、缺什么、下一步要人做什么

只依赖标准库。缺输入不报错退出——如实写进报告，由人来补。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

RUN_DIR = Path.cwd()
FIG_SUFFIXES = {".png", ".pdf", ".svg", ".jpg", ".jpeg", ".eps"}
DATA_SUFFIXES = {".csv", ".tsv", ".json", ".xlsx", ".xls", ".txt", ".md"}
SECTIONS = [
    ("introduction", "Introduction"),
    ("related", "Related Work"),
    ("methods", "Methods"),
    ("results", "Results"),
    ("discussion", "Discussion"),
    ("conclusion", "Conclusion and Future Work"),
]
FIGURE_CAPTION_FILES = {"caption.md", "captions.md", "figure_notes.md", "figures.md"}


def read_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def load_params() -> dict:
    data = read_json(RUN_DIR / "params.json")
    return data if isinstance(data, dict) else {}


def load_manifest() -> list:
    data = read_json(RUN_DIR / "upstream_manifest.json")
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return items
    if isinstance(data, list):
        return data
    return []


def collect_upstream(manifest: list):
    """按模块分组收拢上游产物：图 / 数据 / 文本 / bib。"""
    grouped: dict = {}
    for item in manifest:
        if not isinstance(item, dict):
            continue
        rel = item.get("path")
        if not isinstance(rel, str) or not rel:
            rel = "upstream/{}/{}".format(item.get("module", ""), item.get("file", ""))
        src = RUN_DIR / rel
        if not src.is_file():
            continue
        module = str(item.get("module") or "上游")
        grouped.setdefault(module, {"figures": [], "data": [], "texts": [], "bibs": []})
        suffix = src.suffix.lower()
        if suffix in FIG_SUFFIXES:
            grouped[module]["figures"].append(src)
        elif suffix == ".bib":
            grouped[module]["bibs"].append(src)
        elif suffix in DATA_SUFFIXES:
            grouped[module]["data"].append(src)
        else:
            grouped[module]["texts"].append(src)
    return grouped


def find_draft():
    """正文草稿：优先 manuscript.md，其次上游文本产物里名字像正文的。"""
    local = RUN_DIR / "manuscript.md"
    if local.is_file():
        return local, "本模块写作"
    for item in sorted(RUN_DIR.glob("upstream/*/*")):
        if not item.is_file():
            continue
        if item.suffix.lower() not in {".md", ".txt"}:
            continue
        name = item.name.lower()
        if any(key in name for key in ("manuscript", "paper", "draft", "正文", "稿")):
            return item, "上游：" + item.parent.name
    return None, ""


def latex_escape(text: str) -> str:
    if not text:
        return ""
    out = text.replace("\\", r"\textbackslash{}")
    for src, dst in (("&", r"\&"), ("%", r"\%"), ("$", r"\$"), ("#", r"\#"),
                     ("_", r"\_"), ("{", r"\{"), ("}", r"\}"), ("~", r"\textasciitilde{}"),
                     ("^", r"\textasciicircum{}")):
        out = out.replace(src, dst)
    return out


def split_sections(markdown: str):
    """把 markdown 正文按二级标题切成 (标题, 段落) 列表；没有标题就整体一段。

    一级标题（# …）是稿件标题，已由 extract_title 取走，正文里不再重复。
    """
    if not markdown.strip():
        return []
    chunks = []
    current_title = ""
    current_body: list = []
    for line in markdown.splitlines():
        if line.startswith("## "):
            if current_body or current_title:
                chunks.append((current_title, "\n".join(current_body).strip()))
            current_title = line[3:].strip()
            current_body = []
        elif line.startswith("# "):
            continue  # 稿件标题，正文不重复
        else:
            current_body.append(line)
    if current_body or current_title:
        chunks.append((current_title, "\n".join(current_body).strip()))
    return [(t, b) for t, b in chunks if t or b]


def render_body_markdown(md: str) -> str:
    """极简 markdown → LaTeX：段落、列表、粗体、斜体、行内代码、行内数学。

    顺序要点：先把 $...$ 数学段抽出来保护，再做 LaTeX 转义（转义会吃掉 { } \\ ），
    最后才套 markdown 结构——否则 \\textbf{} 里的花括号会被二次转义成 \\{。
    """
    lines = md.splitlines()
    out: list = []
    in_list = False
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            if in_list:
                out.append(r"\end{itemize}")
                in_list = False
            out.append("")
            continue
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append(r"\begin{itemize}")
                in_list = True
            item = re.sub(r"^\s*[-*]\s+", "", line)
            out.append(r"  \item " + render_inline(item))
            continue
        if in_list:
            out.append(r"\end{itemize}")
            in_list = False
        out.append(render_inline(line))
    if in_list:
        out.append(r"\end{itemize}")
    return "\n".join(out)


def render_inline(text: str) -> str:
    """单行 markdown → LaTeX：保护数学段 → 转义 → 套结构命令。"""
    maths: list = []

    def keep(match):
        maths.append(match.group(0))
        return "\x00MATH{}\x00".format(len(maths) - 1)

    text = re.sub(r"\$[^$\n]+\$", keep, text)
    text = latex_escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"\\textbf{\1}", text)
    text = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"\\textit{\1}", text)
    text = re.sub(r"`(.+?)`", r"\\texttt{\1}", text)
    for index, math in enumerate(maths):
        text = text.replace("\x00MATH{}\x00".format(index), math)
    return text


def figure_caption_map(grouped: dict) -> dict:
    """从上游的 caption/figure_notes 文件里抓「文件名 → 图注」对应关系。"""
    mapping: dict = {}
    for module, groups in grouped.items():
        for path in groups["texts"] + groups["data"]:
            if path.name.lower() not in FIGURE_CAPTION_FILES:
                continue
            for line in read_text(path).splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if ":" in line or "：" in line:
                    key = re.split(r"[:：]", line, 1)[0].strip()
                    val = re.split(r"[:：]", line, 1)[1].strip()
                    if key:
                        mapping[key] = val
    return mapping


def extract_title(draft_path) -> str:
    """稿件标题：优先取草稿里的一级标题，其次用文件名（去扩展名）。"""
    if draft_path:
        for line in read_text(draft_path).splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip()
            if stripped:
                break
        return Path(draft_path).stem
    return "Manuscript"


def find_abstract(sections):
    """摘要：优先取草稿里名为 Abstract / 摘要 的小节；没有就返回 None（不拿正文冒充摘要）。"""
    for title_text, body in sections:
        key = title_text.strip().lower()
        if key in ("abstract", "摘要", "summary"):
            return body
    return None


def build_tex(journal: str, draft_path, draft_source: str, grouped: dict,
              captions: dict, figure_files: list) -> str:
    title = extract_title(draft_path)
    body_md = read_text(draft_path) if draft_path else ""
    sections = split_sections(body_md)
    abstract = find_abstract(sections)

    lines: list = []
    lines.append(r"% 由 tools/writing_build.py 生成（九步研究流程 · 环节⑥ 文章撰写）")
    lines.append(r"% 目标期刊：" + latex_escape(journal or "（未填写）"))
    lines.append(r"\documentclass[11pt]{article}")
    lines.append(r"\usepackage[utf8]{inputenc}")
    lines.append(r"\usepackage{graphicx}")
    lines.append(r"\usepackage{booktabs}")
    lines.append(r"\usepackage{amsmath}")
    lines.append(r"\usepackage{hyperref}")
    lines.append(r"\usepackage{geometry}")
    lines.append(r"\geometry{a4paper,margin=2.5cm}")
    lines.append(r"\title{%s}" % latex_escape(title))
    lines.append(r"\author{Author Name \thanks{Institution, Country}}")
    lines.append(r"\date{\today}")
    lines.append(r"\begin{document}")
    lines.append(r"\maketitle")
    lines.append(r"\begin{abstract}")
    if abstract:
        lines.append(render_body_markdown(abstract[:2000]))
    else:
        lines.append("% TODO: 摘要待补——按目标期刊的摘要要求撰写（不要拿正文首段充数）")
    lines.append(r"\end{abstract}")
    lines.append("")

    if sections:
        for title_text, body in sections:
            if title_text.strip().lower() in ("abstract", "摘要", "summary"):
                continue  # 摘要已进 abstract 环境，正文不再重复
            lines.append(r"\section{%s}" % latex_escape(title_text))
            lines.append(render_body_markdown(body))
            lines.append("")
    else:
        for key, title_text in SECTIONS:
            lines.append(r"\section{%s}" % title_text)
            lines.append("% TODO: 本节待补——由上游结果、图表与讨论要点填充。")
            lines.append("")

    if figure_files:
        lines.append(r"\section{Figures}")
        for item in figure_files:
            name = item["name"]
            caption = captions.get(name) or captions.get(Path(name).stem) or "TODO: 图注待补"
            lines.append(r"\begin{figure}[htbp]")
            lines.append(r"  \centering")
            lines.append(r"  \includegraphics[width=0.85\textwidth]{%s}" % latex_escape(name))
            lines.append(r"  \caption{%s}" % latex_escape(caption))
            lines.append(r"  \label{fig:%s}" % re.sub(r"[^A-Za-z0-9]", "-", Path(name).stem))
            lines.append(r"\end{figure}")
            lines.append("")

    lines.append(r"\bibliographystyle{plain}")
    lines.append(r"\bibliography{references}")
    lines.append(r"\end{document}")
    return "\n".join(lines) + "\n"


def main() -> int:
    params = load_params()
    journal = str(params.get("journal") or "").strip()
    manifest = load_manifest()
    grouped = collect_upstream(manifest)
    draft_path, draft_source = find_draft()
    captions = figure_caption_map(grouped)

    # 图表平铺落在执行目录根下（不放 figures/ 子目录）：执行内核的产物清单只收顶层文件，
    # 放子目录的话这些图在界面上就下载不到。\includegraphics 直接引用平铺后的文件名。
    figure_files: list = []
    for module, groups in grouped.items():
        for path in groups["figures"]:
            try:
                target = RUN_DIR / path.name
                if target.exists():
                    stem, suffix = target.stem, target.suffix
                    index = 2
                    while target.exists():
                        target = RUN_DIR / ("{}-{}{}".format(stem, index, suffix))
                        index += 1
                shutil.copy2(path, target)
                figure_files.append({"name": target.name, "module": module})
            except Exception as error:  # 单个文件失败不终止，报告里如实记
                print("warn: 复制图表失败 {}: {}".format(path, error))

    figure_files.sort(key=lambda item: item["name"])
    tex = build_tex(journal, draft_path, draft_source, grouped, captions, figure_files)
    (RUN_DIR / "manuscript.tex").write_text(tex, encoding="utf-8")

    if draft_path and draft_path.resolve() != (RUN_DIR / "manuscript.md").resolve():
        shutil.copyfile(draft_path, RUN_DIR / "manuscript.md")

    bib_parts: list = []
    for groups in grouped.values():
        for path in groups["bibs"]:
            bib_parts.append(read_text(path))
    if not bib_parts:
        bib_parts.append(
            "% TODO: 参考文献待补——把上游文献调研环节的引文整理成 BibTeX 条目。\n"
            "@article{placeholder,\n  title={TODO},\n  author={TODO},\n  journal={TODO},\n  year={TODO}\n}\n"
        )
    (RUN_DIR / "references.bib").write_text("\n".join(bib_parts), encoding="utf-8")

    report: list = []
    report.append("# 文章撰写环节 · 生成报告")
    report.append("")
    report.append("- 目标期刊：{}".format(journal or "**未填写**（稿件按通用结构生成，未按任何期刊约束）"))
    report.append("- 正文草稿：{}".format(str(draft_path) if draft_path else "**未提供**（生成的是结构骨架，待填）"))
    if draft_source:
        report.append("- 草稿来源：{}".format(draft_source))
    report.append("- 上游模块数：{}".format(len(grouped)))
    report.append("- 收录图表：{} 张".format(len(figure_files)))
    report.append("")
    report.append("## 收录的图表")
    if figure_files:
        for item in figure_files:
            report.append("- `{}`（来自 {}）".format(item["name"], item["module"]))
    else:
        report.append("- 无：上游没有图表文件")
    report.append("")
    report.append("## 各上游模块收到的产物")
    if grouped:
        for module, groups in grouped.items():
            kinds = []
            if groups["figures"]:
                kinds.append("图 {} 张".format(len(groups["figures"])))
            if groups["data"]:
                kinds.append("数据 {} 个".format(len(groups["data"])))
            if groups["texts"]:
                kinds.append("文本 {} 个".format(len(groups["texts"])))
            if groups["bibs"]:
                kinds.append("bib {} 个".format(len(groups["bibs"])))
            report.append("- {}：{}".format(module, "、".join(kinds) if kinds else "无可识别产物"))
    else:
        report.append("- 无上游产物")
    report.append("")
    report.append("## 待补清单（人工）")
    todos: list = []
    if not journal:
        todos.append("填写目标期刊后重新生成（章节结构、篇幅、引用与图表规范都要按它约束）")
    if not draft_path:
        todos.append("提供正文草稿（manuscript.md）或让 AI 依据上游产物起草后填入")
    if not figure_files:
        todos.append("上游还没有图表产物：先在「图表绘制」环节出图，再回到本环节")
    if not bib_parts or bib_parts[0].lstrip().startswith("% TODO"):
        todos.append("补参考文献：把文献调研环节的引文整理成 BibTeX")
    todos.append("逐条核对正文数字与图表、结果数据是否一致")
    for item in todos:
        report.append("- [ ] {}".format(item))
    (RUN_DIR / "build_report.md").write_text("\n".join(report) + "\n", encoding="utf-8")

    print("writing_build: 目标期刊={}".format(journal or "(未填写)"))
    print("writing_build: 图表 {} 张，上游模块 {} 个".format(len(figure_files), len(grouped)))
    print("writing_build: 产物 manuscript.tex / references.bib / manuscript.md / build_report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
