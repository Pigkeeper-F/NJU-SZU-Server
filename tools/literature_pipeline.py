"""通用总控：按序编排六阶段文献流水线（设计 §1.3/§2.1/§4.4/§9.2）。

用法::

    python -u tools/literature_pipeline.py --config C --output-dir D
           [--from discover] [--until export] [--resume] [--no-event-log]
           [--force] [--python <解释器>]

行为：
- 顺序调用同一批阶段脚本（subprocess，``python -u <script> --config <job>/run_config.json
  --output-dir <job> [--resume] …``），stdout NDJSON 事件逐行透传，并按需追加
  ``<job>/events.jsonl``（默认写，``--no-event-log`` 关闭；唯一写入者 = 任务驱动方，§4.2）；
- ``--resume``：按产物判定表（§4.4，``detect_completed_stages``）跳过已完成阶段，
  并向被执行的阶段脚本透传 ``--resume``；
- extract 阶段 CLI 模式（§9.2）：先 ``--prepare``；存在未完成 bundle →
  ``attention(stage="extraction")`` 暂停，exit 0（提取由网页端 CodexBridge 适配器完成）；
- 一次阶段进程必须且只能以 result/attention/error 之一收尾；干净退出但无收尾事件 →
  失败（discover『检索脚本未返回结果』，其余『阶段脚本未返回结果』，设计 §2.2）；
- 退出码：0 = 全部完成或停在人工关口；1 = 失败；2 = 用法错误（argparse）。
- collection gate 仅预留适配接口（``GATE_ADAPTER``/``check_completion_gate``），
  本阶段不实现达标阈值语义（设计 §5.3、主代理裁决 D9）。
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import NamedTuple

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
_common = importlib.import_module("literature-common")  # 文件名含连字符，见 literature-common.py 头部说明

emit = _common.emit
STAGES = list(_common.STAGES)

#: 阶段 → 脚本文件名（相对 tools/；全部按 §2.4 冻结的 CLI 契约调用）
SCRIPTS = {
    "discover": "literature_search.py",
    "dedupe": "literature_dedupe.py",
    "fulltext": "literature_fulltext.py",
    "extract": "literature_extract.py",
    "validate": "literature_validate.py",
    "export": "literature_export.py",
}

#: 收尾事件类型（设计 §2.2）
TERMINAL_TYPES = ("result", "attention", "error")


class StageOutcome(NamedTuple):
    """单阶段执行结果：``code`` 0 = 完成或 attention 暂停，1 = 失败。"""

    code: int
    terminal: str | None


def emit_event(event: dict, *, job_dir: Path | None = None, log_events: bool = True) -> None:
    """写一行事件到本进程 stdout（NDJSON 透传），并按需追加 events.jsonl。"""
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    if job_dir is not None and log_events:
        _common.append_event_log(job_dir, event)


def child_env() -> dict:
    """子进程环境：注入 PYTHONUTF8/PYTHONIOENCODING（设计 §8.2 双防线之一）。"""
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _spawn_stage(
    stage: str,
    script_name: str,
    args: list[str],
    *,
    job_dir: Path,
    python: str | None,
    log_events: bool,
    timeout: int | None,
    tools_dir: Path,
) -> StageOutcome:
    """spawn 单个阶段脚本；解析 stdout NDJSON（透传 + 写日志），返回收尾结果。"""
    script = Path(tools_dir) / script_name
    if not script.is_file():
        emit_event(
            {"type": "error", "stage": stage, "message": f"阶段脚本不存在：tools/{script_name}（该阶段尚未交付）"},
            job_dir=job_dir,
            log_events=log_events,
        )
        return StageOutcome(1, "error")
    command = [str(python or sys.executable), "-u", str(script), *args]
    try:
        process = subprocess.Popen(
            command,
            cwd=str(ROOT),
            env=child_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as error:
        emit_event(
            {"type": "error", "stage": stage, "message": f"阶段脚本启动失败：{error}"},
            job_dir=job_dir,
            log_events=log_events,
        )
        return StageOutcome(1, "error")

    lines: "queue.Queue[str | None]" = queue.Queue()
    stderr_tail: list[str] = []

    def pump_stdout() -> None:
        try:
            for line in process.stdout:  # type: ignore[union-attr]
                lines.put(line)
        finally:
            lines.put(None)

    def pump_stderr() -> None:
        for line in process.stderr:  # type: ignore[union-attr]
            stderr_tail.append(line)
            if len(stderr_tail) > 400:
                del stderr_tail[:200]

    out_thread = threading.Thread(target=pump_stdout, daemon=True)
    err_thread = threading.Thread(target=pump_stderr, daemon=True)
    out_thread.start()
    err_thread.start()

    deadline = time.monotonic() + timeout if timeout else None
    terminal: tuple[str, dict] | None = None
    invalid_lines = 0
    timed_out = False
    while True:
        try:
            line = lines.get(timeout=0.25)
        except queue.Empty:
            if deadline is not None and time.monotonic() > deadline:
                timed_out = True
                try:
                    process.kill()
                except OSError:
                    pass
                try:  # 排空残留输出，避免管道阻塞读取线程
                    while True:
                        if lines.get(timeout=0.5) is None:
                            break
                except queue.Empty:
                    pass
                break
            continue
        if line is None:
            break
        text = line.strip()
        if not text:
            continue
        try:
            event = json.loads(text)
        except ValueError:
            event = None
        if not isinstance(event, dict) or not event.get("type"):
            invalid_lines += 1
            if invalid_lines <= 5:
                sys.stderr.write(f"[pipeline] 忽略非 NDJSON 输出行：{text[:200]}\n")
            continue
        emit_event(event, job_dir=job_dir, log_events=log_events)
        kind = str(event.get("type"))
        if kind in TERMINAL_TYPES:
            terminal = (kind, event)

    try:
        code = process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        code = process.wait()
    out_thread.join(timeout=5)
    err_thread.join(timeout=5)
    stderr_text = "".join(stderr_tail).strip()

    if timed_out:
        emit_event(
            {"type": "error", "stage": stage, "message": f"阶段执行超过 {timeout} 秒，已停止；已完成的产物保留。"},
            job_dir=job_dir,
            log_events=log_events,
        )
        return StageOutcome(1, "error")
    if terminal is not None and terminal[0] == "error":
        return StageOutcome(1, "error")
    if code == 0:
        if terminal is not None:
            return StageOutcome(0, terminal[0])
        message = "检索脚本未返回结果" if stage == "discover" else "阶段脚本未返回结果"
        if invalid_lines:
            message = f"{message}（另有 {invalid_lines} 行非 NDJSON 输出）"
        emit_event({"type": "error", "stage": stage, "message": message}, job_dir=job_dir, log_events=log_events)
        return StageOutcome(1, "error")
    detail = stderr_text[-2000:] if stderr_text else f"阶段脚本退出码 {code}"
    emit_event({"type": "error", "stage": stage, "message": detail}, job_dir=job_dir, log_events=log_events)
    return StageOutcome(1, "error")


def execute_stage(
    stage: str,
    job_dir: Path,
    *,
    resume: bool = False,
    extra: list[str] | None = None,
    python: str | None = None,
    log_events: bool = True,
    timeouts: dict | None = None,
    force: bool = False,
    scripts: dict | None = None,
    tools_dir: Path | None = None,
) -> StageOutcome:
    """执行单个阶段并返回 StageOutcome（可区分「完成」与「attention 暂停」）。

    ``scripts``/``tools_dir``/``python`` 为可测试/可替换入口（默认按 §2.4 的 tools/ 脚本表）；
    ``force`` 仅对 extract 生效（``--prepare`` 重建输入包）。
    """
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    paths = _common.job_paths(job_dir)
    tools = Path(tools_dir) if tools_dir is not None else TOOLS_DIR
    table = dict(SCRIPTS)
    if scripts:
        table.update({key: str(value) for key, value in scripts.items()})
    if stage not in STAGES or stage not in table:
        emit_event({"type": "error", "stage": stage, "message": f"未知阶段：{stage}"}, job_dir=job_dir, log_events=log_events)
        return StageOutcome(1, "error")
    if timeouts is None:
        timeouts = _common.resolve_limits(_common.load_json(paths["run_config"], default=None))
    base = ["--config", str(paths["run_config"]), "--output-dir", str(job_dir)]

    def spawn(script_name: str, args: list[str]) -> StageOutcome:
        return _spawn_stage(
            stage,
            script_name,
            args,
            job_dir=job_dir,
            python=python,
            log_events=log_events,
            timeout=timeouts.get(stage),
            tools_dir=tools,
        )

    if stage == "extract":
        args = list(base)
        if force:
            args.append("--force")
        outcome = spawn(table["extract"], args + ["--prepare"])
        if outcome.code != 0:
            return outcome
        coverage = _common.extraction_coverage(job_dir)
        if coverage["bundles"] == 0:
            emit_event(
                {"type": "error", "stage": "extract", "message": "未找到可提取的文献：请先完成 fulltext 阶段并确认 fulltext/status.json 有已获取全文项。"},
                job_dir=job_dir,
                log_events=log_events,
            )
            return StageOutcome(1, "error")
        if coverage["pending"]:
            emit_event(
                {
                    "type": "attention",
                    "stage": "extraction",
                    "message": f"提取输入包已生成（{coverage['bundles']} 篇）。请在网页端完成提取，或在 extraction/ 放置结果后重跑 --check。",
                    "counts": {"bundles": coverage["bundles"], "results": coverage["results"], "pending": len(coverage["pending"])},
                },
                job_dir=job_dir,
                log_events=log_events,
            )
            return StageOutcome(0, "attention")
        return spawn(table["extract"], list(base) + ["--check"])

    args = list(base) + list(extra or [])
    if resume:
        args.append("--resume")
    return spawn(table[stage], args)


def run_stage(stage: str, job_dir: Path, *, resume: bool, extra: list[str] | None = None) -> int:
    """执行单个阶段，返回 0（完成或停在人工关口）/ 1（失败）。

    需要区分「完成」与「attention 暂停」时，用 :func:`execute_stage` 取 ``StageOutcome``。
    """
    return execute_stage(stage, job_dir, resume=resume, extra=extra).code


# ---------------------------------------------------------------------------
# collection gate 适配接口（预留，本阶段不实现阈值语义；设计 §5.3 / 裁决 D9）
# 未来接入 = 赋值 GATE_ADAPTER（如包装 SOC collection_endpoint 读取逻辑）：
#     GATE_ADAPTER(job_dir: Path, config: dict) -> {"met": bool, "reason": str} | None
# 返回 None 或 {"met": True} 表示不阻断；{"met": False, "reason": …} 时 main 在
# 全部阶段完成后以 attention(stage="export") 暂停（exit 0），等待研究者确认。
# ---------------------------------------------------------------------------
GATE_ADAPTER = None


def check_completion_gate(job_dir: Path, config: dict) -> dict | None:
    """调用预留的 gate 适配器；未接入（默认）返回 None。"""
    if GATE_ADAPTER is None:
        return None
    result = GATE_ADAPTER(Path(job_dir), config)
    if result is None:
        return None
    if not isinstance(result, dict):
        return {"met": True, "reason": ""}
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="文献挖掘六阶段总控（设计 §1.3/§2.1）")
    parser.add_argument("--config", type=Path, required=True, help="冻结的 run_config.json 路径")
    parser.add_argument("--output-dir", type=Path, required=True, help="任务目录（.workbench/literature/<jobid>/）")
    parser.add_argument("--from", dest="start", choices=STAGES, default="discover", help="起始阶段（默认 discover）")
    parser.add_argument("--until", dest="until", choices=STAGES, default="export", help="结束阶段（默认 export）")
    parser.add_argument("--resume", action="store_true", help="断点续跑：跳过已完成阶段并向阶段脚本透传 --resume")
    parser.add_argument("--no-event-log", action="store_true", help="不写 events.jsonl（默认写）")
    parser.add_argument("--force", action="store_true", help="extract --prepare 强制重建输入包（schema 变更后使用）")
    parser.add_argument("--python", default=None, help="阶段脚本使用的解释器（默认当前解释器）")
    args = parser.parse_args(argv)
    if STAGES.index(args.start) > STAGES.index(args.until):
        parser.error("--from 不能晚于 --until")

    job_dir = Path(args.output_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    config = _common.load_json(args.config, default=None)
    if not isinstance(config, dict):
        config = {}
    log_events = not args.no_event_log
    timeouts = _common.resolve_limits(config)

    stages = STAGES[STAGES.index(args.start): STAGES.index(args.until) + 1]
    if args.resume:
        completed = _common.detect_completed_stages(job_dir)
        stages = [stage for stage in stages if completed.get(stage) != "done"]
    if not stages:
        emit_event(
            {"type": "result", "stage": "completed", "message": "全部阶段已完成，无需续跑。", "counts": _common.stage_counts(job_dir)},
            job_dir=job_dir,
            log_events=log_events,
        )
        return 0

    for stage in stages:
        outcome = execute_stage(
            stage,
            job_dir,
            resume=args.resume,
            python=args.python,
            log_events=log_events,
            timeouts=timeouts,
            force=bool(args.force and stage == "extract"),
        )
        if outcome.code != 0:
            return 1
        if outcome.terminal == "attention":
            return 0

    gate = check_completion_gate(job_dir, config)
    if isinstance(gate, dict) and not gate.get("met", True):
        emit_event(
            {
                "type": "attention",
                "stage": "export",
                "message": str(gate.get("reason") or "尚未达到采集目标数量，请研究者确认。"),
                "counts": _common.stage_counts(job_dir),
            },
            job_dir=job_dir,
            log_events=log_events,
        )
        return 0
    emit_event(
        {"type": "result", "stage": "completed", "message": f"流水线完成（{stages[0]} → {stages[-1]}）", "counts": _common.stage_counts(job_dir)},
        job_dir=job_dir,
        log_events=log_events,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
