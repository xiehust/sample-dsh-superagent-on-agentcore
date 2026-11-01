"""Page pinner: keep the first request's files in the AgentCore Runtime V2 snapshot.

V2 is expected (unverified on a live runtime) to drop the page cache before it snapshots a ready microVM, so the mount
helper, efs-proxy, the agent's tools and their libraries would be cold-read from the lazily loaded snapshot disk on the
first request after a restore (seconds to tens of seconds for `mount -t s3files`). Pages mapped by a live process
survive the drop, so the gateway starts this process before it listens on :8080 (the platform snapshots only after /ping
answers 200): it reads every file of the build-time manifest (pin_manifest.py) into the page cache, maps it
MAP_SHARED|MAP_POPULATE, prints one JSON line and holds the mappings until it is killed or its stdin closes. The gateway
kills it once the first mount has finished.

Best effort throughout: a missing manifest or any pinner failure is a warning and the gateway listens anyway.
Child: `python3.12 -I pinner.py <manifest>`. Parent: `Pinner.start(manifest, log)`. Standard library only.
"""
from __future__ import annotations

import json
import mmap
import os
import select
import stat
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any

MANIFEST = "/app/pin-manifest.txt"
MAX_BYTES = 128 << 20  # pinned pages go into every snapshot: a total cap, a file that would exceed it is skipped whole
DEADLINE_S = 5.0  # a warm disk pins in tens of ms; the deadline only bounds a pathologically slow one
WAIT_S = DEADLINE_S + 2.0  # the parent's bound on the child's start-up plus pinning
CHUNK = 256 << 10
MAP_POPULATE = getattr(mmap, "MAP_POPULATE", 0x8000)  # Linux value; mmap exposes it from Python 3.10


def pin(paths: list[str], deadline: float, max_bytes: int = MAX_BYTES) -> tuple[list[mmap.mmap], int]:
    maps: list[mmap.mmap] = []
    total, buf = 0, bytearray(CHUNK)  # one reused buffer: freed heap would otherwise land in the snapshot too
    for path in paths:
        if time.monotonic() >= deadline:
            break
        try:
            # No symlinks (the manifest holds resolved paths) and no blocking open: a FIFO or device is skipped, never waited on.
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            continue
        try:
            st = os.fstat(fd)
            size = st.st_size
            if not stat.S_ISREG(st.st_mode) or size == 0 or total + size > max_bytes:
                continue
            off = 0
            while off < size:  # read first: a disk error is a plain OSError here, not a SIGBUS in the mapping
                if time.monotonic() >= deadline:
                    return maps, total  # this file stays unpinned: no partial pins
                n = os.preadv(fd, [buf], off)
                if n == 0:
                    break
                off += n
            if off == 0:
                continue
            maps.append(mmap.mmap(fd, off, flags=mmap.MAP_SHARED | MAP_POPULATE, prot=mmap.PROT_READ))
            total += off
        except (OSError, ValueError):
            pass
        finally:
            os.close(fd)
    return maps, total


def read_manifest(path: str) -> list[str]:
    with open(path) as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def main(argv: list[str]) -> None:
    started = time.monotonic()
    maps, total = pin(read_manifest(argv[1] if len(argv) > 1 else MANIFEST), started + DEADLINE_S)
    out = {"files": len(maps), "bytes": total, "ms": int((time.monotonic() - started) * 1000)}
    sys.stdout.write(json.dumps(out) + "\n")  # the only stdout line: the parent treats anything else as a failed pin
    sys.stdout.flush()
    sys.stdin.buffer.read()  # hold the mappings until killed, or until the gateway exits and stdin closes


class Pinner:
    """Parent side: start the child, wait (bounded) for its one-line result, release it after the first mount."""

    def __init__(self, proc: subprocess.Popen, result: dict[str, Any]) -> None:
        self.proc, self.result = proc, result

    @classmethod
    def start(cls, manifest: str, log: Callable[..., None], *, wait_s: float = WAIT_S, python: str = sys.executable) -> Pinner | None:
        if not os.path.isfile(manifest):
            log("pin_skipped", level="WARNING", reason=f"no manifest at {manifest}")
            return None
        started = time.monotonic()
        try:
            proc = subprocess.Popen([python, "-I", os.path.abspath(__file__), manifest], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, close_fds=True)
        except OSError as error:
            log("pin_failed", level="WARNING", reason=f"{type(error).__name__}: {str(error)[:200]}")
            return None
        line, deadline = b"", started + wait_s
        assert proc.stdout is not None
        while b"\n" not in line and len(line) < 4096:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([proc.stdout], [], [], remaining)[0]:
                break
            chunk = os.read(proc.stdout.fileno(), 4096)
            if not chunk:
                break
            line += chunk
        try:
            result = json.loads(line.decode()) if line.endswith(b"\n") else None
        except (UnicodeDecodeError, ValueError):
            result = None
        if not isinstance(result, dict) or not isinstance(result.get("files"), int) or not isinstance(result.get("bytes"), int):
            cls(proc, {}).release()
            log("pin_failed", level="WARNING", reason="no result line" if not line else f"unexpected output: {line[:200]!r}",
                wait_ms=int((time.monotonic() - started) * 1000))
            return None
        log("pinned", files=result["files"], bytes=result["bytes"], pin_ms=result.get("ms"), wait_ms=int((time.monotonic() - started) * 1000))
        return cls(proc, result)

    def release(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        for stream in (self.proc.stdin, self.proc.stdout):
            if stream:
                stream.close()


if __name__ == "__main__":
    main(sys.argv)
