"""Page pinner (V2 snapshot page-cache drop): the build-time manifest, the pin loop, the gateway's start and release."""
import json
import os
import sys
import time

import pin_manifest
import pinner
import pytest


def write(path, data: bytes):
    path.write_bytes(data)
    return str(path)


# ---- pin loop ---------------------------------------------------------------------------------------------------------
def test_pin_maps_whole_files_within_the_budget(tmp_path):
    a = write(tmp_path / "a", b"a" * 5000)
    big = write(tmp_path / "big", b"b" * 9000)
    empty = write(tmp_path / "empty", b"")
    c = write(tmp_path / "c", b"c" * 3000)
    maps, total = pinner.pin([a, str(tmp_path / "missing"), empty, big, c], time.monotonic() + 5, max_bytes=10000)
    # big would exceed the cap: skipped whole, not partially pinned; later files still fit.
    assert total == 8000 and [len(m) for m in maps] == [5000, 3000] and maps[0][:3] == b"aaa"


def test_pin_stops_at_the_deadline(tmp_path):
    a = write(tmp_path / "a", b"a" * 10)
    assert pinner.pin([a], time.monotonic() - 1) == ([], 0)


# ---- gateway side -----------------------------------------------------------------------------------------------------
def test_start_reports_the_pin_and_release_ends_the_child(tmp_path):
    files = [write(tmp_path / f"f{i}", b"x" * 4096) for i in range(3)]
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("# comment\n" + "\n".join(files) + "\n\n")
    logs = []
    pin = pinner.Pinner.start(str(manifest), lambda event, **f: logs.append((event, f)))
    assert pin is not None and pin.result["files"] == 3 and pin.result["bytes"] == 3 * 4096
    assert logs[0][0] == "pinned" and logs[0][1]["files"] == 3
    time.sleep(0.2)
    assert pin.proc.poll() is None  # it holds the mappings until released
    pin.release()
    assert pin.proc.poll() is not None
    pin.release()  # idempotent


def test_child_exits_when_its_parent_goes_away(tmp_path):
    manifest = tmp_path / "manifest.txt"
    manifest.write_text(write(tmp_path / "f", b"x") + "\n")
    pin = pinner.Pinner.start(str(manifest), lambda *a, **k: None)
    assert pin is not None
    pin.proc.stdin.close()  # what the gateway's exit does
    assert pin.proc.wait(timeout=5) == 0


def test_missing_manifest_is_a_warning_not_an_error(tmp_path):
    logs = []
    assert pinner.Pinner.start(str(tmp_path / "none"), lambda event, **f: logs.append((event, f))) is None
    assert logs[0][0] == "pin_skipped" and logs[0][1]["level"] == "WARNING"


@pytest.mark.parametrize("code", ["print('noise')", "import time; time.sleep(30)", "raise SystemExit(3)"])
def test_bad_or_slow_child_is_killed_and_the_gateway_goes_on(tmp_path, code):
    fake = tmp_path / "fake_python"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} -c \"{code}\"\n")
    fake.chmod(0o755)
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("")
    logs, started = [], time.monotonic()
    assert pinner.Pinner.start(str(manifest), lambda event, **f: logs.append((event, f)), wait_s=1, python=str(fake)) is None
    assert time.monotonic() - started < 4 and logs[0][0] == "pin_failed" and logs[0][1]["level"] == "WARNING"


async def test_first_mount_releases_the_pin_even_when_it_fails(monkeypatch):
    import gateway

    class FakePin:
        released = 0

        def release(self):
            self.released += 1

    pin = FakePin()
    mounter = gateway.S3FilesMounter(pin)

    async def refuse(_token):
        raise RuntimeError("broker refused")
    monkeypatch.setattr(mounter, "_mint", refuse)
    with pytest.raises(RuntimeError):
        await mounter.ensure("token")
    assert pin.released == 1 and mounter.pinner is None
    with pytest.raises(RuntimeError):
        await mounter.ensure("token")
    assert pin.released == 1


# ---- build-time manifest ----------------------------------------------------------------------------------------------
def test_manifest_follows_shebangs_lazy_imports_and_dedupes_by_inode(tmp_path):
    pkg = tmp_path / "helperlib"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    (pkg / "lazy.py").write_text("VALUE = 1\n")
    script = tmp_path / "helper"
    script.write_text(f"#!{sys.executable}\ndef later():\n    import helperlib.lazy\n")
    script.chmod(0o755)
    os.link(script, tmp_path / "helper-hardlink")
    os.symlink(script, tmp_path / "helper-symlink")
    (tmp_path / "conf").write_text("x=1\n")
    paths = pin_manifest.collect([str(script), str(tmp_path / "helper-hardlink"), str(tmp_path / "helper-symlink"), "no-such-program"],
                                 [str(tmp_path / "conf"), str(tmp_path / "absent")])
    assert paths[0] == str(script) and paths.count(str(script)) == 1 and str(tmp_path / "helper-hardlink") not in paths
    assert paths[1] == os.path.realpath(sys.executable)  # the interpreter follows the script
    assert str(pkg / "lazy.py") in paths  # a function-level import counts (no bytecode yet: the source is what is read)
    assert str(tmp_path / "conf") in paths and str(tmp_path / "absent") not in paths
    assert any(os.path.basename(p).startswith("libc.so") for p in paths)  # ldd of the interpreter
    assert len(paths) == len({os.stat(p).st_ino for p in paths})


def test_shebang_through_env(tmp_path):
    (tmp_path / "a").write_text("#!/usr/bin/env python3 -u\n")
    (tmp_path / "b").write_text("#!/bin/bash\n")
    (tmp_path / "c").write_bytes(b"\x7fELF")
    assert [pin_manifest.shebang(str(tmp_path / n)) for n in "abc"] == [["python3"], ["/bin/bash"], []]


def test_manifest_prefers_current_bytecode(tmp_path):
    import py_compile
    (tmp_path / "mod.py").write_text("X = 1\n")
    pyc = py_compile.compile(str(tmp_path / "mod.py"), cfile=None)
    script = tmp_path / "run"
    script.write_text(f"#!{sys.executable}\nimport mod\n")
    paths = pin_manifest.collect([str(script)], [])
    assert pyc in paths and str(tmp_path / "mod.py") not in paths


def test_manifest_main_writes_one_path_per_line(tmp_path, monkeypatch, capsys):
    conf = write(tmp_path / "conf", b"x")
    monkeypatch.setattr(pin_manifest, "PROGRAMS", [])
    monkeypatch.setattr(pin_manifest, "FILES", [conf])
    pin_manifest.main(["pin_manifest.py", str(tmp_path / "out.txt")])
    assert (tmp_path / "out.txt").read_text() == conf + "\n"
    assert json.loads(capsys.readouterr().out)["files"] == 1
