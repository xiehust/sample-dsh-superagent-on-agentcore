"""Non-root agent process. Started as root by entrypoint.sh, it drops to AGENT_UID (the uid every ticket access point enforces)
and sets no_new_privs before importing anything else (as agentcore-s3files-per-user-isolation/container/agent_app.py, MIT).

Only the gateway reaches its control server (127.0.0.1:8081): /ping, /status, POST /run, /nudge, /stop.
"""
import ctypes
import os
import sys

AGENT_UID = int(os.environ.get("AGENT_UID", "1000"))
PR_SET_NO_NEW_PRIVS = 38


def drop_privileges() -> None:
    if os.getuid() == 0:
        os.setgroups([])
        os.setresgid(AGENT_UID, AGENT_UID, AGENT_UID)
        os.setresuid(AGENT_UID, AGENT_UID, AGENT_UID)
    if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        sys.exit("[agent] prctl(NO_NEW_PRIVS) failed")
    if os.getuid() == 0 or os.geteuid() == 0:
        sys.exit("[agent] refusing to run as root")
    os.environ["HOME"] = "/home/agent"
    os.chdir("/home/agent")


if __name__ == "__main__":
    drop_privileges()

import asyncio  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import subprocess  # noqa: E402

import agent_core  # noqa: E402
import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from inbox import Store  # noqa: E402
from repo import Repo  # noqa: E402

WORK = os.environ.get("WORK_DIR", "/mnt/work")
# Contract v5 §4.10: the working copy is on LOCAL disk; the AP keeps .claude/, .dshsa/, out/ and repo.bundle.
REPO = os.environ.get("LOCAL_REPO_DIR", "/home/agent/work/repo")
BUNDLE = os.path.join(WORK, "repo.bundle")
CONFIG_DIR = os.path.join(WORK, ".claude")
PROXY = os.environ.get("CP_PROXY", "http://127.0.0.1:8090/cp")


def log(event: str, **fields) -> None:
    print(json.dumps({"component": "agent", "event": event, **fields}), flush=True)


def prepare_repo(repo: dict) -> dict:
    """Local working copy: present, resumed from repo.bundle on a fresh VM, or a first partial clone (contract v5 §4.10)."""
    subprocess.run(["git", "config", "--global", "credential.helper", "/app/git-credential-dshsa"], check=True)
    result = Repo(REPO, BUNDLE).prepare(repo)
    log("repo_prepared", **result)
    return result


def checkpoint_repo() -> dict:
    """Snapshot uncommitted work to refs/dshsa/wip and write repo.bundle to the AP (atomic, fsync'd, then sync())."""
    try:
        result = Repo(REPO, BUNDLE).checkpoint()
    except Exception as error:  # noqa: BLE001 - a failed checkpoint must not fail the turn; report it
        result = {"error": str(error)[-500:]}
    log("repo_checkpoint", **{k: v for k, v in result.items() if k in ("skipped", "error", "snapshot_ms", "bundle_ms", "bytes", "branch")})
    return result


async def main() -> None:
    store = Store(WORK)
    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60))

    async def post(path: str, body: dict) -> tuple[int, dict]:
        async with session.post(f"{PROXY}{path}", json=body) as resp:
            try:
                data = await resp.json(content_type=None)
            except Exception:  # noqa: BLE001
                data = {"raw": (await resp.text())[:500]}
            return resp.status, data if isinstance(data, dict) else {"value": data}

    cfg = store.config()
    cp = agent_core.ControlPlane(post, cfg.get("ticketKey", ""), lambda: worker.assignment_id)
    worker = agent_core.Worker(store, cp, agent_core.sdk_runner, repo_dir=REPO, config_dir=CONFIG_DIR,
                               checkpoint=lambda: asyncio.to_thread(checkpoint_repo))

    async def ping(_r: web.Request) -> web.Response:
        return web.json_response({"status": "ok"})

    async def status(_r: web.Request) -> web.Response:
        return web.json_response({"state": "stopped" if worker.stopped else worker.status})

    async def run(request: web.Request) -> web.Response:
        """Returns at once: the repository is prepared by the worker task before its first turn (a clone can take minutes)."""
        body = await request.json()
        current = await asyncio.to_thread(store.config)
        cp.ticket_key = current.get("ticketKey", "")
        config = current.get("config") or {}

        async def prepare() -> bool:
            try:
                await asyncio.to_thread(agent_core.write_skills, CONFIG_DIR, config.get("skills", []))
                await asyncio.to_thread(prepare_repo, config.get("repo", {}))
                return True
            except Exception as error:  # noqa: BLE001
                log("repo_prepare_failed", error=str(error)[-500:])
                await cp.event("report", {"state": "failed", "text": f"Preparing the repository failed: {str(error)[-800:]}"})
                await cp.event("turn.ended", {"reason": "error:repo_prepare_failed"})
                worker.status = "idle"
                return False
        worker.prepare = prepare
        worker.run(body["assignmentId"], bool(body.get("recovery")))
        return web.json_response({"ok": True})

    async def nudge(_r: web.Request) -> web.Response:
        current = await asyncio.to_thread(store.config)
        await asyncio.to_thread(agent_core.write_skills, CONFIG_DIR, (current.get("config") or {}).get("skills", []))
        if not worker.assignment_id:
            # A restarted agent process has no assignment: the gateway answers this with /run (inbox and state survive).
            return web.json_response({"ok": False, "error": "no_assignment", "state": worker.status})
        worker.nudge()
        return web.json_response({"ok": True, "state": worker.status})

    async def checkpoint(_r: web.Request) -> web.Response:
        """The gateway's SIGTERM path: checkpoint the working copy before the VM goes."""
        return web.json_response(await asyncio.to_thread(checkpoint_repo))

    async def stop(_r: web.Request) -> web.Response:
        await worker.stop()
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_get("/ping", ping)
    app.router.add_get("/status", status)
    app.router.add_post("/run", run)
    app.router.add_post("/nudge", nudge)
    app.router.add_post("/stop", stop)
    app.router.add_post("/checkpoint", checkpoint)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 8081).start()
    log("listening", uid=os.getuid())
    await asyncio.Event().wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    asyncio.run(main())
