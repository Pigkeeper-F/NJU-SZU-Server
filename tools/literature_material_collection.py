"""Sequential material collection for one paper, invoked only by an explicit run.

The browser discovers links in a verified article page. This coordinator keeps
original files, checkpoints every material, and acknowledges browser cleanup
only after the file and its material record have been saved.
"""
from __future__ import annotations

from literature_materials import MaterialsError


class MaterialCollection:
    def __init__(self, store, record, fetcher, ensure_ready, progress=None):
        self.store, self.record, self.fetcher = store, record, fetcher
        self.ensure_ready, self.progress = ensure_ready, progress or (lambda message: None)
        self.observed = False
        self.checked = False
        self.inspected = False

    def _attention(self, descriptor, reason, message):
        if descriptor is not None:
            self.store.mark_problem(self.record, descriptor, "needs_attention", message)
        else:
            self.store.record_discovery(self.record, {"status": "needs_attention", "reason": message, "links": []})
        self.store.flush()
        return {"status": "attention", "reason": reason or "material_download",
                "message": message, "paper_id": self.record["paper_id"]}

    def _ack_saved_material(self):
        """Recover a crash between durable storage and browser cleanup."""
        pending = getattr(self.fetcher, "pending_material_state", None)
        if not callable(pending):
            return None
        state = pending(self.record)
        if not isinstance(state, dict) or state.get("status") != "file_received":
            return None
        matches = [material for material in self.store.paper(self.record).get("materials", [])
                   if material.get("material_id") == state.get("material_id")
                   and material.get("download_status") == "downloaded"]
        if not matches:
            return None  # The browser must deliver its retained original first.
        material = matches[0]
        if len(matches) != 1 or material.get("sha256") != state.get("sha256") or material.get("size") != state.get("size"):
            raise MaterialsError("已收到的材料与已保存原件不一致，请核查后继续；未重复下载。")
        verified = self.store.find_reusable(self.record, material)
        if verified is None or verified.get("sha256") != state.get("sha256") or verified.get("size") != state.get("size"):
            raise MaterialsError("已登记的材料原件缺失或无法核验；已保留浏览器暂存原件，未重复下载或清理。")
        self.store.flush()
        complete = getattr(self.fetcher, "complete_material", None)
        result = complete() if callable(complete) else {"closed": False}
        if isinstance(result, dict) and result.get("closed") is False:
            return self._attention(None, "material_cleanup", "材料已保存，原任务下载窗口仍待清理；未重复下载。")
        return None

    def observe(self, discovery):
        """Browser callback: return an attention result or None; never auto-retry."""
        if not isinstance(discovery, dict):
            discovery = {"status": "unknown", "reason": "尚未取得可核验的补充材料清单。", "links": []}
        self.observed = True
        self.checked = self.checked or discovery.get("status") in {"checked", "none_declared"}
        try:
            self.store.record_discovery(self.record, discovery)
            self.store.flush()
            recovery = self._ack_saved_material()
            if recovery:
                return recovery
            if discovery.get("status") == "needs_attention":
                return self._attention(None, "material_discovery", str(discovery.get("reason") or "补充材料需要人工核查。"))
            for descriptor in self.store.pending_supplements(self.record):
                try:
                    reused = self.store.find_reusable(self.record, descriptor)
                    if reused is not None:
                        self.progress("已复用本地补充材料：" + str(reused.get("filename") or descriptor.get("label") or "附件"))
                        self.store.flush()
                        continue
                    if not callable(getattr(self.fetcher, "fetch_material", None)):
                        self.store.mark_problem(self.record, descriptor, "missing", "当前下载器未提供该补充材料的获取方式，原入口保留待核查。")
                        self.store.flush()
                        continue
                    ready = self.ensure_ready()
                    if isinstance(ready, dict) and ready.get("status") != "ok":
                        return self._attention(descriptor, "material_browser", str(ready.get("message") or "材料下载浏览器尚未就绪。"))
                    self.progress("获取补充材料：" + str(descriptor.get("label") or descriptor.get("filename") or "附件"))
                    result = self.fetcher.fetch_material(descriptor, self.record, {"record": self.record})
                    if result.get("status") in {"attention", "captcha"}:
                        return self._attention(descriptor, result.get("reason") or "verification", str(result.get("message") or "补充材料下载需要人工处理；请保留原页面。"))
                    if result.get("status") != "file":
                        self.store.mark_problem(self.record, descriptor, "missing", str(result.get("error") or result.get("message") or "尚未取得补充材料文件。"))
                        self.store.flush()
                        continue
                    self.store.save_download(self.record, descriptor, result)
                    self.store.flush()
                    complete = getattr(self.fetcher, "complete_material", None)
                    if callable(complete):
                        closed = complete()  # The original file and manifest are durable.
                        if isinstance(closed, dict) and closed.get("closed") is False:
                            return self._attention(None, "material_cleanup", "材料已保存，但本任务下载页尚未完成清理；已暂停，避免继续打开更多页面。")
                except MaterialsError as error:
                    return self._attention(descriptor, "local_material_verification", str(error))
                except Exception:
                    return self._attention(None, "material_download", "补充材料处理发生异常；已有文件保留，请在原任务页核查后继续。")
            self.store.read_materials(self.record)
            self.store.flush()
            return None
        except MaterialsError as error:
            return self._attention(None, "local_material_verification", str(error))

    def inspect_existing(self, opts):
        """Inspect an already saved paper's article page without re-downloading it."""
        self.inspected = True
        inspect = getattr(self.fetcher, "inspect_materials", None)
        if not callable(inspect):
            return self.observe({"status": "unknown", "reason": "已有正文已保留；补充材料尚未在原文章页核查。", "links": []})
        ready = self.ensure_ready()
        if isinstance(ready, dict) and ready.get("status") != "ok":
            return self._attention(None, "material_browser", str(ready.get("message") or "材料检查浏览器尚未就绪。"))
        try:
            recovery = self._ack_saved_material()
            if recovery:
                return recovery
        except MaterialsError as error:
            return self._attention(None, "local_material_verification", str(error))
        result = inspect(self.record, {**opts, "record": self.record, "on_material_discovery": self.observe})
        if result.get("status") in {"attention", "captcha"}:
            return self._attention(None, result.get("reason") or "verification", str(result.get("message") or "材料检查需要人工处理。"))
        discovery = result.get("material_discovery")
        if isinstance(discovery, dict):
            return self.observe(discovery)
        if not self.observed:
            return self.observe({"status": "unknown", "reason": str(result.get("error") or "未能在同篇文章页核查补充材料。"), "links": []})
        return None
