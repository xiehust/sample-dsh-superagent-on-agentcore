"""Credential broker Lambda `dshsa-broker`: ticket token → STS credentials that can mount only that ticket's access point.

Adapted from agentcore-s3files-per-user-isolation/broker/handler.py (MIT). Differences: the identity is a KMS-signed ticket
token (design §4.3) instead of a Cognito access token, and the mapping is `dshsa-ticket-storage[ticketKey]` (§4.2).

Invoked by the root gateway inside the microVM. It never trusts the caller (the runtime execution role is readable by any
code in the VM), only the token. Any failure answers `{"error": "unauthorized: ..."}`; it never falls back to anything.

Event:  {"token": "<ticket token>"}
Return: {"ticketKey", "fileSystemId", "accessPointId", "accessPointArn", "rootPath", "posixUid", "posixGid", "credentials": {...}}
Env:    FILE_SYSTEM_ID, SESSION_MOUNT_ROLE_ARN, TICKET_STORAGE_TABLE, TICKET_KEY_ID, CRED_TTL_SECONDS (default 3600)
"""
from __future__ import annotations

import json
import os
from typing import Any

import boto3

from dshsa_worker.ticket_token import InvalidToken, KmsPublicKeys, TicketTokenVerifier


class Unauthorized(Exception):
    pass


def access_point_arn(region: str, account: str, file_system_id: str, access_point_id: str) -> str:
    return f"arn:aws:s3files:{region}:{account}:file-system/{file_system_id}/access-point/{access_point_id}"


def session_policy(ap_arn: str) -> str:
    """Narrows the mount role to one access point (identical in intent to the reference broker)."""
    return json.dumps({
        "Version": "2012-10-17",
        "Statement": [
            {"Sid": "MountThisTicketsAccessPointOnly", "Effect": "Allow", "Action": ["s3files:ClientMount", "s3files:ClientWrite"],
             "Resource": "*", "Condition": {"StringEquals": {"s3files:AccessPointArn": ap_arn}}},
            {"Sid": "EfsCompatThisTicketsAccessPointOnly", "Effect": "Allow",
             "Action": ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"],
             "Resource": "*", "Condition": {"StringEquals": {"elasticfilesystem:AccessPointArn": ap_arn}}},
            {"Sid": "DiscoverMountTargets", "Effect": "Allow", "Action": "elasticfilesystem:DescribeMountTargets", "Resource": "*"},
        ],
    }, separators=(",", ":"))


def _item(raw: dict[str, Any]) -> dict[str, Any]:
    return {k: (int(v["N"]) if "N" in v else next(iter(v.values()))) for k, v in raw.items()}


class Broker:
    def __init__(self, *, verifier: TicketTokenVerifier, ddb: Any, sts: Any, table: str, file_system_id: str, mount_role_arn: str,
                 region: str, account: str, ttl: int = 3600) -> None:
        self.verifier, self.ddb, self.sts = verifier, ddb, sts
        self.table, self.fs, self.role, self.region, self.account, self.ttl = table, file_system_id, mount_role_arn, region, account, ttl

    def lookup(self, claims: dict[str, Any]) -> dict[str, Any]:
        raw = self.ddb.get_item(TableName=self.table, Key={"ticketKey": {"S": claims["sub"]}}, ConsistentRead=True).get("Item")
        if not raw:
            raise Unauthorized("no storage provisioned for this ticket")
        rec = _item(raw)
        if rec.get("status") != "active":
            raise Unauthorized(f"ticket storage is {rec.get('status')}")
        expected = {"tenantId": claims["tid"], "cellId": claims["cid"], "ticketId": claims["tkt"],
                    "runtimeSessionId": claims["rsid"], "fileSystemId": self.fs}
        if any(rec.get(k) != v for k, v in expected.items()):
            raise Unauthorized("storage record does not match this ticket")
        return rec

    def mint(self, ticket_key: str, ap_arn: str) -> dict[str, str]:
        creds = self.sts.assume_role(RoleArn=self.role, RoleSessionName=f"tkt-{ticket_key}", SourceIdentity=ticket_key,
                                     Policy=session_policy(ap_arn), DurationSeconds=self.ttl)["Credentials"]
        expiration = creds["Expiration"]
        return {"AccessKeyId": creds["AccessKeyId"], "SecretAccessKey": creds["SecretAccessKey"], "SessionToken": creds["SessionToken"],
                "Expiration": expiration.isoformat() if hasattr(expiration, "isoformat") else str(expiration)}

    def __call__(self, token: str) -> dict[str, Any]:
        try:
            claims = self.verifier.verify(token)
        except InvalidToken as error:
            raise Unauthorized(str(error)) from error
        rec = self.lookup(claims)
        ap_arn = access_point_arn(self.region, self.account, self.fs, rec["accessPointId"])
        return {"ticketKey": rec["ticketKey"], "fileSystemId": self.fs, "accessPointId": rec["accessPointId"], "accessPointArn": ap_arn,
                "rootPath": rec["rootPath"], "posixUid": int(rec["posixUid"]), "posixGid": int(rec["posixGid"]),
                "credentials": self.mint(rec["ticketKey"], ap_arn)}


_broker: Broker | None = None


def _default() -> Broker:
    global _broker
    if _broker is None:
        region = os.environ["AWS_REGION"]
        key_id = os.environ["TICKET_KEY_ID"]
        sts = boto3.client("sts", region_name=region)
        _broker = Broker(verifier=TicketTokenVerifier(KmsPublicKeys(boto3.client("kms", region_name=region), key_id)),
                         ddb=boto3.client("dynamodb", region_name=region), sts=sts, table=os.environ["TICKET_STORAGE_TABLE"],
                         file_system_id=os.environ["FILE_SYSTEM_ID"], mount_role_arn=os.environ["SESSION_MOUNT_ROLE_ARN"],
                         region=region, account=os.environ.get("ACCOUNT_ID") or sts.get_caller_identity()["Account"],
                         ttl=int(os.environ.get("CRED_TTL_SECONDS", "3600")))
    return _broker


def handler(event: Any, _context: Any = None, broker: Broker | None = None) -> dict[str, Any]:
    token = event.get("token") if isinstance(event, dict) else None
    if not isinstance(token, str) or not token:
        return {"error": "unauthorized: missing token"}
    try:
        result = (broker or _default())(token)
    except Unauthorized as error:
        print(json.dumps({"event": "rejected", "reason": str(error)}))
        return {"error": f"unauthorized: {error}"}
    except Exception as error:  # noqa: BLE001 - fail closed with a plain answer, never a Lambda error with a trace
        code = (getattr(error, "response", None) or {}).get("Error", {}).get("Code", "")
        print(json.dumps({"event": "broker_failed", "type": type(error).__name__, "code": code, "error": str(error)[:300]}))
        return {"error": f"unauthorized: broker unavailable ({type(error).__name__}{': ' + code if code else ''})"}
    print(json.dumps({"event": "minted", "ticketKey": result["ticketKey"], "accessPointId": result["accessPointId"],
                      "expiration": result["credentials"]["Expiration"]}))
    return result
