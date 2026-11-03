"""worker-api Lambda (`dshsa-worker-api`, private REST API, design §4.5).

Every route: Bearer ticket token → verify (KMS public key) → `dshsa-ticket-storage[sub]` must be active and match → cell record.
Scopes come from the token, never from the request body.

Errors: 401 bad/expired token, 403 out of scope, 409 assignment mismatch, 501 not implemented, 503 cell unavailable.
Calls to the owning cell (`/{cellId}/worker/token-refresh`, `/{cellId}/worker/read`) authenticate with a presigned
sts:GetCallerIdentity URL in `x-dshsa-caller` that also signs `x-dshsa-target: <cellId>` (design §4.7 v3).
Env: TICKET_KEY_ID, TICKET_STORAGE_TABLE, CELLS_TABLE, LEASES_TABLE, GITHUB_APP_SECRET_ARN
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Any

import boto3
import dshsa_contracts as contracts

from dshsa_worker.github_app import OPTIONAL_WRITE_PERMISSIONS, READ_PERMISSIONS, WRITE_PERMISSIONS, GithubApp, GithubError, read_repo
from dshsa_worker.ticket_token import InvalidToken, KmsPublicKeys, TicketTokenVerifier

MAX_BODY = 256 * 1024


class HttpError(Exception):
    def __init__(self, status: int, error: str, message: str = "") -> None:
        super().__init__(message or error)
        self.status, self.error, self.message = status, error, message or error


def _item(raw: dict[str, Any]) -> Any:
    def value(v: dict[str, Any]) -> Any:
        if "S" in v:
            return v["S"]
        if "N" in v:
            n = v["N"]
            return int(n) if n.lstrip("-").isdigit() else float(n)
        if "BOOL" in v:
            return v["BOOL"]
        if "M" in v:
            return {k: value(x) for k, x in v["M"].items()}
        if "L" in v:
            return [value(x) for x in v["L"]]
        return None
    return {k: value(v) for k, v in raw.items()}


def presigned_caller(region: str, target: str, credentials: Any = None) -> str:
    """A presigned GetCallerIdentity URL valid for 60 s that also signs `x-dshsa-target` (design §4.7 v3)."""
    from botocore.auth import SigV4QueryAuth
    from botocore.awsrequest import AWSRequest
    frozen = (credentials or boto3.Session().get_credentials()).get_frozen_credentials()
    request = AWSRequest(method="GET", url=f"https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15",
                         headers={contracts.INTERNAL_API_TARGET_HEADER: target})
    SigV4QueryAuth(frozen, "sts", region, expires=contracts.INTERNAL_API_CALLER_TTL_SEC).add_auth(request)
    return request.url


def envelope_id(ticket_key: str, event_id: str) -> str:
    """Deterministic, ≤128 chars, safe for SQS MessageDeduplicationId: retries of one event collapse."""
    return "we-" + hashlib.sha256(f"{ticket_key}/{event_id}".encode()).hexdigest()[:40]


def validate_event(event: Any) -> dict[str, Any]:
    """Structural check mirroring contracts WorkerEvent (TS zod is the source of truth)."""
    if not isinstance(event, dict):
        raise HttpError(400, "bad_request", "event must be an object")
    for k in ("id", "ticketKey", "assignmentId", "at", "type"):
        if not isinstance(event.get(k), str) or not event[k]:
            raise HttpError(400, "bad_request", f"missing {k}")
    body = event.get("body")
    if event["type"] not in contracts.WORKER_EVENT_TYPES or not isinstance(body, dict):
        raise HttpError(400, "bad_request", "unknown event type or body")
    t = event["type"]
    need: dict[str, tuple[str, type]] = {"ack": ("text", str), "report": ("state", str), "handback": ("triggerIds", list),
                                         "thread.follow": ("thread", str), "thread.unrelated": ("thread", str),
                                         "inputs.read": ("inputIds", list), "turn.ended": ("reason", str)}
    if t in need:
        field, kind = need[t]
        if not isinstance(body.get(field), kind) or (kind in (str, list) and not body[field] and t != "turn.ended"):
            raise HttpError(400, "bad_request", f"{t}.{field} is required")
    if t == "report" and (body["state"] not in contracts.REPORT_STATES or not isinstance(body.get("text"), str)):
        raise HttpError(400, "bad_request", "report needs a valid state and text")
    if t == "handback" and not isinstance(body.get("reason"), str):
        raise HttpError(400, "bad_request", "handback.reason is required")
    if t == "ack" and (not isinstance(body.get("triggerId"), str) or not body["triggerId"]):
        raise HttpError(400, "bad_request", "ack.triggerId is required")
    if t in ("thread.follow", "thread.unrelated"):
        reason = body.get("reason")
        if not re.match(r"^[a-z]+:.+$", body["thread"]) or not isinstance(reason, str) or not 1 <= len(reason) <= 300:
            raise HttpError(400, "bad_request", f"{t} needs a thread key <source>:<id> and a reason")
    if t == "report":
        if "question" in body and body["question"] is not None and (not isinstance(body["question"], str) or not 1 <= len(body["question"]) <= 1000):
            raise HttpError(400, "bad_request", "report.question must be a string (1-1000) or null")
        if "prNumber" in body and body["prNumber"] is not None and (not isinstance(body["prNumber"], int) or body["prNumber"] < 1):
            raise HttpError(400, "bad_request", "report.prNumber must be a positive integer or null")
    if len(json.dumps(event)) > MAX_BODY:
        raise HttpError(413, "too_large")
    return event


class WorkerApi:
    def __init__(self, *, verifier: TicketTokenVerifier, ddb: Any, sqs: Any, secrets: Any, tables: dict[str, str],
                 github_secret_arn: str, caller: Any, http=urllib.request.urlopen, clock=time.time,
                 github_factory=GithubApp, repo_reader=read_repo) -> None:
        """`caller(cellId) -> presigned URL` proves this Lambda's role to the host (see `presigned_caller`)."""
        self.verifier, self.ddb, self.sqs, self.secrets, self.tables = verifier, ddb, sqs, secrets, tables
        self.github_secret_arn, self.caller, self.http, self.clock = github_secret_arn, caller, http, clock
        self.github_factory, self.repo_reader = github_factory, repo_reader
        self._secret_cache: dict[str, tuple[float, str]] = {}
        self.last_ticket_key: str | None = None

    # ---- shared ----------------------------------------------------------------------------------------------------
    def _secret(self, arn: str) -> str:
        cached = self._secret_cache.get(arn)
        if cached and cached[0] > self.clock():
            return cached[1]
        value = self.secrets.get_secret_value(SecretId=arn)["SecretString"]
        self._secret_cache[arn] = (self.clock() + 300, value)
        return value

    def _get(self, table: str, key: str, value: str) -> dict[str, Any] | None:
        raw = self.ddb.get_item(TableName=self.tables[table], Key={key: {"S": value}}, ConsistentRead=True).get("Item")
        return _item(raw) if raw else None

    def authenticate(self, headers: dict[str, str]) -> tuple[contracts.TicketTokenClaims, dict[str, Any]]:
        # Behind AWS_IAM the gateway's SigV4 owns Authorization, so the ticket token rides in X-Dshsa-Ticket-Token.
        lower = {k.lower(): v for k, v in headers.items()}
        auth = lower.get("authorization", "")
        token = lower.get(contracts.TICKET_TOKEN_HEADER) or (auth[len("Bearer "):] if auth.startswith("Bearer ") else "")
        if not token:
            raise HttpError(401, "unauthorized", "missing ticket token")
        try:
            claims = self.verifier.verify(token)
        except InvalidToken as error:
            raise HttpError(401, "unauthorized", str(error)) from error
        storage = self._get("ticketStorage", "ticketKey", claims["sub"])
        if not storage or storage.get("status") != "active":
            raise HttpError(401, "unauthorized", "ticket storage is not active")
        if (storage.get("cellId"), storage.get("ticketId"), storage.get("tenantId")) != (claims["cid"], claims["tkt"], claims["tid"]):
            raise HttpError(401, "unauthorized", "ticket storage does not match the token")
        cell = self._get("cells", "cellId", claims["cid"])
        if not cell or cell.get("tenantId") != claims["tid"]:
            raise HttpError(403, "forbidden", "unknown cell")
        if cell.get("status") == "disabled":
            raise HttpError(503, "cell_unavailable", "cell is disabled")
        return claims, cell

    # ---- routes ----------------------------------------------------------------------------------------------------
    def events(self, claims: contracts.TicketTokenClaims, cell: dict[str, Any], body: Any) -> dict[str, Any]:
        event = validate_event(body)
        if event["ticketKey"] != claims["sub"]:
            raise HttpError(403, "forbidden", "event is for another ticket")
        if event["assignmentId"] != claims["asg"]:
            raise HttpError(409, "assignment_mismatch", "event is for another assignment")
        env_id = envelope_id(claims["sub"], event["id"])
        # Contract v1 CellEnvelope worker.event: body = {event, verified} (packages/contracts/src/envelope.ts WorkerEventBody).
        envelope = {"v": 1, "id": env_id, "cellId": claims["cid"], "type": "worker.event", "at": datetime.now(UTC).isoformat(),
                    "body": {"event": event, "verified": {"tid": claims["tid"], "cid": claims["cid"], "tkt": claims["tkt"], "asg": claims["asg"]}}}
        self.sqs.send_message(QueueUrl=cell["queueUrl"], MessageBody=json.dumps(envelope), MessageGroupId=claims["cid"],
                              MessageDeduplicationId=env_id)
        return {"ok": True}

    def _github(self) -> GithubApp:
        secret = json.loads(self._secret(self.github_secret_arn))
        return self.github_factory(secret["appId"], secret["privateKey"])

    def credentials(self, _claims: contracts.TicketTokenClaims, cell: dict[str, Any], _body: Any) -> dict[str, Any]:
        repo = cell["repo"]
        try:
            return self._github().installation_token(int(repo["installationId"]), int(repo["id"]), WRITE_PERMISSIONS, OPTIONAL_WRITE_PERMISSIONS)
        except GithubError as error:
            raise HttpError(error.status, "github_error", str(error)) from error

    def read(self, _claims: contracts.TicketTokenClaims, cell: dict[str, Any], body: Any) -> dict[str, Any]:
        resource = body.get("resource") if isinstance(body, dict) else None
        if not isinstance(resource, str) or not (resource.startswith("github/") or resource.startswith("feishu/")):
            raise HttpError(400, "bad_request", "resource must start with github/ or feishu/")
        if resource.startswith("feishu/"):
            # Feishu reads use the cell's TS readers and the tenant's bot (design §4.7 v3); the cell checks the chat binding.
            data = self._to_cell(_claims, "read", {"resource": resource})
            if not isinstance(data.get("content"), str):
                raise HttpError(503, "cell_unavailable", "bad read answer")
            return {"ok": True, "content": data["content"][:400_000], "mediaType": str(data.get("mediaType", "application/json"))}
        repo = cell["repo"]
        try:
            token = self._github().installation_token(int(repo["installationId"]), int(repo["id"]), READ_PERMISSIONS)["token"]
            content, media = self.repo_reader(token, repo["owner"], repo["name"], resource[len("github/"):])
        except GithubError as error:
            raise HttpError(error.status, "github_error", str(error)) from error
        return {"ok": True, "content": content[:400_000], "mediaType": media}

    def _to_cell(self, claims: contracts.TicketTokenClaims, route: str, extra: dict[str, Any]) -> dict[str, Any]:
        """POST /{cellId}/worker/<route> on the live lease owner, authenticated as this Lambda's role."""
        lease = self._get("leases", "leaseKey", f"cell#{claims['cid']}")
        if not lease or not lease.get("endpoint") or int(lease.get("expiresAt", 0)) <= int(self.clock() * 1000):
            raise HttpError(503, "cell_unavailable", "no live owner for this cell")
        url = f"{lease['endpoint'].rstrip('/')}/{claims['cid']}/worker/{route}"
        payload = json.dumps({"claims": {k: claims[k] for k in ("sub", "tid", "cid", "tkt", "asg", "rsid")}, **extra}).encode()
        req = urllib.request.Request(url, data=payload, method="POST", headers={
            "Content-Type": "application/json", contracts.INTERNAL_API_CALLER_HEADER: self.caller(claims["cid"]),
            contracts.INTERNAL_API_TARGET_HEADER: claims["cid"]})
        try:
            with self.http(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as error:
            status = error.code if error.code in (400, 403, 404, 409) else 503
            raise HttpError(status, "cell_refused" if status != 503 else "cell_unavailable", f"cell answered {error.code}") from error
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            raise HttpError(503, "cell_unavailable", "cell unreachable") from error
        if not isinstance(data, dict):
            raise HttpError(503, "cell_unavailable", "bad cell answer")
        if data.get("ok") is False:
            # 5c: forbidden (scope) → 403, not_found → 404, unavailable (Feishu API failure) → 503.
            status = {"forbidden": 403, "not_found": 404, "bad_request": 400}.get(str(data.get("error")), 503)
            raise HttpError(status, str(data.get("error", "cell_refused")), str(data.get("message", "")))
        return data

    def token_refresh(self, claims: contracts.TicketTokenClaims, _cell: dict[str, Any], _body: Any) -> dict[str, Any]:
        data = self._to_cell(claims, "token-refresh", {})
        if not isinstance(data.get("token"), str):
            raise HttpError(503, "cell_unavailable", "bad refresh answer")
        return {"token": data["token"]}

    ROUTES = {"/v1/events": "events", "/v1/read": "read", "/v1/credentials/github": "credentials", "/v1/token/refresh": "token_refresh"}

    def __call__(self, method: str, path: str, headers: dict[str, str], raw_body: str | None) -> tuple[int, dict[str, Any]]:
        route = self.ROUTES.get(path.rstrip("/"))
        if route is None:
            return 404, {"ok": False, "error": "not_found", "message": path}
        if method != "POST":
            return 405, {"ok": False, "error": "method_not_allowed", "message": method}
        try:
            if raw_body and len(raw_body) > MAX_BODY:
                raise HttpError(413, "too_large")
            try:
                body = json.loads(raw_body) if raw_body else {}
            except json.JSONDecodeError as error:
                raise HttpError(400, "bad_request", "invalid JSON") from error
            self.last_ticket_key = None
            claims, cell = self.authenticate(headers)
            self.last_ticket_key = claims["sub"]
            return 200, getattr(self, route)(claims, cell, body)
        except HttpError as error:
            if error.status >= 500:
                print(json.dumps({"event": "worker_api_error", "path": path, "error": error.error, "message": error.message}))
            return error.status, {"ok": False, "error": error.error, "message": error.message}
        except Exception as error:  # noqa: BLE001 - AWS/GitHub/record failures: a JSON 500 the worker retries, not a bare 502
            print(json.dumps({"event": "worker_api_error", "path": path, "error": "internal", "type": type(error).__name__,
                              "message": str(error)[:300]}))
            return 500, {"ok": False, "error": "internal", "message": type(error).__name__}


_api: WorkerApi | None = None


def log_request(event: dict[str, Any], path: str, status: int, body: dict[str, Any], ticket_key: str | None, started: float) -> None:
    """One structured line per request (the stage has no access log, see infra worker.ts). Never logs the token or the body."""
    context = event.get("requestContext") or {}
    identity = context.get("identity") or {}
    print(json.dumps({"event": "request", "requestId": context.get("requestId"), "route": f"{event.get('httpMethod')} {path}", "status": status,
                      "callerArn": identity.get("userArn") or identity.get("caller"), "sourceVpce": identity.get("vpceId") or context.get("vpceId"),
                      "ticketKey": ticket_key, "error": body.get("error") if isinstance(body, dict) else None,
                      "ms": int((time.monotonic() - started) * 1000)}))


def _default() -> WorkerApi:
    global _api
    if _api is None:
        region = os.environ["AWS_REGION"]
        _api = WorkerApi(
            verifier=TicketTokenVerifier(KmsPublicKeys(boto3.client("kms", region_name=region), os.environ["TICKET_KEY_ID"])),
            ddb=boto3.client("dynamodb", region_name=region), sqs=boto3.client("sqs", region_name=region),
            secrets=boto3.client("secretsmanager", region_name=region),
            tables={"ticketStorage": os.environ["TICKET_STORAGE_TABLE"], "cells": os.environ["CELLS_TABLE"], "leases": os.environ["LEASES_TABLE"]},
            github_secret_arn=os.environ["GITHUB_APP_SECRET_ARN"], caller=lambda cell: presigned_caller(region, cell))
    return _api


def handler(event: dict[str, Any], _context: Any = None, api: WorkerApi | None = None) -> dict[str, Any]:
    """API Gateway REST (proxy integration) → WorkerApi."""
    # REST proxy events: `path` is the resource path without the stage (requestContext.path has it). Strip a stage prefix
    # only when that is what makes the path a known route (e.g. HTTP API rawPath), since our routes start with /v1 too.
    path = (event.get("path") or event.get("rawPath") or "").rstrip("/")
    stage = (event.get("requestContext") or {}).get("stage")
    if path not in WorkerApi.ROUTES and stage and path.startswith(f"/{stage}/") and path[len(stage) + 1:] in WorkerApi.ROUTES:
        path = path[len(stage) + 1:]
    started = time.monotonic()
    worker_api = api or _default()
    status, body = worker_api(event.get("httpMethod") or "POST", path, event.get("headers") or {}, event.get("body"))
    log_request(event, path, status, body, worker_api.last_ticket_key, started)
    return {"statusCode": status, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"}, "body": json.dumps(body)}
