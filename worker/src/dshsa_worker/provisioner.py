"""Provisioner Lambda `dshsa-provisioner`: one S3 Files access point per ticket, and its `dshsa-ticket-storage` record.

Only the host (cell Executor) invokes it. It is the only writer of `dshsa-ticket-storage` (design §4.2); the broker only reads.

Event: {"action"?: "ensure" (default) | "disable" | "delete", "tenantId", "cellId", "ticketId",
        "ticketKey"?, "runtimeSessionId"?, "rootPath"?}   (optional derived ids are checked against the contracts derivation)
Return: {"ok": true, "accessPointId", ...TicketStorageRecord (§4.2)} or {"ok": false, "error": "bad_request" | "internal", "message"}
Env: FILE_SYSTEM_ID, TICKET_STORAGE_TABLE
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import UTC, datetime
from typing import Any

import boto3
import dshsa_contracts as contracts

UID = GID = contracts.WORKER_UID
MAX_AP_PATH_COMPONENTS = contracts.MAX_AP_PATH_COMPONENTS
# The CreateAccessPoint rootDirectory.path pattern (S3 Files API): at most 4 components, none starting with '.'.
AP_PATH_RE = re.compile(r"^(/|(/(?!\.)+[^$#<>;`|&?{}^*/\n]+){1,4})$")
# Permanent API errors: retrying the same request cannot succeed, so the caller must not retry (cell fails the ticket).
PERMANENT = {"ValidationException", "BadRequestException", "AccessDeniedException", "ServiceQuotaExceededException"}


def check_root(path: str) -> str:
    if len([part for part in path.split("/") if part]) > MAX_AP_PATH_COMPONENTS or not AP_PATH_RE.match(path):
        raise BadRequest(f"access point root {path!r} is not a valid S3 Files root path (<= {MAX_AP_PATH_COMPONENTS} components)")
    return path


class BadRequest(Exception):
    pass


def _item(raw: dict[str, Any]) -> dict[str, Any]:
    return {k: (int(v["N"]) if "N" in v else next(iter(v.values()))) for k, v in raw.items()}


def _raw(rec: dict[str, Any]) -> dict[str, Any]:
    return {k: ({"N": str(v)} if isinstance(v, int) else {"S": str(v)}) for k, v in rec.items()}


class Provisioner:
    def __init__(self, *, s3files: Any, ddb: Any, table: str, file_system_id: str, sleep=time.sleep, clock=lambda: datetime.now(UTC)) -> None:
        self.s3files, self.ddb, self.table, self.fs, self.sleep, self.clock = s3files, ddb, table, file_system_id, sleep, clock

    @staticmethod
    def ids(event: dict[str, Any]) -> tuple[str, str, str]:
        tenant, cell, ticket = event.get("tenantId"), event.get("cellId"), event.get("ticketId")
        if not all(isinstance(v, str) and v for v in (tenant, cell, ticket)):
            raise BadRequest("tenantId, cellId and ticketId are required")
        if not contracts.TENANT_RE.match(tenant) or not contracts.CELL_RE.match(cell) or contracts.tenant_of_cell(cell) != tenant:
            raise BadRequest("inconsistent tenantId/cellId")
        derived = {"ticketKey": contracts.ticket_key(cell, ticket), "runtimeSessionId": contracts.runtime_session_id(cell, ticket),
                   "rootPath": contracts.access_point_root(tenant, cell, ticket)}
        for name, value in derived.items():
            if name in event and event[name] != value:
                raise BadRequest(f"{name} does not match the contracts derivation")
        return tenant, cell, ticket

    def get(self, ticket_key: str) -> dict[str, Any] | None:
        raw = self.ddb.get_item(TableName=self.table, Key={"ticketKey": {"S": ticket_key}}, ConsistentRead=True).get("Item")
        return _item(raw) if raw else None

    def _access_point_alive(self, ap_id: str) -> bool:
        try:
            state = self.s3files.get_access_point(accessPointId=ap_id).get("status", "available")
        except self.s3files.exceptions.ResourceNotFoundException:
            return False
        return state not in ("deleting", "deleted", "error", "misconfigured")

    def _wait_available(self, ap_id: str, timeout_s: float = 60) -> None:
        deadline = time.monotonic() + timeout_s
        while True:
            state = self.s3files.get_access_point(accessPointId=ap_id).get("status", "available")
            if state == "available":
                return
            if state in ("error", "deleting", "deleted", "misconfigured") or time.monotonic() > deadline:
                raise RuntimeError(f"access point {ap_id} is {state}")
            self.sleep(1)

    def ensure(self, event: dict[str, Any]) -> dict[str, Any]:
        tenant, cell, ticket = self.ids(event)
        key = contracts.ticket_key(cell, ticket)
        existing = self.get(key)
        if existing and existing["status"] == "active" and self._access_point_alive(existing["accessPointId"]):
            return existing
        if existing and existing["status"] in ("disabled", "deleted"):
            raise BadRequest(f"ticket storage is {existing['status']}")
        root = check_root(contracts.access_point_root(tenant, cell, ticket))
        created = self.s3files.create_access_point(
            fileSystemId=self.fs, clientToken=key,
            posixUser={"uid": UID, "gid": GID},
            rootDirectory={"path": root, "creationPermissions": {"ownerUid": UID, "ownerGid": GID, "permissions": "0700"}},
            tags=[{"key": contracts.MANAGED_TAG[0], "value": contracts.MANAGED_TAG[1]}, {"key": "dshsa:ticketKey", "value": key},
                  {"key": "dshsa:cellId", "value": cell}, {"key": "Name", "value": f"dshsa-ticket-{key}"}],
        )
        ap_id = created["accessPointId"]
        self._wait_available(ap_id)
        rec = {"ticketKey": key, "tenantId": tenant, "cellId": cell, "ticketId": ticket, "runtimeSessionId": contracts.runtime_session_id(cell, ticket),
               "fileSystemId": self.fs, "accessPointId": ap_id, "rootPath": root, "posixUid": UID, "posixGid": GID, "status": "active",
               "createdAt": (existing or {}).get("createdAt") or self.clock().isoformat()}
        self.ddb.put_item(TableName=self.table, Item=_raw(rec),
                          ConditionExpression="attribute_not_exists(ticketKey) OR accessPointId = :ap OR #s = :active",
                          ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":ap": {"S": ap_id}, ":active": {"S": "active"}})
        return rec

    def set_status(self, event: dict[str, Any], status: str) -> dict[str, Any]:
        _tenant, cell, ticket = self.ids(event)
        key = contracts.ticket_key(cell, ticket)
        rec = self.get(key)
        if not rec:
            raise BadRequest("unknown ticket storage")
        if status == "deleted" and rec["status"] != "deleted":
            try:
                self.s3files.delete_access_point(accessPointId=rec["accessPointId"])
            except self.s3files.exceptions.ResourceNotFoundException:
                pass
        self.ddb.update_item(TableName=self.table, Key={"ticketKey": {"S": key}}, UpdateExpression="SET #s = :s",
                             ExpressionAttributeNames={"#s": "status"}, ExpressionAttributeValues={":s": {"S": status}})
        return {**rec, "status": status}

    def __call__(self, event: dict[str, Any]) -> dict[str, Any]:
        action = event.get("action", "ensure")
        if action == "ensure":
            return self.ensure(event)
        if action == "disable":
            return self.set_status(event, "disabled")
        if action == "delete":
            return self.set_status(event, "deleted")
        raise BadRequest(f"unknown action {action!r}")


_provisioner: Provisioner | None = None


def handler(event: Any, _context: Any = None, provisioner: Provisioner | None = None) -> dict[str, Any]:
    global _provisioner
    if provisioner is None:
        if _provisioner is None:
            region = os.environ["AWS_REGION"]
            _provisioner = Provisioner(s3files=boto3.client("s3files", region_name=region), ddb=boto3.client("dynamodb", region_name=region),
                                       table=os.environ["TICKET_STORAGE_TABLE"], file_system_id=os.environ["FILE_SYSTEM_ID"])
        provisioner = _provisioner
    if not isinstance(event, dict):
        return {"ok": False, "error": "bad_request", "message": "event must be an object"}
    try:
        result = provisioner(event)
    except BadRequest as error:
        print(json.dumps({"event": "provision_refused", "error": str(error)[:500]}))
        return {"ok": False, "error": "bad_request", "message": str(error)}
    except Exception as error:  # noqa: BLE001 - the host retries `internal`; report the reason
        code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        if code in PERMANENT:
            print(json.dumps({"event": "provision_failed", "permanent": True, "code": code, "error": str(error)[:500]}))
            return {"ok": False, "error": "bad_request", "message": f"{code}: {str(error)[:300]}"}
        print(json.dumps({"event": "provision_failed", "error": str(error)[:500]}))
        return {"ok": False, "error": "internal", "message": str(error)[:300]}
    print(json.dumps({"event": event.get("action", "ensure"), "ticketKey": result["ticketKey"], "accessPointId": result["accessPointId"],
                      "status": result["status"]}))
    return {"ok": True, **result}
