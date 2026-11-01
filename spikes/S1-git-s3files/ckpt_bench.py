"""Spike S1b (contract v5): checkpoint and resume times of the real worker repo.py for Django, inside the microVM, as uid 1000.

VM "a": partial clone on local disk, typical edits (50 modified, 20 new, 1 local commit, 5 staged) → checkpoint to the AP bundle.
VM "b": a fresh local dir (as a new microVM would have) → prepare() = partial clone + restore from the bundle → compare status.
Prints one JSON object. Usage: python3.12 ckpt_bench.py <repo-url> <branch> <runs>
"""
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, "/app")
from repo import Repo  # noqa: E402

URL, BRANCH, RUNS = sys.argv[1], sys.argv[2], int(sys.argv[3])
BUNDLE = "/mnt/work/s1b.bundle"


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=s1", "-c", "user.email=s1@invalid", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout


def edit(d):
    files = [f for f in git(d, "ls-files").splitlines() if f.endswith((".py", ".js", ".md", ".txt"))][:56]
    for f in files[:50]:
        with open(os.path.join(d, f), "a") as fh:
            fh.write("# dshsa s1b\n")
    git(d, "commit", "-qam", "local commit")
    for f in files[50:56]:
        with open(os.path.join(d, f), "a") as fh:
            fh.write("# staged\n")
    git(d, "add", *files[50:55])
    for i in range(20):
        with open(os.path.join(d, f"s1b_new_{i}.py"), "w") as fh:
            fh.write(f"x = {i}\n" * 50)


runs = []
for run in range(1, RUNS + 1):
    for path in ("/home/agent/s1a", "/home/agent/s1b", BUNDLE):
        shutil.rmtree(path, ignore_errors=True) if os.path.isdir(path) else (os.path.exists(path) and os.remove(path))
    a = Repo("/home/agent/s1a/repo", BUNDLE)
    t0 = time.monotonic()
    a.prepare({"cloneUrl": URL, "defaultBranch": BRANCH})
    clone_ms = int((time.monotonic() - t0) * 1000)
    edit(a.dir)
    heavy = a.checkpoint()
    # A realistic turn: 3 files edited since the last checkpoint; then a turn that changed nothing.
    for f in [f for f in git(a.dir, "ls-files").splitlines() if f.endswith((".py", ".js", ".md", ".txt"))][100:103]:
        with open(os.path.join(a.dir, f), "a") as fh:
            fh.write("# realistic turn\n")
    ckpt = a.checkpoint()
    noop = a.checkpoint()
    before = git(a.dir, "status", "--porcelain")
    b = Repo("/home/agent/s1b/repo", BUNDLE)
    t0 = time.monotonic()
    resumed = b.prepare({"cloneUrl": URL, "defaultBranch": BRANCH})
    resume_ms = int((time.monotonic() - t0) * 1000)
    same = git(b.dir, "status", "--porcelain") == before
    total = lambda c: sum(c.get(k, 0) or 0 for k in ("snapshot_ms", "bundle_ms", "copy_ms"))  # noqa: E731
    runs.append({"run": run, "first_clone_ms": clone_ms,
                 "heavy_turn_ms": total(heavy), "heavy_bytes": heavy.get("bytes"),
                 "turn3_ms": total(ckpt), "turn3_snapshot_ms": ckpt.get("snapshot_ms"), "turn3_bundle_ms": ckpt.get("bundle_ms"),
                 "turn3_copy_ms": ckpt.get("copy_ms"), "turn3_bytes": ckpt.get("bytes"),
                 "noop_ms": noop.get("snapshot_ms"), "noop_skipped": noop.get("skipped"),
                 "resume_total_ms": resume_ms, "resume_clone_ms": resumed.get("clone_ms"), "resume_restore_ms": resumed.get("restore_ms"),
                 "status_identical": same})
    print(json.dumps(runs[-1]), flush=True)
for path in ("/home/agent/s1a", "/home/agent/s1b"):
    shutil.rmtree(path, ignore_errors=True)
if os.path.exists(BUNDLE):
    os.remove(BUNDLE)
