"""Python mirror of @dshsa/contracts (design §4.1, §4.3–§4.5) for the worker, broker, provisioner and worker-api.

Keep in sync with packages/contracts/src; tests/vectors.json is the shared oracle.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any, Literal, TypedDict

TENANT_RE = re.compile(r"^[a-z][a-z0-9-]{2,30}$")
CELL_RE = re.compile(r"^[a-z][a-z0-9-]{2,30}--gh\d+$")
TICKET_KEY_RE = re.compile(r"^[0-9a-f]{32}$")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def cell_id(tenant_id: str, github_repo_id: int | str) -> str:
    if not TENANT_RE.match(tenant_id):
        raise ValueError("bad tenantId")
    return f"{tenant_id}--gh{github_repo_id}"


def tenant_of_cell(cell: str) -> str:
    if not CELL_RE.match(cell):
        raise ValueError("bad cellId")
    return cell.split("--gh")[0]


def ticket_key(cell: str, ticket_id: str) -> str:
    return _sha(f"{cell}/{ticket_id}")[:32]


def runtime_session_id(cell: str, ticket_id: str) -> str:
    return "dshsa-" + _sha(f"{cell}/{ticket_id}")


def access_point_root(tenant_id: str, cell: str, ticket_id: str) -> str:
    # v4: S3 Files AP root paths allow at most 4 components.
    return f"/tenants/{tenant_id}/{cell}/{ticket_key(cell, ticket_id)}"


MAX_AP_PATH_COMPONENTS = 4


def ticket_data_prefix(tenant_id: str, cell: str, ticket_id: str) -> str:
    """S3 key prefix of a ticket's files in the data bucket (the FS maps the bucket root)."""
    return access_point_root(tenant_id, cell, ticket_id)[1:] + "/"


# ---- names (design §3, §4.2, §4.9)
TABLES = {
    "tenants": "dshsa-tenants",
    "cells": "dshsa-cells",
    "routes": "dshsa-routes",
    "leases": "dshsa-leases",
    "ticketStorage": "dshsa-ticket-storage",
    "onboarding": "dshsa-onboarding",
}
TICKET_TOKEN_KEY_ALIAS = "alias/dshsa-ticket-token"

# v6 panel onboarding (names only; the worker side does not use them yet).
RESERVED_TENANT_IDS = ("admin", "tadmin", "platform")
PANEL_ROLE_HEADER = "x-dshsa-role"


def tenant_admin_group(tenant_id: str) -> str:
    return f"dshsa-tadmin-{tenant_id}"


def onboarding_install_key(installation_id: int | str) -> str:
    return f"ghinst#{installation_id}"
WORKER_UID = WORKER_GID = 1000
MANAGED_TAG = ("dshsa:managed", "true")
INTERNAL_API_CALLER_HEADER = "x-dshsa-caller"
INTERNAL_API_TARGET_HEADER = "x-dshsa-target"
INTERNAL_API_CALLER_TTL_SEC = 60
TICKET_TOKEN_HEADER = "x-dshsa-ticket-token"
GATEWAY_PROXY = {"host": "127.0.0.1", "port": 8090, "prefix": "/cp"}
WORKER_API = {
    "events": "/v1/events",
    "read": "/v1/read",
    "githubCredentials": "/v1/credentials/github",
    "tokenRefresh": "/v1/token/refresh",
}

# ---- ticket token (design §4.3)
TOKEN_ISSUER = "dshsa-cp"
TOKEN_AUDIENCE = "dshsa-worker"
TOKEN_MAX_TTL_SEC = 2 * 60 * 60
TOKEN_SKEW_SEC = 60


class TicketTokenClaims(TypedDict):
    iss: str
    aud: str
    sub: str  # ticketKey
    tid: str  # tenantId
    cid: str  # cellId
    tkt: str  # ticketId
    asg: str  # assignmentId
    rsid: str  # runtimeSessionId
    iat: int
    exp: int
    jti: str


def check_claims(c: dict[str, Any], now: int) -> TicketTokenClaims:
    """Validate claim semantics (signature is checked separately). Raises ValueError."""
    if c.get("iss") != TOKEN_ISSUER or c.get("aud") != TOKEN_AUDIENCE:
        raise ValueError("bad iss/aud")
    for k in ("sub", "tid", "cid", "tkt", "asg", "rsid", "jti"):
        if not isinstance(c.get(k), str) or not c[k]:
            raise ValueError(f"missing {k}")
    if not TICKET_KEY_RE.match(c["sub"]) or not TENANT_RE.match(c["tid"]) or not CELL_RE.match(c["cid"]):
        raise ValueError("bad id format")
    if tenant_of_cell(c["cid"]) != c["tid"] or ticket_key(c["cid"], c["tkt"]) != c["sub"] or runtime_session_id(c["cid"], c["tkt"]) != c["rsid"]:
        raise ValueError("inconsistent ids")
    iat, exp = c.get("iat"), c.get("exp")
    if not isinstance(iat, int) or not isinstance(exp, int) or exp <= iat or exp - iat > TOKEN_MAX_TTL_SEC:
        raise ValueError("bad ttl")
    if now > exp + TOKEN_SKEW_SEC or now + TOKEN_SKEW_SEC < iat:
        raise ValueError("expired or not yet valid")
    return c  # type: ignore[return-value]


# ---- invocation (design §4.4)
InvocationAction = Literal["start", "deliver", "stop", "status"]
WorkerState = Literal["idle", "running", "stopped"]
INVOCATION_ERRORS = ("unauthorized", "bound_to_other_ticket", "mount_failed", "bad_request", "internal")


# WorkerVersion (invocation.ts): the image content version on every InvocationResponse; the deployed one is in SSM.
WORKER_VERSION_FIELD = "workerVersion"
WORKER_VERSION_ENV = "DSHSA_WORKER_VERSION"
WORKER_VERSION_PARAMETER = "/dshsa-worker/version"
# v7: per worker type (WorkerVersion.parameters); WORKER_VERSION_PARAMETER is the claude one.
WORKER_VERSION_PARAMETERS = {"claude": "/dshsa-worker/version", "codex": "/dshsa-worker-codex/version"}


def _versioned(response: dict[str, Any], worker_version: str | None) -> dict[str, Any]:
    return {**response, WORKER_VERSION_FIELD: worker_version} if worker_version else response


def ok_response(accepted: list[str], state: WorkerState, worker_version: str | None = None) -> dict[str, Any]:
    return _versioned({"ok": True, "accepted": accepted, "state": state}, worker_version)


def error_response(error: str, message: str = "", worker_version: str | None = None) -> dict[str, Any]:
    assert error in INVOCATION_ERRORS, error
    return _versioned({"ok": False, "error": error, "message": message}, worker_version)


def validate_invocation(req: dict[str, Any]) -> dict[str, Any]:
    """Minimal structural validation mirroring InvocationRequest. Raises ValueError."""
    if req.get("v") != 1 or req.get("action") not in ("start", "deliver", "stop", "status"):
        raise ValueError("bad v/action")
    if not isinstance(req.get("token"), str) or not req["token"]:
        raise ValueError("missing token")
    t = req.get("ticket")
    if not isinstance(t, dict) or not all(isinstance(t.get(k), str) for k in ("tenantId", "cellId", "ticketId", "assignmentId")):
        raise ValueError("bad ticket")
    if req["action"] in ("start", "deliver") and not isinstance(req.get("config"), dict):
        raise ValueError("config is required for start/deliver")
    cfg = req.get("config")
    if isinstance(cfg, dict):
        # v7: type checks only; a worker drops (and logs) an effort it doesn't know, never bad_request.
        for key in ("effort", "agent"):
            if key in cfg and cfg[key] is not None and (not isinstance(cfg[key], str) or not cfg[key]):
                raise ValueError(f"config.{key} must be a non-empty string")
    req.setdefault("inputs", [])
    return req


# ---- worker events (design §4.5)
REPORT_STATES = ("progress", "waiting", "ready", "blocked", "failed", "dropped")
# v2: ack.body = {text, triggerId}; report.body optional {question: str|None, askedBy, answers, prNumber: int|None, links};
# thread.follow / thread.unrelated body = {thread: "<source>:<id>", reason}.
REGION = "ap-northeast-1"
WORKER_EVENT_TYPES = ("ack", "report", "handback", "thread.follow", "thread.unrelated", "inputs.read", "turn.ended", "token.refresh")


import uuid as _uuid

_SDK_NS = _uuid.UUID("6f1d6c5e-3a0b-5d1e-9f4a-64736873612d")  # fixed namespace for dshsa


def sdk_session_id(tkey: str) -> str:
    """Deterministic Claude Agent SDK session id for a ticket (spike S2): uuid5(ns, "dshsa/" + ticketKey)."""
    return str(_uuid.uuid5(_SDK_NS, "dshsa/" + tkey))


# ---- v7 model catalog (models.ts; tests/vectors.json "models" is the shared oracle)
WORKER_TYPES = ("claude", "codex")
EFFORTS = ("none", "low", "medium", "high", "xhigh", "max")
_CLAUDE = ["low", "medium", "high", "xhigh", "max"]
_GPT = ["none", "low", "medium", "high", "xhigh", "max"]
_CODEX = ["low", "medium", "high", "xhigh", "max"]  # codex 0.166.0 turn/start.effort without `ultra` (sub-agents)
MODEL_CATALOG: list[dict[str, Any]] = [
    {"id": "global.anthropic.claude-opus-5-5", "label": "Claude Opus 5.5", "family": "anthropic", "tier": "large",
     "surfaces": {"claude-worker": {"efforts": _CLAUDE}}},
    {"id": "global.anthropic.claude-sonnet-5-5", "label": "Claude Sonnet 5.5", "family": "anthropic", "tier": "medium",
     "surfaces": {"converse": {"efforts": _CLAUDE, "promptCache": True}, "claude-worker": {"efforts": _CLAUDE}}},
    {"id": "global.anthropic.claude-haiku-5-5", "label": "Claude Haiku 5.5", "family": "anthropic", "tier": "small",
     "surfaces": {"converse": {"efforts": _CLAUDE, "forceTool": True, "promptCache": True}, "claude-worker": {"efforts": _CLAUDE}}},
    {"id": "global.openai.gpt-6-astra", "label": "GPT-6 Astra", "family": "openai", "tier": "large",
     "surfaces": {"codex-worker": {"efforts": _CODEX}}},
    {"id": "global.openai.gpt-6.1-sol", "label": "GPT-6.1 Sol", "family": "openai", "tier": "large",
     "surfaces": {"codex-worker": {"efforts": _CODEX}}},
    {"id": "global.openai.gpt-6.1-terra", "label": "GPT-6.1 Terra", "family": "openai", "tier": "medium",
     "surfaces": {"converse": {"efforts": _GPT, "forceTool": True, "promptCache": True},
                  "codex-worker": {"efforts": _CODEX, "defaultEffort": "high"}}},
    {"id": "global.openai.gpt-6-luna", "label": "GPT-6 Luna", "family": "openai", "tier": "small",
     "surfaces": {"converse": {"efforts": _GPT, "defaultEffort": "low", "forceTool": True, "promptCache": False}}},
]
DEFAULT_MODELS = {"eval": "global.openai.gpt-6-luna", "reply": "global.openai.gpt-6-luna",
                  "worker": {"claude": "global.anthropic.claude-opus-5-5", "codex": "global.openai.gpt-6.1-terra"}}


def catalog_model(model_id: str) -> dict[str, Any] | None:
    return next((m for m in MODEL_CATALOG if m["id"] == model_id), None)


def check_model(surface: str, model_id: str, effort: str | None = None) -> str | None:
    """None when usable, else 'unknownModel' | 'wrongSurface' | 'badEffort' (models.ts checkModel)."""
    model = catalog_model(model_id)
    if model is None:
        return "unknownModel"
    spec = model["surfaces"].get(surface)
    if spec is None:
        return "wrongSurface"
    if effort is not None and effort not in spec["efforts"]:
        return "badEffort"
    return None


def worker_effort(worker_type: str, model_id: str, effort: str | None) -> str | None:
    """The effort a worker passes on: `effort` when its catalog surface accepts it (or the model is outside the catalog),
    else None (the caller logs the drop). Never raises: an unknown effort is not a reason to refuse work."""
    if not effort:
        return None
    if effort not in EFFORTS:
        return None
    spec = (catalog_model(model_id) or {}).get("surfaces", {}).get(f"{worker_type}-worker")
    return effort if spec is None or effort in spec["efforts"] else None
