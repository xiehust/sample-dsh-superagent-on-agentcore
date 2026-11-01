"""Durable inbox and agent state on the ticket's access point (design §4.10: /mnt/work/.dshsa/).

The gateway (root) appends inputs; the agent (uid 1000) reads them and records which it took. Both survive the microVM, so a
new VM resumes exactly where the last one stopped. On the access point every file is owned by uid 1000 whoever writes it.

inbox.jsonl  one §4.4 input per line, deduplicated by id (append-only)
state.json   {"assignmentId", "read": [ids], "turns", "clean", "lastEnd"}
config.json  the latest §4.4 ticket + config (no token)
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from typing import Any


class Store:
    def __init__(self, root: str, owner: int | None = None) -> None:
        """`owner`: chown what this process writes (local mode only; on the AP every file is uid 1000 already)."""
        self.root = root
        self.owner = owner
        self.dir = os.path.join(root, ".dshsa")
        self.inbox_path = os.path.join(self.dir, "inbox.jsonl")
        self.state_path = os.path.join(self.dir, "state.json")
        self.config_path = os.path.join(self.dir, "config.json")
        self.lock_path = os.path.join(self.dir, "inbox.lock")

    def ensure(self) -> None:
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self._own(self.root)
        self._own(self.dir)

    def _own(self, path: str) -> None:
        if self.owner is not None and os.path.exists(path):
            os.chown(path, self.owner, self.owner)

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        self.ensure()
        with open(self.lock_path, "a") as lock:
            self._own(self.lock_path)
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    # ---- inbox -----------------------------------------------------------------------------------------------------
    def inputs(self) -> list[dict[str, Any]]:
        try:
            with open(self.inbox_path) as f:
                lines = f.read().splitlines()
        except FileNotFoundError:
            return []
        out: list[dict[str, Any]] = []
        for line in lines:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn last line from a crash mid-append; its sender retries the delivery
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                out.append(item)
        return out

    def append(self, inputs: list[dict[str, Any]]) -> list[str]:
        """Append inputs not seen before; returns the ids now present among `inputs` (new or already there)."""
        with self._locked():
            seen = {item["id"] for item in self.inputs()}
            fresh = [item for item in inputs if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] not in seen]
            unique: dict[str, dict[str, Any]] = {}
            for item in fresh:
                unique.setdefault(item["id"], item)
            if unique:
                with open(self.inbox_path, "a") as f:
                    for item in unique.values():
                        f.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
                    f.flush()
                    os.fsync(f.fileno())
                self._own(self.inbox_path)
            present = seen | set(unique)
        return [item["id"] for item in inputs if isinstance(item, dict) and item.get("id") in present]

    # ---- state -----------------------------------------------------------------------------------------------------
    def state(self) -> dict[str, Any]:
        try:
            with open(self.state_path) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save_state(self, state: dict[str, Any]) -> None:
        self._write_json(self.state_path, state)

    def unread(self) -> list[dict[str, Any]]:
        read = set(self.state().get("read", []))
        return [item for item in self.inputs() if item["id"] not in read]

    def mark_read(self, ids: list[str]) -> None:
        with self._locked():
            state = self.state()
            read = list(dict.fromkeys([*state.get("read", []), *ids]))
            self.save_state({**state, "read": read})

    def update_state(self, **fields: Any) -> dict[str, Any]:
        with self._locked():
            state = {**self.state(), **fields}
            self.save_state(state)
            return state

    # ---- config ----------------------------------------------------------------------------------------------------
    def config(self) -> dict[str, Any]:
        try:
            with open(self.config_path) as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def save_config(self, value: dict[str, Any]) -> None:
        self._write_json(self.config_path, value)

    def _write_json(self, path: str, value: Any) -> None:
        self.ensure()
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".tmp-")
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        self._own(tmp)
        os.replace(tmp, path)
