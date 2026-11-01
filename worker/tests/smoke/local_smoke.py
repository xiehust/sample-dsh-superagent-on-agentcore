"""Local smoke test of the worker image (no AWS except Bedrock): two fresh containers share one work volume.

  1. container A: start → the agent writes a file and reports ready through the CP proxy → fake worker-api records events
  2. container A is removed (a lost microVM); container B: deliver → resume the same SDK session, recall the earlier work

The fake worker-api listens only on the docker bridge address. Usage (from worker/):
  uv run python tests/smoke/local_smoke.py [--image dshsa-worker:dev]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

import aiohttp
from aiohttp import web
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = os.path.dirname(__file__)
sys.path[:0] = [os.path.join(HERE, "..", "..", "src"), os.path.join(HERE, "..", "..", "..", "packages", "contracts", "python")]
import dshsa_contracts as contracts  # noqa: E402

from dshsa_worker.ticket_token import claims_for, sign  # noqa: E402

CELL, TICKET, ASG = "acme--gh812345", "smoke-ticket-1", "assignment-0"
_BRIDGE_CMD = "ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1"
BRIDGE = subprocess.run(["sh", "-c", _BRIDGE_CMD], capture_output=True, text=True).stdout.strip() or "172.17.0.1"
CP_PORT = 19099


def docker(*args: str, check: bool = True) -> str:
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True).stdout.strip()


def request(token: str, action: str, inputs: list[dict]) -> dict:
    return {"v": 1, "action": action, "token": token, "inputs": inputs,
            "ticket": {"tenantId": "acme", "cellId": CELL, "ticketId": TICKET, "assignmentId": ASG, "title": "smoke", "scope": "smoke test", "mandate": {}},
            "config": {"model": os.environ.get("MODEL", "global.anthropic.claude-sonnet-5-5"), "skills": [], "env": {},
                       "systemPrompt": "You are a dshsa worker in a smoke test. Always finish by calling the dshsa report tool.",
                       "repo": {"fullName": "octocat/Hello-World", "defaultBranch": "master", "cloneUrl": "https://github.com/octocat/Hello-World.git"}}}


async def main(image: str) -> int:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    events: list[dict] = []

    async def cp(request_: web.Request) -> web.Response:
        body = await request_.json() if request_.can_read_body else {}
        auth = request_.headers.get("Authorization", "")
        path = request_.path
        events.append({"path": path, "auth": auth.startswith("Bearer ey"), "body": body})
        if path.endswith("/credentials/github"):
            return web.json_response({"token": "ghs_fake_for_public_clone", "expiresAt": "2099-01-01T00:00:00Z"})
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", cp)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, BRIDGE, CP_PORT).start()

    vol = tempfile.mkdtemp(prefix="dshsa-smoke-")
    os.chmod(vol, 0o777)
    creds = json.loads(subprocess.run(["aws", "configure", "export-credentials", "--format", "process"], check=True, capture_output=True, text=True).stdout)
    env = {"MOUNT_MODE": "local", "TICKET_PUBLIC_KEY_PEM": pem, "WORKER_API_URL": f"http://{BRIDGE}:{CP_PORT}/v1", "AWS_REGION": "us-west-2",
           "AWS_ACCESS_KEY_ID": creds["AccessKeyId"], "AWS_SECRET_ACCESS_KEY": creds["SecretAccessKey"], "AWS_SESSION_TOKEN": creds.get("SessionToken", "")}
    token = sign(claims_for(CELL, TICKET, ASG), key, "smoke-kid")
    rsid = contracts.runtime_session_id(CELL, TICKET)
    ok = True

    async def run_container(name: str, port: int) -> None:
        docker("rm", "-f", name, check=False)
        args = ["run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:8080", "-v", f"{vol}:/mnt/work"]
        for k, v in env.items():
            args += ["-e", f"{k}={v}"]
        docker(*args, image)
        async with aiohttp.ClientSession() as s:
            for _ in range(120):
                try:
                    async with s.get(f"http://127.0.0.1:{port}/ping") as r:
                        if r.status == 200:
                            return
                except aiohttp.ClientError:
                    pass
                await asyncio.sleep(0.5)
        raise RuntimeError(f"{name} never became healthy")

    async def invoke(port: int, body: dict) -> dict:
        async with aiohttp.ClientSession() as s:
            async with s.post(f"http://127.0.0.1:{port}/invocations", json=body,
                              headers={"X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": rsid}) as r:
                return await r.json()

    async def until_idle(port: int, timeout: float = 300) -> float:
        start = time.time()
        await asyncio.sleep(3)
        async with aiohttp.ClientSession() as s:
            while time.time() - start < timeout:
                async with s.get(f"http://127.0.0.1:{port}/ping") as r:
                    if (await r.json())["status"] == "Healthy" and any(e["body"].get("type") == "turn.ended" for e in events[mark:]):
                        return time.time() - start
                await asyncio.sleep(2)
        raise RuntimeError("turn did not end")

    try:
        await run_container("dshsa-smoke-a", 18081)
        mark = 0
        first = [{"id": "assignment:" + ASG, "kind": "text", "at": "2026-11-01T00:00:00Z", "text": json.dumps({"ticket_id": TICKET, "title": "smoke"})},
                 {"id": "in-1", "kind": "text", "at": "2026-11-01T00:00:01Z",
                  "text": "Remember the codeword HERON-7. Create /mnt/work/out/hello.txt containing 'hi from A'. "
                          "Then call the dshsa report tool with state ready and a one-line summary."}]
        res = await invoke(18081, request(token, "start", first))
        print("start:", res)
        ok &= res.get("ok") is True and res.get("accepted") == ["assignment:" + ASG, "in-1"]
        ok &= docker("exec", "dshsa-smoke-a", "sh", "-c", "command -v runuser") != ""
        # The gateway must answer while a turn runs (AgentCore 504s otherwise): status + a mid-turn deliver, each < 3 s.
        t0 = time.time()
        busy = await invoke(18081, request(token, "status", []))
        mid = await invoke(18081, request(token, "deliver", [{"id": "in-mid", "kind": "text", "at": "2026-11-01T00:00:02Z",
                                                              "text": "Also keep the file content exactly as asked."}]))
        quick = time.time() - t0
        print(f"status/deliver during the turn: {busy} {mid} in {quick:.2f}s")
        ok &= busy.get("ok") is True and mid.get("ok") is True and quick < 6
        print(f"turn 1 idle after {await until_idle(18081):.1f}s")
        types = [e["body"].get("type") for e in events if e["path"].endswith("/events")]
        print("events:", types)
        ok &= "report" in types and "turn.ended" in types and all(e["auth"] for e in events)
        ok &= any(e["body"].get("type") == "report" and e["body"]["body"]["state"] == "ready" for e in events if e["path"].endswith("/events"))
        # v5: the working copy is local; the turn end wrote repo.bundle to the AP (the volume here).
        ok &= os.path.exists(os.path.join(vol, "out", "hello.txt")) and os.path.exists(os.path.join(vol, "repo.bundle"))
        print("bundle after turn 1:", os.path.getsize(os.path.join(vol, "repo.bundle")) if os.path.exists(os.path.join(vol, "repo.bundle")) else None)
        bad = await invoke(18081, request(sign(claims_for("acme--gh1", "other", "a"), key, "smoke-kid"), "deliver", []) | {
            "ticket": {**request(token, "deliver", [])["ticket"], "cellId": "acme--gh1", "ticketId": "other", "assignmentId": "a"}})
        print("other ticket on this VM:", bad)
        ok &= bad.get("error") in ("bound_to_other_ticket", "unauthorized")
        # A local edit after the last turn survives only through the gateway's SIGTERM checkpoint: docker stop sends SIGTERM.
        docker("exec", "-u", "agent", "dshsa-smoke-a", "sh", "-c", "echo smoke-late-edit >> /home/agent/work/repo/README")
        docker("stop", "-t", "30", "dshsa-smoke-a")
        print("gateway shutdown:", [line for line in docker("logs", "dshsa-smoke-a").splitlines() if "on_shutdown" in line][-2:])
        docker("rm", "-f", "dshsa-smoke-a")

        await run_container("dshsa-smoke-b", 18082)
        mark = len(events)
        res = await invoke(18082, request(token, "deliver", [{"id": "in-2", "kind": "text", "at": "2026-11-01T01:00:00Z",
                                                                "text": "New machine. What codeword did I give you, and what does out/hello.txt say? "
                                                                        "Report progress with the answer in the summary."}]))
        print("deliver on fresh VM:", res)
        print(f"turn 2 idle after {await until_idle(18082):.1f}s")
        reports = [e["body"]["body"] for e in events[mark:] if e["body"].get("type") == "report"]
        print("resume report:", reports)
        ok &= any("HERON-7" in r.get("text", "") for r in reports)
        restored = "tail -1 /home/agent/work/repo/README; git -C /home/agent/work/repo status --porcelain"
        readme = docker("exec", "-u", "agent", "dshsa-smoke-b", "sh", "-c", restored)
        print("restored work tree in the fresh container:", readme.splitlines())
        ok &= "smoke-late-edit" in readme
    finally:
        print(docker("logs", "--tail", "15", "dshsa-smoke-b", check=False)[-3000:])
        docker("rm", "-f", "dshsa-smoke-a", "dshsa-smoke-b", check=False)
        await runner.cleanup()
        subprocess.run(["docker", "run", "--rm", "-v", f"{vol}:/v", "--entrypoint", "rm", image, "-rf", "/v/.claude", "/v/.dshsa", "/v/repo.bundle", "/v/out"],
                       capture_output=True)
        shutil.rmtree(vol, ignore_errors=True)
    print("SMOKE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default="dshsa-worker:dev")
    sys.exit(asyncio.run(main(parser.parse_args().image)))
