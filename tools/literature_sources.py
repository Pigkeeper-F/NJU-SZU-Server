"""来源注册表的 Python 薄加载器（设计 §7）。

单一真相 = ``tools/literature-sources.json``（JS 与 Python 共用读取）。
``state`` 取值：``executable``（允许进入执行链）| ``registered``（已登记、明确拒绝）。

    from literature_sources import executable_keys, is_known, unconnected_message
"""
from __future__ import annotations

import json
from pathlib import Path

REGISTRY_PATH = Path(__file__).resolve().parent / "literature-sources.json"

#: 拒绝文案（与 literature-config.js 原 L32–35 逐字一致，设计 §7/§10 不回归）
REJECT_TEMPLATE = "尚未接通以下检索来源：{sources}；请选择已接通来源，或等待相应连接器。"


def load_registry() -> dict:
    """读取注册表；结构非法时抛出 ValueError。"""
    try:
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(f"来源注册表不可读：{REGISTRY_PATH}（{error}）") from error
    if not isinstance(data, dict) or not isinstance(data.get("sources"), list):
        raise ValueError(f"来源注册表格式不正确：{REGISTRY_PATH}")
    return data


def list_sources() -> list[dict]:
    """注册表内的全部来源条目（按文件顺序）。"""
    return [dict(item) for item in load_registry()["sources"] if isinstance(item, dict)]


def all_keys() -> list[str]:
    """全部来源 key（六源冻结集合，顺序同注册表）。"""
    return [str(item.get("key") or "") for item in list_sources() if item.get("key")]


def executable_keys() -> list[str]:
    """state=executable 的来源 key；以共享注册表为准。"""
    return [str(item["key"]) for item in list_sources() if item.get("state") == "executable" and item.get("key")]


def executable_sources() -> list[dict]:
    """state=executable 的完整条目（含 adapter）。"""
    return [item for item in list_sources() if item.get("state") == "executable" and item.get("key")]


def is_known(key: object) -> bool:
    """key 是否在注册表内（无论是否 executable）。"""
    return isinstance(key, str) and key in set(all_keys())


def is_executable(key: object) -> bool:
    """key 是否已接通（可进入执行链）。"""
    return isinstance(key, str) and key in set(executable_keys())


def get_source(key: object) -> dict | None:
    """按 key 取条目；不存在返回 None。"""
    if not isinstance(key, str):
        return None
    for item in list_sources():
        if item.get("key") == key:
            return item
    return None


def label_of(key: object) -> str:
    """来源显示名；未知 key 返回空串。"""
    item = get_source(key)
    return str(item.get("label") or "") if item else ""


def unconnected_message(sources: list[str]) -> str:
    """生成与 literatur-config.js 原实现逐字一致的拒绝文案。"""
    return REJECT_TEMPLATE.format(sources="、".join(str(item) for item in sources))
