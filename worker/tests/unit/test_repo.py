"""Checkpoint → lose the VM → restore, against a local bare 'GitHub' (partial clones allowed), with every kind of local change."""
import os
import subprocess

import pytest
from repo import WIP, Repo

ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null"}


def sh(cwd, *args):
    return subprocess.run(list(args), cwd=cwd, check=True, capture_output=True, text=True, env={**os.environ, **ENV}).stdout.strip()


@pytest.fixture
def remote(tmp_path):
    seed, bare = tmp_path / "seed", tmp_path / "origin.git"
    seed.mkdir()
    sh(seed, "git", "init", "-q", "-b", "main")
    for name in ("a.txt", "b.txt", "c.txt"):
        (seed / name).write_text(f"{name} v1\n")
    (seed / ".gitignore").write_text("ignored/\n")
    sh(seed, "git", "add", ".")
    sh(seed, "git", "commit", "-qm", "init")
    sh(tmp_path, "git", "clone", "-q", "--bare", str(seed), str(bare))
    sh(bare, "git", "config", "uploadpack.allowFilter", "true")
    return f"file://{bare}"


def vm(tmp_path, n):
    """A 'microVM': its own local disk; the AP (bundle) is shared."""
    return Repo(str(tmp_path / f"vm{n}" / "work" / "repo"), str(tmp_path / "ap" / "repo.bundle"), env=ENV)


def test_first_start_is_a_partial_clone(tmp_path, remote):
    (tmp_path / "ap").mkdir()
    repo = vm(tmp_path, 1)
    assert repo.prepare({"cloneUrl": remote, "defaultBranch": "main"})["mode"] == "cloned"
    assert sh(repo.dir, "git", "config", "remote.origin.partialclonefilter") == "blob:none"
    assert repo.prepare({"cloneUrl": remote})["mode"] == "present"


def test_local_changes_survive_a_lost_vm(tmp_path, remote):
    (tmp_path / "ap").mkdir()
    one = vm(tmp_path, 1)
    one.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    d = one.dir
    sh(d, "git", "checkout", "-qb", "dshsa/fix-1")
    (tmp_path / "vm1/work/repo/a.txt").write_text("a committed locally\n")
    sh(d, "git", "commit", "-qam", "local commit, not pushed")
    (tmp_path / "vm1/work/repo/a.txt").write_text("a modified, unstaged\n")
    (tmp_path / "vm1/work/repo/b.txt").write_text("b staged\n")
    sh(d, "git", "add", "b.txt")
    os.remove(tmp_path / "vm1/work/repo/c.txt")
    (tmp_path / "vm1/work/repo/new.txt").write_text("brand new, untracked\n")
    (tmp_path / "vm1/work/repo/ignored").mkdir()
    (tmp_path / "vm1/work/repo/ignored/junk").write_text("x")
    status_before = sh(d, "git", "status", "--porcelain")
    head_before = sh(d, "git", "rev-parse", "HEAD")

    result = one.checkpoint()
    assert result["bytes"] > 0 and result["branch"] == "dshsa/fix-1"
    # The checkpoint touched neither the branch, nor the index, nor the work tree.
    assert sh(d, "git", "status", "--porcelain") == status_before and sh(d, "git", "rev-parse", "HEAD") == head_before

    two = vm(tmp_path, 2)  # vm1's disk is gone; only the AP and GitHub remain
    out = two.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    assert out["mode"] == "resumed" and out["branch"] == "dshsa/fix-1"
    d2 = two.dir
    assert sh(d2, "git", "symbolic-ref", "--short", "HEAD") == "dshsa/fix-1"
    assert sh(d2, "git", "rev-parse", "HEAD") == head_before
    assert sh(d2, "git", "status", "--porcelain") == status_before
    assert (tmp_path / "vm2/work/repo/a.txt").read_text() == "a modified, unstaged\n"
    assert (tmp_path / "vm2/work/repo/new.txt").read_text() == "brand new, untracked\n"
    assert not (tmp_path / "vm2/work/repo/c.txt").exists()
    assert sh(d2, "git", "diff", "--cached", "--name-only") == "b.txt"
    assert sh(d2, "git", "remote", "get-url", "origin") == remote


def test_clean_tree_and_repeated_checkpoints(tmp_path, remote):
    (tmp_path / "ap").mkdir()
    one = vm(tmp_path, 1)
    one.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    first = one.checkpoint()
    (tmp_path / "vm1/work/repo/new.txt").write_text("later\n")
    second = one.checkpoint()
    assert first["wip"] != second["wip"] and sh(one.dir, "git", "rev-parse", WIP) == second["wip"]
    two = vm(tmp_path, 2)
    assert two.prepare({"cloneUrl": remote, "defaultBranch": "main"})["branch"] == "main"
    assert (tmp_path / "vm2/work/repo/new.txt").read_text() == "later\n"
    assert sh(two.dir, "git", "status", "--porcelain") == "?? new.txt"


def test_no_repo_and_no_url(tmp_path):
    repo = vm(tmp_path, 1)
    assert repo.checkpoint() == {"skipped": "no repository"}
    assert repo.prepare({})["mode"] == "empty"


def test_unchanged_tree_skips_the_bundle(tmp_path, remote):
    (tmp_path / "ap").mkdir()
    one = vm(tmp_path, 1)
    one.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    (tmp_path / "vm1/work/repo/a.txt").write_text("edit\n")
    first = one.checkpoint()
    assert first["bytes"] > 0 and "copy_ms" in first
    assert one.checkpoint()["skipped"] == "unchanged"
    (tmp_path / "vm1/work/repo/a.txt").write_text("edit 2\n")
    assert "bytes" in one.checkpoint()
    assert "bytes" in one.checkpoint(force=True)


def test_tags_off_origin_branches_stay_out_of_the_bundle(tmp_path, remote):
    """--all would bundle a tag whose history no origin branch reaches (Django: 51 MB); only heads + refs/dshsa/* go in."""
    bare = remote[len("file://"):]
    side = tmp_path / "side"
    sh(tmp_path, "git", "clone", "-q", bare, str(side))
    sh(side, "git", "checkout", "-q", "--orphan", "attic")
    (side / "big.bin").write_bytes(os.urandom(200_000))
    sh(side, "git", "add", "big.bin")
    sh(side, "git", "commit", "-qm", "old history")
    sh(side, "git", "tag", "archive/attic")
    sh(side, "git", "push", "-q", "origin", "archive/attic")
    (tmp_path / "ap").mkdir()
    one = vm(tmp_path, 1)
    one.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    assert "archive/attic" in sh(one.dir, "git", "tag")
    (tmp_path / "vm1/work/repo/a.txt").write_text("small edit\n")
    assert one.checkpoint()["bytes"] < 20_000


def test_oversized_untracked_output_falls_back_to_tracked_changes(tmp_path, remote, monkeypatch):
    import repo as repo_module
    monkeypatch.setattr(repo_module, "MAX_BUNDLE_BYTES", 50_000)
    (tmp_path / "ap").mkdir()
    one = vm(tmp_path, 1)
    one.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    (tmp_path / "vm1/work/repo/a.txt").write_text("tracked edit\n")
    (tmp_path / "vm1/work/repo/build.bin").write_bytes(os.urandom(300_000))
    result = one.checkpoint()
    assert result["warning"] and result["bytes"] < 50_000
    two = vm(tmp_path, 2)
    two.prepare({"cloneUrl": remote, "defaultBranch": "main"})
    assert (tmp_path / "vm2/work/repo/a.txt").read_text() == "tracked edit\n"
    assert not (tmp_path / "vm2/work/repo/build.bin").exists()
