import json
from datetime import UTC, datetime

import dshsa_contracts as contracts
from conftest import CELL, TICKET, FakeDdb, ddb_item

from dshsa_worker.broker import Broker, handler, session_policy

TABLE = "dshsa-ticket-storage"
FS = "fs-0123456789abcdef0"
KEY = contracts.ticket_key(CELL, TICKET)


def record(**overrides):
    return {"ticketKey": KEY, "tenantId": "acme", "cellId": CELL, "ticketId": TICKET, "runtimeSessionId": contracts.runtime_session_id(CELL, TICKET),
            "fileSystemId": FS, "accessPointId": "fsap-0aaa", "rootPath": contracts.access_point_root("acme", CELL, TICKET), "posixUid": 1000,
            "posixGid": 1000, "status": "active", "createdAt": "2026-11-01T00:00:00+00:00", **overrides}


class FakeSts:
    def __init__(self):
        self.calls = []

    def assume_role(self, **kwargs):
        self.calls.append(kwargs)
        return {"Credentials": {"AccessKeyId": "ASIA", "SecretAccessKey": "s", "SessionToken": "t", "Expiration": datetime(2026, 11, 1, tzinfo=UTC)}}


def make(keys, rec=None):
    ddb = FakeDdb({TABLE: {KEY: ddb_item(rec or record())}})
    sts = FakeSts()
    broker = Broker(verifier=keys.verifier(), ddb=ddb, sts=sts, table=TABLE, file_system_id=FS, mount_role_arn="arn:aws:iam::1:role/dshsa-worker-mount",
                    region="us-west-2", account="123456789012")
    return broker, sts


def test_mints_credentials_scoped_to_the_ticket_ap(keys):
    broker, sts = make(keys)
    result = handler({"token": keys.token()}, broker=broker)
    assert result["accessPointId"] == "fsap-0aaa" and result["credentials"]["AccessKeyId"] == "ASIA"
    call = sts.calls[0]
    assert call["RoleSessionName"] == f"tkt-{KEY}" and call["SourceIdentity"] == KEY
    policy = json.loads(call["Policy"])
    arn = f"arn:aws:s3files:us-west-2:123456789012:file-system/{FS}/access-point/fsap-0aaa"
    assert policy["Statement"][0]["Condition"]["StringEquals"]["s3files:AccessPointArn"] == arn
    assert all(s["Action"] != "s3:*" for s in policy["Statement"])


def test_refuses_forged_token(keys):
    broker, sts = make(keys)
    assert handler({"token": keys.token(key=keys.other)}, broker=broker)["error"].startswith("unauthorized")
    assert not sts.calls


def test_refuses_missing_disabled_and_mismatched_storage(keys):
    assert "unauthorized" in handler({"token": keys.token()}, broker=make(keys, record(status="disabled"))[0])["error"]
    assert "unauthorized" in handler({"token": keys.token()}, broker=make(keys, record(fileSystemId="fs-other"))[0])["error"]
    assert "unauthorized" in handler({"token": keys.token()}, broker=make(keys, record(cellId="beta--gh1"))[0])["error"]
    broker, _ = make(keys)
    broker.ddb.tables[TABLE].clear()
    assert "no storage" in handler({"token": keys.token()}, broker=broker)["error"]


def test_missing_token():
    assert handler({}, broker=None)["error"] == "unauthorized: missing token"
    assert handler("nope", broker=None)["error"] == "unauthorized: missing token"


def test_session_policy_has_no_wildcard_allow():
    policy = json.loads(session_policy("arn:x"))
    for statement in policy["Statement"]:
        if statement["Sid"] != "DiscoverMountTargets":
            assert statement["Condition"]["StringEquals"]


def test_unexpected_failure_is_an_answer_not_a_lambda_error(keys):
    broker, sts = make(keys)

    def boom(**_kwargs):
        raise RuntimeError("sts endpoint unreachable")
    sts.assume_role = boom
    result = handler({"token": keys.token()}, broker=broker)
    assert result == {"error": "unauthorized: broker unavailable (RuntimeError)"}
