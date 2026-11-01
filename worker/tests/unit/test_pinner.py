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


class FakePin:
    def __init__(self):
        self.released = 0

    def release(self):
        self.released += 1


def pin_logs(monkeypatch):
    import gateway
    logs = []
    monkeypatch.setattr(gateway, "log", lambda event, **f: logs.append((event, f)))
    return logs


async def test_failed_first_mount_releases_the_pin_on_the_fallback_timer(monkeypatch):
    import asyncio

    import gateway
    logs = pin_logs(monkeypatch)
    pin = FakePin()
    mounter = gateway.S3FilesMounter(pin, pin_fallback_s=0.2)

    async def refuse(_token):
        raise RuntimeError("broker refused")
    monkeypatch.setattr(mounter, "_mint", refuse)
    with pytest.raises(RuntimeError):
        await mounter.ensure("token")
    assert pin.released == 0 and mounter.pinner is pin  # not at the mount any more: the first turn's CLI still needs its pages
    with pytest.raises(RuntimeError):
        await mounter.ensure("token")  # a retry does not arm a second timer
    await asyncio.sleep(0.4)
    assert pin.released == 1 and mounter.pinner is None
    assert [f for e, f in logs if e == "pin_released"] == [{"reason": "fallback"}]


async def test_the_first_turns_cli_start_releases_the_pin_after_the_grace(monkeypatch):
    import asyncio

    import gateway
    logs = pin_logs(monkeypatch)
    pin = FakePin()
    mounter = gateway.S3FilesMounter(pin, pin_fallback_s=0.6, pin_grace_s=0.1)
    mounter._arm_pin_fallback()  # what the first mount does
    mounter.cli_started()
    await asyncio.sleep(0.02)
    assert pin.released == 0  # the grace: the CLI's start-up may still be reading its binary
    await asyncio.sleep(0.2)
    assert pin.released == 1 and mounter.pinner is None
    mounter.cli_started()
    await asyncio.sleep(0.6)  # the fallback fires too, and finds nothing left to release
    assert pin.released == 1 and [f for e, f in logs if e == "pin_released"] == [{"reason": "cli_started"}]


async def test_a_failing_release_only_logs(monkeypatch):
    import gateway
    logs = pin_logs(monkeypatch)

    class Broken:
        def release(self):
            raise OSError("gone")
    mounter = gateway.S3FilesMounter(Broken())
    await mounter.release_pin("cli_started")
    assert mounter.pinner is None and logs == [("pin_release_failed", {"level": "WARNING", "reason": "OSError: gone"})]


async def test_gateway_reports_the_first_cli_start_once_and_survives_a_bad_hook(keys, tmp_path):
    from gateway_core import Gateway
    from inbox import Store

    class Agent:
        cli = False

        async def call(self, path, body=None):
            return {"state": "running", "cliStarted": self.cli}

    calls = []
    agent = Agent()
    gw = Gateway(verifier=keys.verifier(), mounter=None, agent=agent, store=Store(str(tmp_path)), version="v", on_cli_started=lambda: calls.append(1))
    assert await gw._agent_status() == "running" and calls == []  # running alone is not enough: the turn may still be cloning
    agent.cli = True
    for _ in range(3):
        assert await gw._agent_status() == "running"
    assert calls == [1]

    def explode():
        raise RuntimeError("boom")
    gw2 = Gateway(verifier=keys.verifier(), mounter=None, agent=agent, store=Store(str(tmp_path)), version="v", on_cli_started=explode)
    assert await gw2._agent_status() == "running" and gw2.cli_seen


# ---- cap ----------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("raw, expected", [(None, 512 << 20), ("", 512 << 20), ("1048576", 1 << 20), (" 4096\n", 4096), ("0", 0), ("-1", 512 << 20),
                                           ("12MB", 512 << 20), ("1e9", 512 << 20), ("\u00b2", 512 << 20), ("\u0663", 512 << 20), ("9" * 5000, 512 << 20)])
def test_cap_comes_from_the_env_and_a_bad_value_falls_back(raw, expected):
    assert pinner.cap_from_env({} if raw is None else {"PIN_MAX_BYTES": raw}) == expected


def test_start_passes_the_env_cap_to_the_child_and_warns_on_a_bad_one(tmp_path, monkeypatch):
    files = [write(tmp_path / f"f{i}", b"x" * 4096) for i in range(3)]
    manifest = tmp_path / "manifest.txt"
    manifest.write_text("\n".join(files) + "\n")
    monkeypatch.setenv("PIN_MAX_BYTES", "9000")
    logs = []
    pin = pinner.Pinner.start(str(manifest), lambda event, **f: logs.append((event, f)))
    assert pin is not None and pin.result["files"] == 2 and logs[0][1]["max_bytes"] == 9000
    pin.release()
    monkeypatch.setenv("PIN_MAX_BYTES", "lots")
    logs.clear()
    pin = pinner.Pinner.start(str(manifest), lambda event, **f: logs.append((event, f)))
    assert pin is not None and pin.result["files"] == 3
    assert logs[0] == ("pin_cap_invalid", {"level": "WARNING", "value": "lots", "max_bytes": 512 << 20}) and logs[1][0] == "pinned"
    pin.release()


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
    monkeypatch.setattr(pin_manifest, "first_turn", lambda: [])
    monkeypatch.setattr(pin_manifest, "trusted", lambda p: True)
    pin_manifest.main(["pin_manifest.py", str(tmp_path / "out.txt")])
    assert (tmp_path / "out.txt").read_text() == conf + "\n"
    assert json.loads(capsys.readouterr().out)["files"] == 1


def test_manifest_lists_the_cli_after_the_mount_files_and_drops_untrusted_paths(tmp_path, monkeypatch, capsys):
    mount = [write(tmp_path / f"mount{i}", b"m" * 100) for i in range(2)]
    module, cli = write(tmp_path / "sdk_module.pyc", b"s" * 10), write(tmp_path / "claude", b"c" * 1000)
    agent_owned = write(tmp_path / "agent_owned", b"a")
    monkeypatch.setattr(pin_manifest, "PROGRAMS", [])
    monkeypatch.setattr(pin_manifest, "FILES", mount)
    monkeypatch.setattr(pin_manifest, "AGENT_FILES", [])
    monkeypatch.setattr(pin_manifest, "sdk_files", lambda *a: ([mount[1], agent_owned, module], cli))  # mount[1] again: deduped, keeps its place
    monkeypatch.setattr(pin_manifest, "trusted", lambda p: p != agent_owned)
    monkeypatch.setenv("PIN_MAX_BYTES", "1000")
    pin_manifest.main(["pin_manifest.py", str(tmp_path / "out.txt")])
    assert (tmp_path / "out.txt").read_text().splitlines() == [*mount, module, cli]
    out = capsys.readouterr()
    summary = json.loads(out.out)
    assert (summary["files"], summary["bytes"], summary["mount_files"], summary["mount_bytes"], summary["skipped"]) == (4, 1210, 2, 200, 1)
    assert f"{agent_owned} is not root-owned" in out.err and "1210 bytes exceed the pinner's 1000" in out.err


def test_trusted_needs_the_owner_and_no_foreign_write_bit_up_the_path(tmp_path):
    top = tmp_path / "image"
    (top / "lib").mkdir(parents=True)
    good = write(top / "lib" / "ok.so", b"x")
    group_writable = write(top / "lib" / "gw.so", b"x")
    os.chmod(group_writable, 0o664)
    (top / "open").mkdir(mode=0o777)
    os.chmod(top / "open", 0o777)
    in_open_dir = write(top / "open" / "f", b"x")
    os.symlink(good, top / "link")
    os.mkfifo(top / "fifo")
    me = os.getuid()

    def check(path, **kw):
        return pin_manifest.trusted(str(path), uid=me, untrusted=(str(top / "work"),), top=str(top), **kw)
    assert check(good)
    assert not check(group_writable) and not check(in_open_dir) and not check(top / "link") and not check(top / "fifo")
    assert not check(top / "missing") and not check("relative/path")
    (top / "work").mkdir()
    assert not check(write(top / "work" / "f", b"x"))  # an agent-writable tree, even when the bits look fine
    assert check(top / "workbench") is False  # absent; and the prefix match is by path component, see below
    workbench = write(top / "workbench", b"x")
    assert check(workbench)
    assert not pin_manifest.trusted(good, uid=me + 1, untrusted=(), top=str(top))  # another owner
    assert not pin_manifest.trusted(good)  # the defaults: root-owned up to /, and /tmp is untrusted


def test_sdk_probe_lists_new_sdk_modules_and_the_bundled_cli(tmp_path):
    app = tmp_path / "app"
    sdk = app / "claude_agent_sdk"
    (sdk / "_internal" / "transport").mkdir(parents=True)
    (sdk / "_bundled").mkdir()
    (sdk / "testing").mkdir()
    (app / "already.py").write_text("X = 1\n")
    (app / "agent.py").write_text("import already\n\ndef later():\n    import claude_agent_sdk\n")
    (sdk / "__init__.py").write_text("import already\n")
    (sdk / "lazy.py").write_text("import json\n")
    (sdk / "_internal" / "__init__.py").write_text("")
    (sdk / "_internal" / "transport" / "__init__.py").write_text("")
    (sdk / "_internal" / "transport" / "subprocess_cli.py").write_text(
        "from pathlib import Path\nclass SubprocessCLITransport:\n"
        "    def _find_bundled_cli(self):\n        return str(Path(__file__).parent.parent.parent / '_bundled' / 'claude')\n")
    (sdk / "testing" / "__init__.py").write_text("")
    (sdk / "_bundled" / "claude").write_bytes(b"\x7fELF")
    files, cli = pin_manifest.sdk_files(str(app / "agent.py"), sys.executable)
    assert cli == str(sdk / "_bundled" / "claude")
    names = {os.path.basename(f).split(".")[0] for f in files}
    assert {"lazy", "__init__", "subprocess_cli"} <= names  # every SDK module (source or bytecode), not just the package
    assert "already" not in names  # agent.py imports it before :8080 opens: already in memory
    assert not [f for f in files if "testing" in f]


def test_sdk_probe_without_the_sdk_lists_nothing(tmp_path, capsys):
    (tmp_path / "agent.py").write_text("import json\n")
    assert pin_manifest.sdk_files(str(tmp_path / "agent.py"), sys.executable) == ([], None)
    assert "bundled CLI was not found" in capsys.readouterr().err
    assert pin_manifest.sdk_files(str(tmp_path / "none.py"), sys.executable) == ([], None)


def test_first_turn_puts_the_cli_last(monkeypatch):
    monkeypatch.setattr(pin_manifest, "sdk_files", lambda *a: (["/m.pyc"], "/cli"))
    monkeypatch.setattr(pin_manifest, "AGENT_FILES", ["/etc/hosts"])
    monkeypatch.setattr(pin_manifest, "is_elf", lambda p: False)
    monkeypatch.setattr(pin_manifest, "ldd", lambda p: ["/lib/libc.so.6"] if p == "/cli" else [])
    assert pin_manifest.first_turn() == ["/m.pyc", "/etc/hosts", "/cli", "/lib/libc.so.6"]


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


# ---- agent: the first turn's CLI start --------------------------------------------------------------------------------
def fake_sdk(connect_s: float, first_message_s: float):
    """The parts of claude_agent_sdk that sdk_runner uses: connect takes `connect_s`, the first message `first_message_s` more."""
    import asyncio
    import types

    class Message:
        pass

    class AssistantMessage(Message):
        content: list = []

    class ResultMessage(Message):
        is_error = False

    class Client:
        def __init__(self, options):
            self.options = options

        async def __aenter__(self):
            await asyncio.sleep(connect_s)
            return self

        async def __aexit__(self, *exc):
            return False

        async def interrupt(self):
            pass

        async def query(self, prompt):
            pass

        async def receive_response(self):
            await asyncio.sleep(first_message_s)
            yield AssistantMessage()
            yield ResultMessage()

    def tool(name, description, schema):
        return lambda fn: fn
    sdk = types.ModuleType("claude_agent_sdk")
    sdk.__dict__.update(AssistantMessage=AssistantMessage, ResultMessage=ResultMessage, TextBlock=type("TextBlock", (), {}), ClaudeSDKClient=Client,
                        ClaudeAgentOptions=lambda **kw: kw, HookMatcher=lambda **kw: kw, create_sdk_mcp_server=lambda *a, **kw: object(), tool=tool)
    return sdk


async def test_sdk_runner_logs_cli_started_once_per_turn_and_first_only_once(tmp_path, monkeypatch, capsys):
    import agent_core
    from inbox import Store
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", fake_sdk(0.05, 0.1))

    async def runner(*_a):
        pass
    cp = agent_core.ControlPlane(lambda *_a: None, "key", lambda: "a")
    worker = agent_core.Worker(Store(str(tmp_path)), cp, runner, repo_dir=str(tmp_path / "repo"), config_dir=str(tmp_path / ".claude"))
    assert worker.cli_started is False
    await agent_core.sdk_runner(worker, "go")
    await agent_core.sdk_runner(worker, "again")
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines() if '"cli_started"' in line]
    assert [(line["component"], line["first"]) for line in lines] == [("agent", True), ("agent", False)] and worker.cli_started
    assert all(line["ms"] >= 140 and 40 <= line["connect_ms"] < line["ms"] for line in lines)  # from before connect to the first message
