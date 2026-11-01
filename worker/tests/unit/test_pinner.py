"""Page pinner (V2 snapshot page-cache drop): the build-time manifest, the pin loop, the gateway's start and release."""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
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


def test_pin_skips_symlinks_fifos_and_devices_without_blocking(tmp_path):
    real = write(tmp_path / "real", b"r" * 100)
    os.symlink(real, tmp_path / "link")
    os.mkfifo(tmp_path / "fifo")  # a blocking open would wait for a writer forever
    result = []
    worker = threading.Thread(target=lambda: result.append(pinner.pin([str(tmp_path / "link"), str(tmp_path / "fifo"), "/dev/null", real],
                                                                      time.monotonic() + 5)), daemon=True)
    worker.start()
    worker.join(2)  # a regression to a blocking open fails here instead of hanging the suite
    assert result, "pin() blocked on a FIFO"
    maps, total = result[0]
    assert (len(maps), total) == (1, 100)


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


def test_an_unexpected_pinner_error_never_keeps_the_gateway_from_listening(monkeypatch):
    import gateway

    def explode(*_a, **_k):
        raise MemoryError("boom")
    logs = []
    monkeypatch.setattr(gateway, "MOUNT_MODE", "s3files")
    monkeypatch.setattr(gateway.Pinner, "start", explode)
    monkeypatch.setattr(gateway, "log", lambda event, **f: logs.append((event, f)))
    assert gateway.start_pinner() is None
    assert logs == [("pin_failed", {"level": "WARNING", "reason": "MemoryError: boom"})]
    monkeypatch.setattr(gateway, "MOUNT_MODE", "local")
    assert gateway.start_pinner() is None and len(logs) == 1


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


def test_probe_runs_the_target_interpreter_without_isolation_flags(tmp_path, monkeypatch):
    """-I/-s drop /usr/local site-packages on AL2023, where the mount helper's botocore lives."""
    calls = []

    def run(argv, **_kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="[]\n", stderr="")
    monkeypatch.setattr(pin_manifest.subprocess, "run", run)
    pin_manifest.python_files("/usr/bin/python3", "/usr/sbin/mount.s3files")
    flags = calls[0][1:calls[0].index("-c")]
    assert flags == ["-E"] and not {"-I", "-s"} & set(flags)


def test_manifest_runs_exactly_as_the_dockerfile_runs_it(tmp_path):
    """The Dockerfile's flags, on a copy of the script next to its pinner import (no PYTHONPATH, as in the image build)."""
    here = os.path.dirname(pin_manifest.__file__)
    dockerfile = open(os.path.join(here, "Dockerfile")).read()
    flags = re.search(r"^RUN python3\.12 ((?:-\S+ )*)/app/pin_manifest\.py ", dockerfile, re.M)
    assert flags, "the Dockerfile no longer runs pin_manifest.py"
    for name in ("pin_manifest.py", "pinner.py"):
        shutil.copy(os.path.join(here, name), tmp_path / name)
    out = tmp_path / "manifest.txt"
    r = subprocess.run([sys.executable, *flags.group(1).split(), str(tmp_path / "pin_manifest.py"), str(out)], capture_output=True, text=True,
                       timeout=600, cwd=tmp_path, env={"PATH": os.environ.get("PATH", "")})
    assert r.returncode == 0, r.stderr[-1000:]
    assert json.loads(r.stdout.strip().splitlines()[-1])["component"] == "pin_manifest" and out.exists()
