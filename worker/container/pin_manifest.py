"""Build-time probe for pinner.py: list the files a first request reads, as one path per line, most urgent first.

Runs as the Dockerfile's last step, inside the finished image: interpreter versions and library paths differ between base
images, so a hand-written list would go stale. Sources, in this order (the pinner's cap drops the tail first):
  - the programs the first request starts (the mount helper, efs-proxy, mount.nfs; the agent's git/gh and helpers),
    following each script's shebang to its interpreter;
  - Python scripts: every module they can import (modulefinder, run by the script's own interpreter, so function-level lazy
    imports count), as the compiled bytecode the interpreter actually reads, plus the files a warm-up of the botocore
    code paths opens (an `open` audit hook: endpoint and model data that no import names);
  - `ldd` of every ELF found above (executables and extension modules);
  - configuration and CA files opened at run time;
  - the agent's first turn: the Agent SDK modules (and their dependencies) that agent.py has not imported before it
    listens (the SDK is imported lazily, on the first turn), then, last and largest, the Claude CLI binary the SDK spawns,
    found the way the SDK finds it.
Deduplicated by inode. Only files that root owns and nobody else can write, along a path of such directories and outside
the agent's writable trees, are listed: the pinner reads them as root. Any other path is dropped with a warning.
Usage: python3.12 -E -s pin_manifest.py <output> (not -I: it implies -P, and this script imports pinner from its own directory)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys

from pinner import cap_from_env

SEARCH_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
# The target interpreter runs as the real program does (`#!/usr/bin/python3`, no flags), except that the environment is
# ignored. Never -I or -s: on AL2023 they also drop /usr/local/lib/python3.X/site-packages, where botocore (imported by the
# mount helper's efs_utils_common) lives, and the manifest would silently miss it.
PROBE_FLAGS = ["-E"]

# New processes in the order a first request starts them: the mount (gateway, root), then the agent's first repository work.
# The gateway and the agent themselves are not probed: they import before the port opens, and their loaded extension
# modules and libraries stay mapped, so their pages survive the drop without a pin.
PROGRAMS = ["mount", "mount.s3files", "efs-proxy", "mount.nfs4",
            "/app/git-credential-dshsa", "/app/gh", "git", "/usr/libexec/git-core/git-remote-https", "gh-real"]
# Code each interpreter runs under the open audit hook: the botocore paths the mount helper's credentials take.
WARMUPS = {
    "python3": ["import botocore.session; s = botocore.session.get_session(); s.create_client('sts', region_name='us-east-1')"],
}
FILES = ["/etc/ld.so.cache", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/amazon/efs/s3files-utils.conf",
         "/etc/amazon/efs/efs-utils.conf", "/etc/amazon/efs/efs-utils.crt", "/etc/pki/tls/certs/ca-bundle.crt",
         "/etc/pki/tls/openssl.cnf", "/etc/gitconfig"]

AGENT = "/app/agent.py"
AGENT_INTERPRETER = "python3.12"  # entrypoint.sh: `python3.12 /app/agent.py`, PYTHONPATH=/app
AGENT_FILES = ["/etc/hosts", "/etc/localtime"]  # opened by the CLI at start (with the CA bundle in FILES)
# Never listed: the agent (uid 1000) can write there, or they are not files of the image.
UNTRUSTED = ("/mnt", "/home", "/root", "/tmp", "/var/tmp", "/dev", "/proc", "/sys", "/run")
TRUSTED_UID = 0

# Run by the agent's interpreter: argv = agent.py. Imports what agent.py imports at module level (loaded before :8080
# opens, so they survive the drop without a pin), then every claude_agent_sdk module (sdk_runner imports the SDK lazily,
# and the SDK imports its transport and query modules lazily in turn) under an `open` audit hook. Prints a JSON object:
# {"files": the new modules' files and the files opened, "cli": the bundled CLI path or null}.
SDK_PROBE = r"""
import ast, importlib, importlib.util, json, os, pkgutil, sys
agent = sys.argv[1]
sys.path.insert(0, os.path.dirname(os.path.realpath(agent)))
for node in ast.parse(open(agent).read()).body:
    if isinstance(node, ast.Import):
        names = [a.name for a in node.names]
    elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
        names = [node.module]
    else:
        names = []
    for name in names:
        try:
            importlib.import_module(name)
        except Exception:
            pass
before = set(sys.modules)
opened = []
def hook(event, args):  # reads only: the import system's own bytecode writes are no file of the image
    if event == "open" and len(args) > 2 and isinstance(args[0], str) and isinstance(args[2], int) and args[2] & os.O_ACCMODE == os.O_RDONLY:
        opened.append(args[0])
sys.addaudithook(hook)
def walk(path, prefix):
    for info in pkgutil.iter_modules(path, prefix):
        if info.name.rsplit(".", 1)[-1] == "testing":  # test helpers: skipped before import, not walked into
            continue
        try:
            module = importlib.import_module(info.name)
        except Exception:
            continue
        if info.ispkg:
            walk(getattr(module, "__path__", []), info.name + ".")
import claude_agent_sdk
walk(claude_agent_sdk.__path__, "claude_agent_sdk.")
files = []
for name in set(sys.modules) - before:
    path = getattr(sys.modules[name], "__file__", None)
    if path:
        cached = importlib.util.cache_from_source(path) if path.endswith(".py") else None
        files.append(cached if cached and os.path.exists(cached) else path)
cli = None
try:
    from claude_agent_sdk._internal.transport.subprocess_cli import SubprocessCLITransport
    cli = SubprocessCLITransport._find_bundled_cli(None)  # the SDK's own lookup; it reads no instance state
except Exception:
    pass
if not cli:
    candidate = os.path.join(os.path.dirname(claude_agent_sdk.__file__), "_bundled", "claude")
    cli = candidate if os.path.isfile(candidate) else None
print(json.dumps({"files": sorted(files) + opened, "cli": cli}))
"""

# Run by the target interpreter: argv = script, warm-up snippets... Prints a JSON list of file paths.
PY_PROBE = r"""
import importlib.util, json, modulefinder, os, sys
opened = []
def hook(event, args):
    if event == "open" and args and isinstance(args[0], str):
        opened.append(args[0])
script, warmups = sys.argv[1], sys.argv[2:]
sys.path.insert(0, os.path.dirname(os.path.realpath(script)))
files = []
finder = modulefinder.ModuleFinder(path=sys.path)
try:
    finder.run_script(script)
except Exception:
    pass
for module in finder.modules.values():
    path = getattr(module, "__file__", None)
    if path and path != script:
        cached = importlib.util.cache_from_source(path) if path.endswith(".py") else None
        # With current bytecode the import system reads only the .pyc (it stats the source); else the source.
        files.append(cached if cached and os.path.exists(cached) else path)
sys.addaudithook(hook)
for code in warmups:
    try:
        exec(code, {})
    except Exception:
        pass
print(json.dumps(files + opened))
"""


def which(program: str) -> str | None:
    return program if program.startswith("/") and os.path.exists(program) else shutil.which(program, path=SEARCH_PATH)


def shebang(path: str) -> list[str]:
    try:
        with open(path, "rb") as f:
            first = f.readline(256)
    except OSError:
        return []
    if not first.startswith(b"#!"):
        return []
    words = first[2:].decode(errors="replace").split()
    if words and os.path.basename(words[0]) == "env":
        words = words[1:]
    return words[:1]


def is_elf(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def ldd(path: str) -> list[str]:
    try:
        out = subprocess.run(["ldd", path], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return re.findall(r"(?:=>\s*)?(/\S+)\s+\(0x", out)


def python_files(interpreter: str, script: str) -> list[str]:
    name = os.path.basename(interpreter)
    try:
        r = subprocess.run([interpreter, *PROBE_FLAGS, "-c", PY_PROBE, script, *WARMUPS.get(name, [])], capture_output=True, text=True, timeout=300,
                           env={"PATH": SEARCH_PATH, "HOME": "/root"})
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else []
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return []


def sdk_files(agent: str = AGENT, interpreter: str = AGENT_INTERPRETER) -> tuple[list[str], str | None]:
    """The agent's first-turn files (SDK modules, data files they open) and the CLI binary; empty when the SDK is absent."""
    path = which(interpreter)
    if not path or not os.path.isfile(agent):
        print(f"pin_manifest: no agent at {agent} or no {interpreter}; the first turn is not probed", file=sys.stderr)
        return [], None
    try:
        r = subprocess.run([path, *PROBE_FLAGS, "-c", SDK_PROBE, agent], capture_output=True, text=True, timeout=300,
                           env={"PATH": SEARCH_PATH, "HOME": "/root"})
        out = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else {}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        out = {}
    if not isinstance(out, dict) or not out.get("cli"):
        print("pin_manifest: the Agent SDK or its bundled CLI was not found; the first turn is not fully probed", file=sys.stderr)
    files = out.get("files") if isinstance(out, dict) and isinstance(out.get("files"), list) else []
    cli = out.get("cli") if isinstance(out, dict) and isinstance(out.get("cli"), str) else None
    return [p for p in files if isinstance(p, str)], cli


def with_libraries(paths: list[str]) -> list[str]:
    """`paths` followed by the shared libraries of every ELF among them."""
    out = list(paths)
    for elf in [p for p in paths if is_elf(p)]:
        out += ldd(elf)
    return out


def trusted(path: str, uid: int = TRUSTED_UID, untrusted: tuple[str, ...] = UNTRUSTED, top: str = "/") -> bool:
    """A resolved regular file outside `untrusted`, owned by `uid` with no group/other write bit, as is every ancestor
    directory up to `top`: nobody else can change what the root pinner reads (tests pass their own uid and top)."""
    if not os.path.isabs(path) or os.path.realpath(path) != path or any(path == p or path.startswith(p.rstrip("/") + "/") for p in untrusted):
        return False
    node = path
    while True:
        try:
            st = os.lstat(node)
        except OSError:
            return False
        if st.st_uid != uid or st.st_mode & 0o022 or (node == path and not stat.S_ISREG(st.st_mode)):
            return False
        if node == top or node == "/":
            return True
        node = os.path.dirname(node)


def collect(programs: list[str], files: list[str]) -> list[str]:
    ordered: list[str] = []
    for program in programs:
        path = which(program)
        if not path:
            print(f"pin_manifest: {program} not found", file=sys.stderr)
            continue
        interpreter = shebang(path)
        interpreter_path = which(interpreter[0]) if interpreter else None
        ordered.append(path)
        if interpreter_path:
            ordered.append(interpreter_path)
            if os.path.basename(interpreter_path).startswith("python"):
                ordered += python_files(interpreter_path, path)
    ordered += files
    return dedupe(with_libraries(ordered))


def dedupe(paths: list[str]) -> list[str]:
    seen: set[tuple[int, int]] = set()
    out: list[str] = []
    for path in paths:
        real = os.path.realpath(path)
        try:
            st = os.stat(real)
        except OSError:
            continue
        if not os.path.isfile(real) or st.st_size == 0 or (st.st_dev, st.st_ino) in seen:
            continue
        seen.add((st.st_dev, st.st_ino))
        out.append(real)
    return out


def first_turn(agent: str = AGENT, interpreter: str = AGENT_INTERPRETER) -> list[str]:
    """The agent's first-turn files: SDK modules and their libraries first, the (large) CLI binary last."""
    files, cli = sdk_files(agent, interpreter)
    return [*with_libraries([*files, *AGENT_FILES]), *([cli] if cli else []), *(ldd(cli) if cli else [])]


def main(argv: list[str]) -> None:
    mount = collect(PROGRAMS, FILES)
    listed = dedupe(mount + first_turn())  # first occurrence wins: the mount set keeps its place ahead of the first turn
    paths = [p for p in listed if trusted(p)]
    for path in sorted(set(listed) - set(paths)):
        print(f"pin_manifest: WARNING {path} is not root-owned and read-only to others along its path; not listed", file=sys.stderr)
    total = sum(os.path.getsize(p) for p in paths)
    with open(argv[1], "w") as f:
        f.write("".join(p + "\n" for p in paths))
    mount_set = set(mount)
    print(json.dumps({"component": "pin_manifest", "files": len(paths), "bytes": total,
                      "mount_files": sum(p in mount_set for p in paths), "mount_bytes": sum(os.path.getsize(p) for p in paths if p in mount_set),
                      "skipped": len(listed) - len(paths)}))
    cap = cap_from_env()
    if total > cap:
        print(f"pin_manifest: WARNING {total} bytes exceed the pinner's {cap}; the last files will not be pinned", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
