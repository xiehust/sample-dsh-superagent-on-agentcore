"""The ticket's git working copy (contract v5 §4.10): hot copy on LOCAL disk, checkpointed to the AP as a bundle.

Layout: /home/agent/work/repo (local, lost with the VM) · /mnt/work/repo.bundle (S3 Files, survives the VM).

checkpoint() — at every turn end and on SIGTERM, before `turn.ended`; never touches the branch, the index or the work tree:
  * refs/dshsa/wip-index = a commit of the current index (staged state), parent HEAD
  * refs/dshsa/wip       = a commit of the whole work tree incl. untracked, not-ignored files (built with a temporary
                           index), parent HEAD; its message records the checked-out branch and HEAD
  * repo.bundle          = `git bundle create --branches --glob=refs/dshsa/* --not --remotes=origin --tags`: only what
                           GitHub does not have (local commits, local branches, the wip refs). Never `--all`: it bundles
                           tags whose history no origin branch reaches (Django: 51 MB / 24 s instead of 8 KB / 40 ms), and
                           the first clone is blob:none, so a full bundle would lazily download every historical blob.
                           Built on local disk, copied to the AP in one sequential write, fsync'd, renamed, then sync().
                           Skipped when nothing changed since the last checkpoint; above MAX_BUNDLE_BYTES the wip falls
                           back to tracked files only (large untracked output), with a warning.
prepare() — on a fresh VM: partial clone from GitHub; if a bundle exists, fetch its refs, check out the recorded branch and
  restore the work tree (wip) and the index (wip-index), so modified, staged, deleted and untracked files come back as they were.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from collections.abc import Callable
from typing import Any

WIP, WIP_INDEX = "refs/dshsa/wip", "refs/dshsa/wip-index"
MAX_BUNDLE_BYTES = 50 * 1024 * 1024
BUNDLE_REFS = ["--branches", "--glob=refs/dshsa/*", "--not", "--remotes=origin", "--tags"]
IDENTITY = ["-c", "user.name=dshsa-worker", "-c", "user.email=dshsa-worker@invalid", "-c", "commit.gpgsign=false"]


class RepoError(RuntimeError):
    pass


class Repo:
    def __init__(self, work_dir: str, bundle_path: str, *, run: Callable[..., subprocess.CompletedProcess] = subprocess.run,
                 env: dict[str, str] | None = None) -> None:
        self.dir, self.bundle = work_dir, bundle_path
        self._run = run
        self.env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", **(env or {})}

    # ---- helpers ---------------------------------------------------------------------------------------------------
    def git(self, *args: str, cwd: str | None = None, check: bool = True, env: dict[str, str] | None = None, timeout: float = 1800) -> str:
        result = self._run(["git", *IDENTITY, *args], cwd=cwd or self.dir, capture_output=True, text=True, timeout=timeout,
                           env={**self.env, **(env or {})})
        if check and result.returncode != 0:
            raise RepoError(f"git {args[0]} failed ({result.returncode}): {(result.stderr or result.stdout).strip()[-500:]}")
        return result.stdout.strip()

    def exists(self) -> bool:
        return os.path.isdir(os.path.join(self.dir, ".git"))

    # ---- checkpoint ------------------------------------------------------------------------------------------------
    def _trees(self, head: str, tracked_only: bool = False) -> tuple[str, str]:
        """(index tree, work tree) without touching the real index or work tree; the work tree via a temporary index."""
        index_tree = self.git("write-tree")
        tmp_index = os.path.join(self.dir, ".git", "dshsa-wip-index")
        try:
            env = {"GIT_INDEX_FILE": tmp_index}
            real_index = os.path.join(self.dir, ".git", "index")
            if os.path.exists(real_index):
                # Start from a copy of the real index: its stat cache lets `add` rehash only changed files (7k-file repo: 0.4 s → ~0.1 s).
                shutil.copyfile(real_index, tmp_index)
            else:
                self.git("read-tree", head, env=env)
            self.git("add", "-u" if tracked_only else "-A", ".", env=env)
            work_tree = self.git("write-tree", env=env)
        finally:
            if os.path.exists(tmp_index):
                os.remove(tmp_index)
        return index_tree, work_tree

    def snapshot(self, tracked_only: bool = False) -> dict[str, str] | None:
        """Record the index and the whole work tree as commits under refs/dshsa/, leaving branch, index and work tree alone."""
        head = self.git("rev-parse", "--verify", "-q", "HEAD", check=False)
        if not head:
            return None
        branch = self.git("symbolic-ref", "-q", "--short", "HEAD", check=False)
        index_tree, work_tree = self._trees(head, tracked_only)
        heads = self.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
        fingerprint = hashlib.sha256(f"{head}\n{branch}\n{index_tree}\n{work_tree}\n{heads}".encode()).hexdigest()
        index_commit = self.git("commit-tree", index_tree, "-p", head, "-m", "dshsa wip index")
        wip = self.git("commit-tree", work_tree, "-p", head, "-m", f"dshsa wip\n\nbranch={branch}\nhead={head}\nindex={index_commit}")
        return {"head": head, "branch": branch, "wip": wip, "index": index_commit, "fingerprint": fingerprint}

    def _last(self) -> dict[str, Any]:
        try:
            with open(os.path.join(self.dir, ".git", "dshsa-checkpoint.json")) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def checkpoint(self, force: bool = False) -> dict[str, Any]:
        """Snapshot, then write the incremental bundle atomically and durably. Returns timings (ms) and the bundle size."""
        if not self.exists():
            return {"skipped": "no repository"}
        t0 = time.monotonic()
        snap = self.snapshot()
        if snap is None:
            return {"skipped": "no commits"}
        if not force and self._last().get("fingerprint") == snap["fingerprint"] and os.path.exists(self.bundle):
            return {"skipped": "unchanged", "snapshot_ms": int((time.monotonic() - t0) * 1000)}
        local = os.path.join(self.dir, ".git", "dshsa.bundle")
        warning = None
        for tracked_only in (False, True):
            self.git("update-ref", WIP_INDEX, snap["index"])
            self.git("update-ref", WIP, snap["wip"])
            t1 = time.monotonic()
            self.git("bundle", "create", local, *BUNDLE_REFS, timeout=900)
            size = os.path.getsize(local)
            if size <= MAX_BUNDLE_BYTES or tracked_only:
                break
            warning = f"bundle {size} B > {MAX_BUNDLE_BYTES} B with untracked files; checkpointing tracked changes only"
            snap = self.snapshot(tracked_only=True) or snap
        t2 = time.monotonic()
        # One sequential copy to the AP (git's own write pattern on S3 Files is far slower), then fsync, rename, sync.
        tmp = f"{self.bundle}.tmp"
        shutil.copyfile(local, tmp)
        fd = os.open(tmp, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, self.bundle)
        dir_fd = os.open(os.path.dirname(self.bundle) or ".", os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
        os.sync()
        t3 = time.monotonic()
        with open(os.path.join(self.dir, ".git", "dshsa-checkpoint.json"), "w") as f:
            json.dump({"fingerprint": snap["fingerprint"], "at": time.time()}, f)
        result = {**{k: v for k, v in snap.items() if k != "fingerprint"}, "snapshot_ms": int((t1 - t0) * 1000),
                  "bundle_ms": int((t2 - t1) * 1000), "copy_ms": int((t3 - t2) * 1000), "bytes": size}
        return {**result, "warning": warning} if warning else result

    # ---- prepare / resume ------------------------------------------------------------------------------------------
    def clone(self, url: str, branch: str) -> None:
        parent = os.path.dirname(self.dir)
        os.makedirs(parent, exist_ok=True)
        tmp = self.dir + ".partial"
        self._run(["rm", "-rf", tmp], check=True)
        self.git("clone", "--filter=blob:none", "--branch", branch, url, tmp, cwd=parent, timeout=1800)
        if os.path.exists(self.dir):
            self._run(["rm", "-rf", self.dir], check=True)
        os.replace(tmp, self.dir)

    def restore(self) -> dict[str, str]:
        """Apply repo.bundle on top of a fresh clone: refs, then the recorded branch, work tree and index."""
        self.git("bundle", "verify", self.bundle)
        self.git("fetch", "--no-tags", "--update-head-ok", self.bundle, "+refs/heads/*:refs/heads/*", "+refs/dshsa/*:refs/dshsa/*")
        message = self.git("log", "-1", "--format=%B", WIP)
        meta = dict(line.split("=", 1) for line in message.splitlines() if "=" in line)
        if meta.get("branch"):
            self.git("checkout", "-q", "-f", meta["branch"])
        else:
            self.git("checkout", "-q", "-f", "--detach", meta["head"])
        # Work tree := wip (modified, deleted and untracked files as they were); then index := the recorded staged state.
        self.git("read-tree", "-m", "-u", "HEAD", WIP)
        self.git("read-tree", meta.get("index") or WIP_INDEX)
        return meta

    def prepare(self, repo: dict[str, Any]) -> dict[str, Any]:
        """Make the local working copy exist: keep it, or resume it from the bundle, or clone it the first time."""
        t0 = time.monotonic()
        if self.exists():
            return {"mode": "present"}
        url, branch = repo.get("cloneUrl"), repo.get("defaultBranch", "main")
        if not url:
            os.makedirs(self.dir, exist_ok=True)
            return {"mode": "empty"}
        self.clone(url, branch)
        t1 = time.monotonic()
        if not os.path.exists(self.bundle):
            return {"mode": "cloned", "clone_ms": int((t1 - t0) * 1000)}
        meta = self.restore()  # no `fetch origin` afterwards: the clone above is seconds old
        return {"mode": "resumed", "branch": meta.get("branch"), "clone_ms": int((t1 - t0) * 1000), "restore_ms": int((time.monotonic() - t1) * 1000)}
