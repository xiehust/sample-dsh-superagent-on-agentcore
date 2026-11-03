"""Opt-in local check of L8 (no AWS): a new microVM resumes a Codex thread while the old VM's writer lock is still held.

On S3 Files a stopped VM's file lock outlives it by its NFS lease, so `thread-writer-locks/` must not be shared. This drives the
real codex binary (0.166.0) twice over one rollout tree: "shared" (CODEX_HOME on the AP, the pre-fix layout) must fail with
"already has an active writer"; "split" (`codex_runner.prepare_home(..., sessions_dir=)`: local CODEX_HOME, sessions on the AP)
must resume. VM A keeps running (its lock held, as a dead VM's lease is) while VM B resumes; KILL=1 kills A with SIGKILL first.

Usage (from worker/): CODEX_BIN=<codex binary> ROLLOUT=<an existing rollout-*.jsonl> uv run python tests/live/codex_resume_lock.py
"""
import asyncio
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "..", "container"), os.path.join(HERE, "..", "..", "..", "packages", "contracts", "python")]
import codex_runner  # noqa: E402


async def resume(root: str, ap: str, name: str, layout: str, thread_id: str, binary: str):
    home = ap if layout == "shared" else os.path.join(root, name, ".codex")
    codex_runner.prepare_home(home, {}, region="ap-northeast-1", local=os.path.join(root, name, "local"), user_skills=os.path.join(root, "u"),
                              sessions_dir=None if layout == "shared" else os.path.join(ap, "sessions"))
    env = {k: v for k, v in os.environ.items() if not k.startswith("AWS_")} | {"CODEX_HOME": home, "HOME": root, "RUST_LOG": "error"}

    async def on_request(method, _params):
        raise codex_runner.JsonRpcError(-32601, method)
    server = codex_runner.AppServer([binary, "app-server", *codex_runner.config_overrides()], env, os.path.join(root, "repo"), on_request)
    await server.start("lock-check")
    try:
        result = await server.request("thread/resume", {"threadId": thread_id, "excludeTurns": True, "cwd": os.path.join(root, "repo"),
                                                        "approvalPolicy": "never", "sandbox": "danger-full-access"}, timeout=30)
        return server, result["thread"]["id"] == thread_id, None
    except codex_runner.JsonRpcError as error:
        return server, False, str(error)[:200]


async def check(layout: str, binary: str, rollout: str) -> dict:
    root = tempfile.mkdtemp(prefix=f"dshsa-lock-{layout}-", dir=os.path.expanduser("~/.cache"))  # never /tmp: codex refuses helpers there
    try:
        ap = os.path.join(root, "ap", ".codex")
        os.makedirs(os.path.join(ap, "sessions", "2026", "11", "03"))
        os.makedirs(os.path.join(root, "repo"))
        shutil.copy(rollout, os.path.join(ap, "sessions", "2026", "11", "03"))
        thread_id = json.loads(open(rollout).readline())["payload"]["id"]
        a, a_ok, _ = await resume(root, ap, "vmA", layout, thread_id, binary)
        if os.environ.get("KILL") == "1":
            a.proc.kill()
        b, b_ok, b_error = await resume(root, ap, "vmB", layout, thread_id, binary)
        await a.close()
        await b.close()
        return {"layout": layout, "a": a_ok, "b": b_ok, "b_error": b_error, "ap": sorted(os.listdir(ap))}
    finally:
        shutil.rmtree(root, ignore_errors=True)


async def main() -> int:
    binary, rollout = os.environ.get("CODEX_BIN"), os.environ.get("ROLLOUT")
    if not binary or not rollout:
        sys.exit("set CODEX_BIN and ROLLOUT")
    shared, split = await check("shared", binary, rollout), await check("split", binary, rollout)
    print(json.dumps({"shared": shared, "split": split}, indent=1))
    ok = split["a"] and split["b"] and split["ap"] == ["sessions"] and (os.environ.get("KILL") == "1" or "active writer" in (shared["b_error"] or ""))
    print("OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
