"""Short localhost-only control-channel fault probe; no phone or Bonjour required.

Run: python scripts/probe-airplay-control.py --cycles 200
The probe refuses occupied receiver ports and only stops the process it starts.
"""
import argparse
import collections
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import threading
import time


def resources(pid):
    class Memory(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("peakWorkingSet", "workingSet", "peakPaged",
            "paged", "peakNonpaged", "nonpaged", "pagefile", "peakPagefile", "privateBytes")]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessHandleCount.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Memory), wintypes.DWORD]
    handle = kernel.OpenProcess(0x410, False, pid)
    if not handle:
        return None
    try:
        memory = Memory(cb=ctypes.sizeof(Memory))
        handles = wintypes.DWORD()
        memory_ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(memory), memory.cb)
        handles_ok = kernel.GetProcessHandleCount(handle, ctypes.byref(handles))
        return {"privateBytes": memory.privateBytes if memory_ok else None,
            "handles": handles.value if handles_ok else None}
    finally:
        kernel.CloseHandle(handle)


def exchange(port=5001):
    with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
        client.sendall(b"OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\n")
        reply = client.recv(4096)
        if not reply.startswith(b"RTSP/1.0 200"):
            raise RuntimeError(f"unexpected control response: {reply[:80]!r}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cycles", type=int, default=200)
    parser.add_argument("--runtime", type=Path, default=Path(__file__).resolve().parents[1] / "receivers/AirPlayServer")
    args = parser.parse_args()
    if not 1 <= args.cycles <= 10000:
        parser.error("cycles must be between 1 and 10000")
    for port in (5001, 7001):
        with socket.socket() as check:
            check.bind(("127.0.0.1", port))
    runtime = args.runtime.resolve()
    events = queue.Queue()
    logs = collections.deque(maxlen=50)
    log_counts = collections.Counter()
    env = dict(os.environ, MIRRORSIM_EXTERNAL_DNSSD="1", MIRRORSIM_HARDWARE_ADDRESS="0210ABCDEF08")
    process = subprocess.Popen([str(runtime / "MirrorSimAdapter.exe")], cwd=runtime,
        env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW)

    def drain(stream, emit):
        for line in stream:
            emit(line.rstrip())

    def log(line):
        logs.append(line)
        for marker in ("Error in parsing", "Error in sending", "Connection closed", "Accepted"):
            if marker in line:
                log_counts[marker] += 1

    threading.Thread(target=drain, args=(process.stdout, events.put), daemon=True).start()
    threading.Thread(target=drain, args=(process.stderr, log), daemon=True).start()

    def command(name):
        process.stdin.write(json.dumps({"name": name, "session_id": "local-probe",
            "expected_stream_id": "local-probe-stream", "receiver_name": "Local probe",
            "trusted_device_ids": [], "blocked_device_ids": []}) + "\n")
        process.stdin.flush()

    results = []
    started = time.monotonic()
    try:
        ready = json.loads(events.get(timeout=5))
        if ready.get("name") != "receiver_ready":
            raise RuntimeError(f"receiver did not become ready: {ready}")
        command("start_session")
        deadline = time.monotonic() + 8
        while True:
            try:
                exchange()
                break
            except OSError:
                if time.monotonic() >= deadline or process.poll() is not None:
                    raise
                time.sleep(0.05)

        for mode in ("clean-close", "reset", "partial-request-reset"):
            phase_start = time.monotonic()
            before = resources(process.pid)
            completed = 0
            try:
                for _ in range(args.cycles):
                    if mode == "clean-close":
                        exchange()
                    else:
                        client = socket.create_connection(("127.0.0.1", 5001), timeout=2)
                        try:
                            if mode == "partial-request-reset":
                                client.sendall(b"OPTIONS * RTSP/1.0\r\nCSeq:")
                            # Give the listener a chance to accept before injecting RST.
                            time.sleep(0.002)
                            client.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("HH", 1, 0))
                        finally:
                            client.close()
                        exchange()
                    completed += 1
                result = {"scenario": mode, "completed": completed, "passed": True}
            except Exception as error:
                result = {"scenario": mode, "completed": completed, "passed": False,
                    "error": str(error), "processExitCode": process.poll()}
            result["elapsedSeconds"] = round(time.monotonic() - phase_start, 3)
            result["resourcesBefore"] = before
            result["resourcesAfter"] = resources(process.pid)
            results.append(result)
            print(json.dumps(result), flush=True)
            if not result["passed"]:
                break
        if all(result["passed"] for result in results):
            before = resources(process.pid)
            phase_start = time.monotonic()
            completed = 0
            try:
                for _ in range(min(args.cycles, 20)):
                    command("stop_session")
                    deadline = time.monotonic() + 5
                    while True:
                        event = json.loads(events.get(timeout=max(0.01, deadline - time.monotonic())))
                        if event.get("name") == "stream_discontinuity" and event.get("reason") == "session_stopped":
                            break
                        if time.monotonic() >= deadline:
                            raise TimeoutError("receiver did not acknowledge stop")
                    command("start_session")
                    deadline = time.monotonic() + 5
                    while True:
                        try:
                            exchange()
                            break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(0.02)
                    completed += 1
                result = {"scenario": "receiver-stop-start", "completed": completed, "passed": True}
            except Exception as error:
                result = {"scenario": "receiver-stop-start", "completed": completed, "passed": False, "error": str(error)}
            result.update(elapsedSeconds=round(time.monotonic() - phase_start, 3),
                resourcesBefore=before, resourcesAfter=resources(process.pid))
            results.append(result)
            print(json.dumps(result), flush=True)
    finally:
        shutdown_ok = False
        if process.poll() is None:
            try:
                command("shutdown")
                process.wait(timeout=5)
                shutdown_ok = process.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
                process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
        print(json.dumps({"shutdownClean": shutdown_ok, "elapsedSeconds": round(time.monotonic() - started, 3),
            "logCounts": dict(log_counts),
            "recentLogs": list(logs) if not shutdown_ok or any(not r["passed"] for r in results) else []}), flush=True)
    return 0 if shutdown_ok and results and all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
