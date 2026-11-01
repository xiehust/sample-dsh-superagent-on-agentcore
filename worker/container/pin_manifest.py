"""Build-time probe for pinner.py: list the files a first request reads, as one path per line, most urgent first.

Runs as the Dockerfile's last step, inside the finished image: interpreter versions and library paths differ between base
images, so a hand-written list would go stale. Sources:
  - the programs the first request starts (the mount helper, efs-proxy, mount.nfs; the agent's git/gh and helpers),
    following each script's shebang to its interpreter;
  - Python scripts: every module they can import (modulefinder, run by the script's own interpreter, so function-level lazy
    imports count), as the compiled bytecode the interpreter actually reads, plus the files a warm-up of the botocore
    code paths opens (an `open` audit hook: endpoint and model data that no import names);
  - `ldd` of every ELF found above (executables and extension modules);
  - configuration and CA files opened at run time.
Deduplicated by inode. The Claude CLI the SDK spawns is left out: it is larger than the pinner's whole budget.
Usage: python3.12 -E -s pin_manifest.py <output> (not -I: it implies -P, and this script imports pinner from its own directory)
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

from pinner import MAX_BYTES

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
    elves = [p for p in ordered if is_elf(p)]
    for elf in elves:
        ordered += ldd(elf)
    return dedupe(ordered)


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


def main(argv: list[str]) -> None:
    paths = collect(PROGRAMS, FILES)
    total = sum(os.path.getsize(p) for p in paths)
    with open(argv[1], "w") as f:
        f.write("".join(p + "\n" for p in paths))
    print(json.dumps({"component": "pin_manifest", "files": len(paths), "bytes": total}))
    if total > MAX_BYTES:
        print(f"pin_manifest: WARNING {total} bytes exceed the pinner's {MAX_BYTES}; the last files will not be pinned", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv)
