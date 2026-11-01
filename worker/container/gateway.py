"""Root gateway process: :8080 (AgentCore contract: /ping, /invocations) and 127.0.0.1:8090 (CP proxy for the agent).

Mount handling and credential rotation are the reference's (agentcore-s3files-per-user-isolation/container/gateway.py, MIT),
with the broker called with the ticket token. MOUNT_MODE=local skips the broker and the mount (local smoke tests only).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
import traceback
from datetime import UTC, datetime

import aiohttp
import boto3
from aiohttp import web
from gateway_core import Gateway, log
from inbox import Store
from pinner import MANIFEST, Pinner

from dshsa_worker.ticket_token import KmsPublicKeys, TicketTokenVerifier

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
WORK = os.environ.get("WORK_DIR", "/mnt/work")
AGENT_URL = "http://127.0.0.1:8081"
PROFILE = "ticket-mount"
CREDENTIALS_FILE = "/root/.aws/credentials"
REFRESH_BUFFER_S = int(os.environ.get("REFRESH_BUFFER_SECONDS", "900"))
WORKER_API_URL = os.environ.get("WORKER_API_URL", "").rstrip("/")
WORKER_API_HOST_HEADER = os.environ.get("WORKER_API_HOST_HEADER", "")
WORKER_API_SIGV4 = os.environ.get("WORKER_API_SIGV4", "") == "1"
MOUNT_MODE = os.environ.get("MOUNT_MODE", "s3files")
SESSION_HEADER = "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade", "host", "authorization",
               "content-length"}


_SESSION = boto3.Session()  # one credential provider (execution role via MMDS), refreshed by botocore, not re-resolved per call
INVOCATION_TIMEOUT_S = 25  # answer well within AgentCore's request timeout, whatever the agent does


def sigv4(method: str, url: str, data: bytes, headers: dict) -> dict:
    """Sign a worker-api request as the runtime execution role (the private API requires AWS_IAM). Blocking: call in a thread."""
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    credentials = _SESSION.get_credentials()
    if credentials is None:
        raise RuntimeError("no execution-role credentials available")
    credentials = credentials.get_frozen_credentials()
    request = AWSRequest(method=method, url=url, data=data, headers=headers)
    SigV4Auth(credentials, "execute-api", REGION).add_auth(request)
    return dict(request.headers.items())


class S3FilesMounter:
    """Broker → root-only profile → `mount -t s3files` the ticket's AP at /mnt/work; rotate before the creds expire."""

    def __init__(self, pinner: Pinner | None = None) -> None:
        self.pinner = pinner  # holds the first mount's files in memory across the V2 snapshot; released after that mount
        self.lambda_client = boto3.client("lambda", region_name=REGION)
        self.function = os.environ.get("BROKER_FUNCTION", "dshsa-broker")
        self.latest_token: str | None = None
        self.expiration: datetime | None = None
        self.last_error: str | None = None
        self.target: dict | None = None
        self.wake = asyncio.Event()
        self.rotations = 0

    def mounted(self) -> bool:
        return MOUNT_MODE == "local" and self.target is not None or os.path.ismount(WORK)

    def note_token(self, token: str) -> None:
        self.latest_token = token
        if self.last_error and self.target:
            self.wake.set()

    def _call_broker(self, token: str) -> dict:
        resp = self.lambda_client.invoke(FunctionName=self.function, Payload=json.dumps({"token": token}).encode())
        result = json.loads(resp["Payload"].read())
        if "error" in result or "credentials" not in result:
            raise RuntimeError(f"broker refused: {result.get('error', result)}")
        return result

    def _write_profile(self, creds: dict) -> None:
        os.makedirs(os.path.dirname(CREDENTIALS_FILE), mode=0o700, exist_ok=True)
        tmp = CREDENTIALS_FILE + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(f"[{PROFILE}]\naws_access_key_id = {creds['AccessKeyId']}\naws_secret_access_key = {creds['SecretAccessKey']}\n"
                    f"aws_session_token = {creds['SessionToken']}\n")
        os.replace(tmp, CREDENTIALS_FILE)

    async def _mint(self, token: str) -> dict:
        result = await asyncio.get_running_loop().run_in_executor(None, self._call_broker, token)
        creds = result.pop("credentials")
        self._write_profile(creds)
        self.expiration = datetime.fromisoformat(creds["Expiration"])
        return result

    def _mount(self, fs_id: str, ap_id: str) -> None:
        os.makedirs(WORK, exist_ok=True)
        if os.path.ismount(WORK):
            return
        cmd = ["mount", "-t", "s3files", "-o", f"accesspoint={ap_id},awsprofile={PROFILE},nodirects3read", f"{fs_id}:/", WORK]
        r = None
        for attempt in range(1, 7):
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env={**os.environ, "HOME": "/root"})
            if r.returncode == 0 and os.path.ismount(WORK):
                return
            log("mount_retry", attempt=attempt, stderr=r.stderr.strip()[-500:])
            time.sleep(2 * attempt)
        raise RuntimeError(f"mount failed: {(r.stderr if r else '').strip()[-300:]}")

    async def ensure(self, token: str) -> dict:
        self.latest_token = token
        if MOUNT_MODE == "local":
            self.target = {"ticketKey": None}
            return self.target
        t0 = time.monotonic()
        try:
            target = await self._mint(token)
            t1 = time.monotonic()
            await asyncio.get_running_loop().run_in_executor(None, self._mount, target["fileSystemId"], target["accessPointId"])
        finally:
            self.release_pin()
        self.target = target
        log("mounted", ticketKey=target["ticketKey"], accessPointId=target["accessPointId"], mint_ms=int((t1 - t0) * 1000),
            mount_ms=int((time.monotonic() - t1) * 1000))
        asyncio.get_running_loop().create_task(self._refresh_loop())
        return target

    def release_pin(self) -> None:
        """After the first mount, success or not: the pages it needed are read, the pins would only hold memory."""
        pinner, self.pinner = self.pinner, None
        if pinner:
            pinner.release()
            log("pin_released")

    def _seconds_until_refresh(self) -> float:
        remaining = (self.expiration - datetime.now(UTC)).total_seconds() if self.expiration else 0
        return max(0.0, remaining - min(REFRESH_BUFFER_S, remaining / 4))

    async def _refresh_loop(self) -> None:
        delay = self._seconds_until_refresh()
        while True:
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=delay)
            except TimeoutError:
                pass
            self.wake.clear()
            try:
                await self._mint(self.latest_token or "")
                self.rotations += 1
                self.last_error = None
                log("rotated", rotations=self.rotations, expiration=self.expiration.isoformat() if self.expiration else None)
                delay = self._seconds_until_refresh()
            except Exception as error:  # noqa: BLE001 - keep serving; the mount survives until its TLS cert expires
                self.last_error = str(error)
                log("rotate_failed", error=str(error)[:300])
                delay = 60


class HttpAgent:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self.session = session

    async def wait_healthy(self, timeout_s: float = 90) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                async with self.session.get(f"{AGENT_URL}/ping", timeout=aiohttp.ClientTimeout(total=2)) as r:
                    if r.status == 200:
                        return
            except aiohttp.ClientError:
                pass
            await asyncio.sleep(0.2)
        raise RuntimeError("agent process not healthy")

    async def call(self, path: str, body: dict | None = None) -> dict:
        if body is None and path in ("/status",):
            async with self.session.get(f"{AGENT_URL}{path}", timeout=aiohttp.ClientTimeout(total=5)) as r:
                return await r.json()
        async with self.session.post(f"{AGENT_URL}{path}", json=body or {}, timeout=aiohttp.ClientTimeout(total=900)) as r:
            return await r.json()


def verifier() -> TicketTokenVerifier:
    pem = os.environ.get("TICKET_PUBLIC_KEY_PEM")
    if pem and MOUNT_MODE == "local":  # local smoke tests only: a test key instead of KMS
        from cryptography.hazmat.primitives import serialization
        key = serialization.load_pem_public_key(pem.encode())
        return TicketTokenVerifier(lambda _kid: key)  # type: ignore[arg-type,return-value]
    return TicketTokenVerifier(KmsPublicKeys(boto3.client("kms", region_name=REGION), os.environ["TICKET_KEY_ID"]))


def build_app(pinner: Pinner | None = None) -> web.Application:
    state: dict = {}

    async def on_startup(app: web.Application) -> None:
        session = aiohttp.ClientSession()
        agent = HttpAgent(session)
        owner = int(os.environ.get("AGENT_UID", "1000")) if MOUNT_MODE == "local" and os.getuid() == 0 else None
        gw = Gateway(verifier=verifier(), mounter=S3FilesMounter(pinner), agent=agent, store=Store(WORK, owner=owner))
        state.update(session=session, agent=agent, gw=gw)
        log("gateway_started", workerVersion=gw.version)

        async def refresh(token: str) -> str | None:
            status, body = await proxy_call("POST", "/v1/token/refresh", b"{}", {"Content-Type": "application/json"})
            return json.loads(body).get("token") if status == 200 else None

        async def proxy_call(method: str, path: str, data: bytes, headers: dict) -> tuple[int, bytes]:
            if not WORKER_API_URL or not gw.token:
                return 503, json.dumps({"ok": False, "error": "cell_unavailable", "message": "no control-plane token yet"}).encode()
            # The agent never sets identity headers: SigV4, the ticket token and the API id are the gateway's alone.
            out = {k: v for k, v in headers.items() if k.lower() not in HOP_HEADERS and not k.lower().startswith(("x-amz", "x-dshsa-", "x-apigw-"))}
            if WORKER_API_HOST_HEADER:
                out["x-apigw-api-id"] = WORKER_API_HOST_HEADER
            url = f"{WORKER_API_URL}{path}"
            if WORKER_API_SIGV4:
                out = await asyncio.to_thread(sigv4, method, url, data, out)
            # The ticket token rides in its own header so SigV4 can own Authorization; worker-api accepts either.
            out["X-Dshsa-Ticket-Token" if WORKER_API_SIGV4 else "Authorization"] = gw.token if WORKER_API_SIGV4 else f"Bearer {gw.token}"
            async with session.request(method, url, data=data, headers=out, timeout=aiohttp.ClientTimeout(total=60)) as r:
                return r.status, await r.read()

        state["proxy_call"] = proxy_call
        app["refresh_task"] = asyncio.get_running_loop().create_task(gw.refresh_loop(refresh))
        proxy = web.Application(client_max_size=1024 * 1024)

        async def forward(request: web.Request) -> web.Response:
            try:
                status, body = await proxy_call(request.method, "/" + request.match_info["tail"], await request.read(), dict(request.headers))
            except Exception as error:  # noqa: BLE001 - the agent retries; say why
                log("proxy_failed", path=request.match_info["tail"], error=f"{type(error).__name__}: {str(error)[:300]}")
                status, body = 503, json.dumps({"ok": False, "error": "cell_unavailable", "message": "control-plane proxy failed"}).encode()
            return web.Response(status=status, body=body, content_type="application/json")

        proxy.router.add_route("*", "/cp/{tail:.*}", forward)
        runner = web.AppRunner(proxy, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 8090).start()
        app["proxy_runner"] = runner
        app["lag_task"] = asyncio.get_running_loop().create_task(watch_loop_lag())

    ping_state = {"status": "Healthy", "since": int(time.time())}

    async def ping(_request: web.Request) -> web.Response:
        gw = state.get("gw")
        status = "HealthyBusy" if gw and await gw.busy() else "Healthy"
        if status != ping_state["status"]:  # time_of_last_update moves only on a change, or the idle timeout never fires
            ping_state.update(status=status, since=int(time.time()))
        return web.json_response({"status": status, "time_of_last_update": ping_state["since"]})

    async def invocations(request: web.Request) -> web.Response:
        try:
            payload = json.loads(await request.read() or b"{}")
        except json.JSONDecodeError:
            return web.json_response(state["gw"].versioned({"ok": False, "error": "bad_request", "message": "invalid JSON body"}))
        if not isinstance(payload, dict):
            return web.json_response(state["gw"].versioned({"ok": False, "error": "bad_request", "message": "body must be an object"}))
        gw: Gateway = state["gw"]
        started = time.monotonic()
        try:
            if not state.get("agent_up"):
                await state["agent"].wait_healthy(timeout_s=15)
                state["agent_up"] = True
            result = await asyncio.wait_for(gw.handle(payload, request.headers.get(SESSION_HEADER)), INVOCATION_TIMEOUT_S)
        except TimeoutError:
            result = {"ok": False, "error": "internal", "message": f"invocation did not finish within {INVOCATION_TIMEOUT_S}s"}
        except Exception as error:  # noqa: BLE001 - e.g. the agent process restarting; any 5xx would become a bodiless 424
            if isinstance(error, aiohttp.ClientError):
                state["agent_up"] = False  # wait for the restarted agent on the next invocation
            log("invocation_failed", action=payload.get("action"), error=f"{type(error).__name__}: {str(error)[:300]}",
                trace=traceback.format_exc()[-2000:])
            result = {"ok": False, "error": "internal", "message": f"{type(error).__name__}: {str(error)[:300]}"}
        log("invocation", action=payload.get("action"), ok=result.get("ok"), error=result.get("error"), ms=int((time.monotonic() - started) * 1000))
        # Always HTTP 200: AgentCore turns any other status into 424 and drops the body (reference README).
        return web.json_response(gw.versioned(result))

    async def on_shutdown(_app: web.Application) -> None:
        # SIGTERM (session stop / VM recycle): checkpoint the agent's local working copy to the AP (contract v5 §4.10), then
        # flush the NFS client's dirty pages; both bounded so the shutdown still ends.
        gw, agent = state.get("gw"), state.get("agent")
        if gw and gw.bound_sub and agent:
            try:
                result = await asyncio.wait_for(agent.call("/checkpoint", {}), 25)
                log("checkpoint_on_shutdown", **{k: v for k, v in result.items() if k in ("skipped", "error", "bundle_ms", "bytes")})
            except Exception as error:  # noqa: BLE001
                log("checkpoint_on_shutdown_failed", error=f"{type(error).__name__}: {str(error)[:200]}")
        try:
            await asyncio.wait_for(asyncio.to_thread(os.sync), 10)
            log("synced_on_shutdown")
        except TimeoutError:
            log("sync_on_shutdown_timeout")

    app = web.Application(client_max_size=10 * 1024 * 1024)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.router.add_get("/ping", ping)
    app.router.add_post("/invocations", invocations)
    return app


async def watch_loop_lag(every_s: float = 1.0, warn_s: float = 2.0) -> None:
    """Diagnostics: log when something blocks the event loop (it would stall /ping and /invocations)."""
    while True:
        before = time.monotonic()
        await asyncio.sleep(every_s)
        lag = time.monotonic() - before - every_s
        if lag > warn_s:
            log("loop_lag", seconds=round(lag, 1))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    assert os.getuid() == 0 or MOUNT_MODE == "local", "gateway must run as root (mount + credential file)"
    # V2 snapshots once /ping answers, after dropping the page cache: pin the first mount's files before the port opens.
    pinner = Pinner.start(os.environ.get("PIN_MANIFEST", MANIFEST), log) if MOUNT_MODE != "local" else None
    web.run_app(build_app(pinner), host="0.0.0.0", port=8080, access_log=None)  # noqa: S104 - AgentCore contract port


if __name__ == "__main__":
    main()
