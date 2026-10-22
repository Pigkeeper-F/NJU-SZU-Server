"""Fixed source-worker guardian: driver death ends only its own worker."""
from __future__ import annotations

import os
import signal
import sys
import time


def _ready():
    print("ready", flush=True)
    sys.stdout.close()


def _watch_windows(parent_pid, worker_pid):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.WaitForMultipleObjects.argtypes = (wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD)
    kernel.WaitForMultipleObjects.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
    kernel.TerminateProcess.restype = wintypes.BOOL
    # A held handle identifies this exact process even if a PID is later reused.
    worker = kernel.OpenProcess(0x00100000 | 0x0001, False, worker_pid)
    if not worker:
        return 1
    parent = kernel.OpenProcess(0x00100000, False, parent_pid)
    try:
        if not parent:
            kernel.TerminateProcess(worker, 1)
            return 1
        _ready()
        handles = (wintypes.HANDLE * 2)(worker, parent)
        result = kernel.WaitForMultipleObjects(2, handles, False, 60_000)
        if result != 0:  # driver exited, own deadline, or monitoring failed
            kernel.TerminateProcess(worker, 124 if result == 0x00000102 else 130 if result == 1 else 125)
        return 0
    finally:
        if parent:
            kernel.CloseHandle(parent)
        kernel.CloseHandle(worker)


def _watch_posix(parent_pid, worker_pid):
    def parent_alive():
        try:
            os.kill(parent_pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    _ready()
    deadline = time.monotonic() + 60
    while os.getppid() == worker_pid:
        if not parent_alive() or time.monotonic() >= deadline:
            try:
                os.kill(worker_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            return 0
        time.sleep(0.1)
    return 0


def main():
    try:
        parent_pid, worker_pid = map(int, sys.argv[1:])
        # This guardian can monitor/terminate only its actual source-worker
        # parent, never a browser PID or an arbitrary requested process.
        if parent_pid <= 0 or worker_pid <= 0 or os.getppid() != worker_pid:
            return 1
        return _watch_windows(parent_pid, worker_pid) if os.name == "nt" else _watch_posix(parent_pid, worker_pid)
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
