"""Root gateway logic (design §4.3/§4.4), separated from its HTTP server so it can be tested without a microVM.

Ported from agentcore-s3files-per-user-isolation/container/gateway.py (MIT). Changes: the identity is the KMS-signed ticket
token in the body (the runtime uses IAM inbound auth, so there is no Authorization header); one microVM is bound to one ticketKey;
the §4.4 actions replace the chat proxy; the gateway also owns the inbox writes, the token refresh and the CP proxy token.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any, Protocol

import dshsa_contracts as contracts
from inbox import Store


def log(event: str, **fields: Any) -> None:
    print(json.dumps({"component": "gateway", "event": event, **fields}), flush=True)


class Verifier(Protocol):
    def verify(self, token: str) -> dict[str, Any]: ...


class Mounter(Protocol):
    async def ensure(self, token: str) -> dict[str, Any]: ...
    def note_token(self, token: str) -> None: ...
    def mounted(self) -> bool: ...


class AgentClient(Protocol):
    async def call(self, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]: ...


class Rejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


VERSION_FILE = "/app/WORKER_VERSION"
# The agent this image runs (contracts WorkerType); the Codex image target sets DSHSA_AGENT=codex.
AGENT_TYPE = os.environ.get("DSHSA_AGENT", "claude")


def worker_version(path: str = VERSION_FILE) -> str:
    """The image's content version (contracts WorkerVersion): baked at build time; the env var overrides it (tests, local runs)."""
    if os.environ.get(contracts.WORKER_VERSION_ENV):
        return os.environ[contracts.WORKER_VERSION_ENV]
    try:
        with open(path) as f:
            return f.read().strip() or "unknown"
    except OSError:
        return "unknown"


class Gateway:
    def __init__(self, *, verifier: Verifier, mounter: Mounter, agent: AgentClient, store: Store, session_header: Callable[[], str | None] | None = None,
                 clock: Callable[[], float] = time.time, version: str | None = None, on_cli_started: Callable[[], None] | None = None,
                 agent_type: str = AGENT_TYPE) -> None:
        self.verifier, self.mounter, self.agent, self.store, self.clock = verifier, mounter, agent, store, clock
        self.agent_type = agent_type
        self.on_cli_started = on_cli_started  # once: the agent's first turn has the Claude CLI answering (the pin release)
        self.cli_seen = False
        self.version = version or worker_version()
        self.lock = asyncio.Lock()
        self.bound_sub: str | None = None
        self.bound_rsid: str | None = None
        self.token: str | None = None
        self.token_exp = 0
        self.claims: dict[str, Any] | None = None
        self.first_start = True
        self.started: set[str] = set()
        self.mounted = False
        self.last_state = "idle"

    # ---- identity --------------------------------------------------------------------------------------------------
    async def authenticate(self, request: dict[str, Any], session_id: str | None) -> dict[str, Any]:
        try:
            # verify may call kms:GetPublicKey on first use: keep it off the event loop.
            claims = await asyncio.to_thread(self.verifier.verify, request["token"])
        except Exception as error:  # noqa: BLE001 - any verification failure is the same answer
            raise Rejected("unauthorized", str(error)) from error
        ticket = request["ticket"]
        if (claims["tid"], claims["cid"], claims["tkt"], claims["asg"]) != (ticket.get("tenantId"), ticket.get("cellId"), ticket.get("ticketId"),
                                                                            ticket.get("assignmentId")):
            raise Rejected("unauthorized", "token does not match the ticket")
        if session_id and session_id != claims["rsid"]:
            raise Rejected("unauthorized", "token is for another runtime session")
        if self.bound_sub and claims["sub"] != self.bound_sub:
            raise Rejected("bound_to_other_ticket", "this microVM serves another ticket")
        return claims

    def keep_token(self, token: str, claims: dict[str, Any]) -> None:
        if claims["exp"] >= self.token_exp:
            self.token, self.token_exp, self.claims = token, claims["exp"], claims
            self.mounter.note_token(token)

    # ---- actions ---------------------------------------------------------------------------------------------------
    async def ensure_ready(self, token: str, claims: dict[str, Any], request: dict[str, Any]) -> None:
        async with self.lock:
            if self.bound_sub and self.bound_sub != claims["sub"]:
                raise Rejected("bound_to_other_ticket", "this microVM serves another ticket")
            if not self.mounted:
                try:
                    target = await self.mounter.ensure(token)
                except Exception as error:  # noqa: BLE001
                    raise Rejected("mount_failed", str(error)[:300]) from error
                if target.get("ticketKey") not in (None, claims["sub"]):
                    raise Rejected("mount_failed", "broker returned storage for another ticket")
                self.mounted = True  # cached: a stat of a stalled hard NFS mount would block the event loop
            self.bound_sub, self.bound_rsid = claims["sub"], claims["rsid"]
            await asyncio.to_thread(self.store.ensure)
            if request.get("config") is not None:
                await asyncio.to_thread(self.store.save_config, {"ticketKey": claims["sub"], "ticket": request["ticket"],
                                                                 "config": request["config"], "updatedAt": datetime.now(UTC).isoformat()})

    def versioned(self, response: dict[str, Any]) -> dict[str, Any]:
        """Every InvocationResponse names this image's version, so the cell can stop sessions still on an older microVM."""
        return {**response, contracts.WORKER_VERSION_FIELD: self.version}

    async def handle(self, request: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        return self.versioned(await self._handle(request, session_id))

    async def _handle(self, request: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        try:
            request = contracts.validate_invocation(request)
        except (ValueError, TypeError, AttributeError) as error:
            return contracts.error_response("bad_request", str(error))
        try:
            claims = await self.authenticate(request, session_id)
        except Rejected as error:
            log("rejected", code=error.code, reason=str(error))
            return contracts.error_response(error.code, str(error))
        # Contract v7 §4: a routing bug must not run a ticket on the wrong agent. Authenticated first, before any side effect.
        agent = (request.get("config") or {}).get("agent")
        if agent is not None and agent != self.agent_type:
            log("rejected", code="bad_request", reason=f"agent {str(agent)[:20]} on a {self.agent_type} runtime")
            return contracts.error_response("bad_request", f"this runtime runs {self.agent_type} workers, not {str(agent)[:20]}")
        action = request["action"]
        if action == "status":
            state = (await self._agent_status()) if self.bound_sub else "idle"
            return contracts.ok_response([], state)
        try:
            await self.ensure_ready(request["token"], claims, request)
        except Rejected as error:
            log("not_ready", code=error.code, reason=str(error))
            return contracts.error_response(error.code, str(error))
        self.keep_token(request["token"], claims)
        if action == "stop":
            await self.agent.call("/stop")
            return contracts.ok_response([], await self._agent_status())
        accepted = await asyncio.to_thread(self.store.append, request.get("inputs") or [])
        assignment = request["ticket"]["assignmentId"]
        # A `deliver` that reaches a new microVM first (after a loss) resumes the assignment the same way a start does.
        run, restarted = action == "start" or assignment not in self.started, False
        if not run:
            nudged = await self.agent.call("/nudge")
            # The agent process restarted (entrypoint loop) and lost its assignment: put it back to work from the inbox.
            run = restarted = nudged.get("error") == "no_assignment"
        if run:
            state = await asyncio.to_thread(self.store.state)
            # clean=False on a VM's first run, or after the agent died, means a turn was cut off; inside one live agent it
            # only means a turn is running now.
            recovery = (self.first_start or restarted) and state.get("clean") is False
            self.first_start = False
            result = await self.agent.call("/run", {"assignmentId": assignment, "recovery": recovery})
            if result.get("ok") is False:
                return contracts.error_response("internal", str(result.get("error", "agent refused the run")))
            self.started.add(assignment)
        return contracts.ok_response(accepted, await self._agent_status())

    async def _agent_status(self) -> str:
        """The agent's state within 3 s; the last known one if it does not answer (never blocks an invocation). Notes, once,
        that the agent's first turn has started the Claude CLI (`cliStarted`), which releases the snapshot page pins."""
        try:
            status = await asyncio.wait_for(self.agent.call("/status", None), 3)
            state = status.get("state", "idle")
        except Exception:  # noqa: BLE001
            return self.last_state
        self.last_state = state if state in ("idle", "running", "stopped") else "idle"
        if status.get("cliStarted") is True and not self.cli_seen:
            self.cli_seen = True
            try:
                if self.on_cli_started:
                    self.on_cli_started()
            except Exception as error:  # noqa: BLE001 - best effort; never fails a status
                log("cli_started_hook_failed", error=f"{type(error).__name__}: {str(error)[:200]}")
        return self.last_state

    async def busy(self) -> bool:
        return self.bound_sub is not None and await self._agent_status() == "running"

    # ---- token refresh ---------------------------------------------------------------------------------------------
    def refresh_due(self, margin_s: int = 600) -> bool:
        return self.token is not None and self.token_exp - self.clock() < margin_s

    async def refresh_loop(self, refresh: Callable[[str], Awaitable[str | None]], every_s: float = 60) -> None:
        """Refresh the ticket token before it expires while the agent works; a failure waits for the next host call."""
        while True:
            await asyncio.sleep(every_s)
            if not self.refresh_due() or not await self.busy():
                continue
            try:
                fresh = await refresh(self.token or "")
                if fresh:
                    claims = await asyncio.to_thread(self.verifier.verify, fresh)
                    if claims["sub"] != self.bound_sub:
                        raise Rejected("bound_to_other_ticket", "refreshed token is for another ticket")
                    self.keep_token(fresh, claims)
                    log("token_refreshed", exp=self.token_exp)
            except Exception as error:  # noqa: BLE001
                log("token_refresh_failed", error=str(error)[:300])


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in ("1", "true", "yes")
