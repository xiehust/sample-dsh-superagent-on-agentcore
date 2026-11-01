import io
import json
import pathlib
import time
import urllib.error
from datetime import datetime

import dshsa_contracts as contracts
import pytest
from conftest import ASSIGNMENT, CELL, TICKET, FakeDdb, ddb_item

from dshsa_worker.github_app import GithubError, safe_repo_path
from dshsa_worker.worker_api import WorkerApi, envelope_id, handler

KEY = contracts.ticket_key(CELL, TICKET)
TABLES = {"ticketStorage": "dshsa-ticket-storage", "cells": "dshsa-cells", "leases": "dshsa-leases"}
STS = "https://sts.ap-northeast-1.amazonaws.com/?Action=GetCallerIdentity"
GOLDEN = json.loads((pathlib.Path(contracts.__file__).parent.parent / "tests" / "vectors.json").read_text())["workerEventEnvelope"]
QUEUE = "https://sqs.us-west-2.amazonaws.com/123456789012/dshsa-cell-acme--gh812345.fifo"


class FakeSqs:
    def __init__(self):
        self.sent = []

    def send_message(self, **kwargs):
        self.sent.append(kwargs)
        return {"MessageId": "m"}


class FakeSecrets:
    def get_secret_value(self, SecretId):  # noqa: N803
        assert SecretId == "gh"
        return {"SecretString": json.dumps({"appId": "123", "privateKey": "PEM"})}


class FakeApp:
    calls = []

    def __init__(self, app_id, key):
        self.app_id = app_id

    def installation_token(self, installation_id, repo_id, permissions):
        FakeApp.calls.append((installation_id, repo_id, permissions))
        return {"token": "ghs_x", "expiresAt": "2026-11-01T01:00:00Z"}


class FakeHttp:
    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.requests = answer, error, []

    def __call__(self, req, timeout):
        self.requests.append(req)
        if self.error:
            raise self.error
        return io.BytesIO(json.dumps(self.answer).encode())


def make(keys, *, storage_status="active", lease=None, http=None, reader=None):
    storage = {"ticketKey": KEY, "tenantId": "acme", "cellId": CELL, "ticketId": TICKET, "status": storage_status}
    cell = {"cellId": CELL, "tenantId": "acme", "queueUrl": QUEUE, "status": "active",
            "repo": {"owner": "acme", "name": "app", "id": 812345, "installationId": 99, "defaultBranch": "main"}}
    tables = {"dshsa-ticket-storage": {KEY: ddb_item(storage)}, "dshsa-cells": {CELL: ddb_item(cell)}, "dshsa-leases": {}}
    if lease:
        tables["dshsa-leases"][f"cell#{CELL}"] = ddb_item(lease)
    sqs = FakeSqs()
    api = WorkerApi(verifier=keys.verifier(), ddb=FakeDdb(tables), sqs=sqs, secrets=FakeSecrets(), tables=TABLES, github_secret_arn="gh",
                    caller=lambda cell: f"{STS}&target={cell}", http=http or FakeHttp(), github_factory=FakeApp,
                    repo_reader=reader or (lambda token, owner, name, path: (f"{owner}/{name}/{path}", "application/json")))
    return api, sqs


def call(api, path, body, token):
    # As API Gateway REST sends it: `path` without the stage, `requestContext.path` with it.
    event = {"httpMethod": "POST", "path": path, "requestContext": {"stage": "v1", "path": f"/v1{path}"},
             "headers": {"Authorization": f"Bearer {token}"}, "body": json.dumps(body)}
    response = handler(event, api=api)
    return response["statusCode"], json.loads(response["body"])


def event(kind="report", body=None, **overrides):
    return {"id": "e1", "ticketKey": KEY, "assignmentId": ASSIGNMENT, "at": "2026-11-01T00:00:00Z", "type": kind,
            "body": body if body is not None else {"state": "progress", "text": "working"}, **overrides}


def test_event_is_enqueued_with_verified_scope(keys):
    api, sqs = make(keys)
    status, body = call(api, "/v1/events", event(), keys.token())
    assert (status, body) == (200, {"ok": True})
    message = sqs.sent[0]
    assert message["QueueUrl"] == QUEUE and message["MessageGroupId"] == CELL
    envelope = json.loads(message["MessageBody"])
    assert envelope["type"] == "worker.event" and envelope["cellId"] == CELL
    assert envelope["body"]["verified"] == {"tid": "acme", "cid": CELL, "tkt": TICKET, "asg": ASSIGNMENT}
    # WorkerEventBody is exactly {event, verified}: the event is nested, never spread into the body.
    assert set(envelope["body"]) == {"event", "verified"}
    assert envelope["body"]["event"]["id"] == "e1" and envelope["body"]["event"]["type"] == "report"
    assert message["MessageDeduplicationId"] == envelope["id"] == envelope_id(KEY, "e1")


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["event"]["type"])
def test_event_envelope_matches_the_golden_contract_vector(keys, case):
    # Cross-language guard: packages/contracts/tests/contracts.spec.ts parses the same envelopes with the TS CellEnvelope.
    assert GOLDEN["claims"] == {"sub": KEY, "tid": "acme", "cid": CELL, "tkt": TICKET, "asg": ASSIGNMENT}
    api, sqs = make(keys)
    status, body = call(api, "/v1/events", case["event"], keys.token())
    assert (status, body) == (200, {"ok": True})
    message = sqs.sent[0]
    envelope = json.loads(message["MessageBody"])
    assert datetime.fromisoformat(envelope.pop("at")).tzinfo is not None
    expected = {k: v for k, v in case["envelope"].items() if k != "at"}
    assert envelope == expected
    assert message["MessageGroupId"] == CELL and message["MessageDeduplicationId"] == expected["id"]
    # Same derivation as TS envelopeId.worker(ticketKey, eventId): `we-` + sha256(f"{ticketKey}/{eventId}")[:40].
    assert envelope_id(GOLDEN["claims"]["sub"], case["event"]["id"]) == expected["id"]


def test_event_retries_dedup_to_the_same_id(keys):
    api, sqs = make(keys)
    call(api, "/v1/events", event(), keys.token())
    call(api, "/v1/events", event(), keys.token())
    assert sqs.sent[0]["MessageDeduplicationId"] == sqs.sent[1]["MessageDeduplicationId"]


def test_event_for_other_ticket_or_assignment_is_refused(keys):
    api, sqs = make(keys)
    assert call(api, "/v1/events", event(ticketKey="f" * 32), keys.token())[0] == 403
    assert call(api, "/v1/events", event(assignmentId="assignment-1"), keys.token())[0] == 409
    assert not sqs.sent


@pytest.mark.parametrize("bad", [
    event(kind="explode"), event(body={"state": "victory", "text": ""}), event(kind="ack", body={}),
    event(kind="handback", body={"triggerIds": ["t"]}), {"id": "x"},
    event(kind="ack", body={"text": "ok"}), event(kind="thread.follow", body={"thread": "nokey", "reason": "r"}),
    event(kind="thread.unrelated", body={"thread": "github:1"}), event(body={"state": "progress", "text": "", "prNumber": 0}),
])
def test_malformed_events(keys, bad):
    api, sqs = make(keys)
    assert call(api, "/v1/events", bad, keys.token())[0] == 400
    assert not sqs.sent


def test_auth_failures(keys):
    api, _ = make(keys)
    assert call(api, "/v1/events", event(), keys.token(key=keys.other))[0] == 401
    assert call(api, "/v1/events", event(), keys.token(iat=int(time.time()) - 7200, exp=int(time.time()) - 3600))[0] == 401
    response = handler({"httpMethod": "POST", "path": "/v1/events", "headers": {}, "body": "{}"}, api=api)
    assert response["statusCode"] == 401
    disabled, _ = make(keys, storage_status="disabled")
    assert call(disabled, "/v1/events", event(), keys.token())[0] == 401


def test_github_credentials_are_scoped_to_the_cell_repo(keys):
    api, _ = make(keys)
    FakeApp.calls.clear()
    status, body = call(api, "/v1/credentials/github", {"repo": "someone/else"}, keys.token())
    assert status == 200 and body["token"] == "ghs_x"
    assert FakeApp.calls[0][:2] == (99, 812345) and FakeApp.calls[0][2]["contents"] == "write"


def test_read_github_and_feishu(keys):
    api, _ = make(keys)
    status, body = call(api, "/v1/read", {"resource": "github/issues/12/comments"}, keys.token())
    assert status == 200 and body["content"] == "acme/app/issues/12/comments"
    assert call(api, "/v1/read", {"resource": "s3://bucket"}, keys.token())[0] == 400


@pytest.mark.parametrize("path", ["../other/repo", "/etc/passwd", "https://evil.example/x", "issues/%2e%2e/x", "a//b", "contents/a b",
                                  "contents%2F..%2F..%2Fusers%2Fx", "contents/%5c..%5cx"])
def test_repo_path_sanitization(path):
    with pytest.raises(GithubError):
        safe_repo_path(path)


def test_repo_path_allows_normal_routes():
    assert safe_repo_path("pulls/3/comments?per_page=50&page=2") == "pulls/3/comments?per_page=50&page=2"


def test_token_refresh_goes_to_the_lease_owner(keys):
    lease = {"leaseKey": f"cell#{CELL}", "owner": "task", "endpoint": "http://10.0.1.5:8080", "fence": 3, "expiresAt": int(time.time() * 1000) + 20000}
    http = FakeHttp(answer={"token": "new"})
    api, _ = make(keys, lease=lease, http=http)
    status, body = call(api, "/v1/token/refresh", {}, keys.token())
    assert (status, body) == (200, {"token": "new"})
    req = http.requests[0]
    assert req.full_url == f"http://10.0.1.5:8080/{CELL}/worker/token-refresh"
    assert req.get_header("X-dshsa-caller").endswith(f"target={CELL}") and req.get_header("X-dshsa-target") == CELL
    assert req.get_header("X-dshsa-internal") is None
    assert json.loads(req.data)["claims"]["asg"] == ASSIGNMENT


def test_token_refresh_without_live_lease_is_503(keys):
    api, _ = make(keys)
    assert call(api, "/v1/token/refresh", {}, keys.token())[0] == 503
    expired = {"leaseKey": f"cell#{CELL}", "owner": "t", "endpoint": "http://x:8080", "fence": 1, "expiresAt": 1}
    api, _ = make(keys, lease=expired)
    assert call(api, "/v1/token/refresh", {}, keys.token())[0] == 503


def test_token_refresh_refused_by_cell_is_409(keys):
    lease = {"leaseKey": f"cell#{CELL}", "owner": "t", "endpoint": "http://x:8080", "fence": 1, "expiresAt": int(time.time() * 1000) + 9000}
    error = urllib.error.HTTPError("u", 409, "not running", {}, io.BytesIO(b""))
    api, _ = make(keys, lease=lease, http=FakeHttp(error=error))
    assert call(api, "/v1/token/refresh", {}, keys.token())[0] == 409


def test_unknown_route_and_method(keys):
    api, _ = make(keys)
    assert handler({"httpMethod": "POST", "path": "/v1/nope", "headers": {}}, api=api)["statusCode"] == 404
    assert handler({"httpMethod": "GET", "path": "/v1/events", "headers": {}}, api=api)["statusCode"] == 405


def test_ticket_token_header_behind_sigv4(keys):
    api, sqs = make(keys)
    response = handler({"httpMethod": "POST", "path": "/v1/events", "headers": {"Authorization": "AWS4-HMAC-SHA256 Credential=x",
                        "X-Dshsa-Ticket-Token": keys.token()}, "body": json.dumps(event())}, api=api)
    assert response["statusCode"] == 200 and sqs.sent


def test_v2_fields_pass_through(keys):
    api, sqs = make(keys)
    body = {"state": "ready", "text": "done", "question": None, "askedBy": "t1", "answers": "t2", "prNumber": 7}
    assert call(api, "/v1/events", event(body=body), keys.token())[0] == 200
    assert json.loads(sqs.sent[0]["MessageBody"])["body"]["event"]["body"] == body
    assert call(api, "/v1/events", event(kind="ack", body={"text": "on it", "triggerId": "t1"}, id="e2"), keys.token())[0] == 200


def live_lease():
    return {"leaseKey": f"cell#{CELL}", "owner": "t", "endpoint": "http://10.0.1.5:8080", "fence": 1, "expiresAt": int(time.time() * 1000) + 20000}


def test_feishu_read_is_proxied_to_the_cell(keys):
    http = FakeHttp(answer={"ok": True, "content": "[messages]", "mediaType": "application/json"})
    api, _ = make(keys, lease=live_lease(), http=http)
    status, body = call(api, "/v1/read", {"resource": "feishu/trig-1/thread"}, keys.token())
    assert (status, body["content"]) == (200, "[messages]")
    req = http.requests[0]
    assert req.full_url == f"http://10.0.1.5:8080/{CELL}/worker/read"
    assert json.loads(req.data) == {"claims": {"sub": KEY, "tid": "acme", "cid": CELL, "tkt": TICKET, "asg": ASSIGNMENT,
                                               "rsid": contracts.runtime_session_id(CELL, TICKET)}, "resource": "feishu/trig-1/thread"}


def test_feishu_read_refused_by_cell(keys):
    api, _ = make(keys, lease=live_lease(), http=FakeHttp(answer={"ok": False, "error": "forbidden", "message": "chat not bound"}))
    assert call(api, "/v1/read", {"resource": "feishu/trig-1/thread"}, keys.token())[0] == 403
    api, _ = make(keys)
    assert call(api, "/v1/read", {"resource": "feishu/trig-1/thread"}, keys.token())[0] == 503


def test_presigned_caller_signs_the_target():
    import urllib.parse

    from botocore.credentials import Credentials

    from dshsa_worker.worker_api import presigned_caller
    url = presigned_caller("ap-northeast-1", CELL, Credentials("AKIDEXAMPLE", "secret"))
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qs(parts.query)
    assert parts.netloc == "sts.ap-northeast-1.amazonaws.com" and query["Action"] == ["GetCallerIdentity"]
    assert query["X-Amz-Expires"] == ["60"] and "x-dshsa-target" in query["X-Amz-SignedHeaders"][0]


def test_feishu_unavailable_maps_to_503(keys):
    api, _ = make(keys, lease=live_lease(), http=FakeHttp(answer={"ok": False, "error": "unavailable", "message": "feishu 5xx"}))
    status, body = call(api, "/v1/read", {"resource": "feishu/trig-1/thread"}, keys.token())
    assert (status, body["error"]) == (503, "unavailable")


def test_request_log_line_has_no_token(keys, capsys):
    api, _ = make(keys)
    token = keys.token()
    handler({"httpMethod": "POST", "path": "/v1/events", "headers": {"X-Dshsa-Ticket-Token": token}, "body": json.dumps(event()),
             "requestContext": {"requestId": "req-1", "identity": {"userArn": "arn:aws:sts::1:assumed-role/dshsa-worker-runtime/x", "vpceId": "vpce-1"}}},
            api=api)
    out = capsys.readouterr().out
    line = json.loads([row for row in out.splitlines() if "\"event\": \"request\"" in row][-1])
    assert line["requestId"] == "req-1" and line["status"] == 200 and line["ticketKey"] == KEY and line["callerArn"].endswith("/x")
    assert token not in out and token.split(".")[2] not in out


def test_stage_prefixed_paths_still_route(keys):
    api, sqs = make(keys)
    for path in ("/v1/events", "/v1/v1/events"):
        response = handler({"httpMethod": "POST", "path": path, "requestContext": {"stage": "v1"},
                            "headers": {"X-Dshsa-Ticket-Token": keys.token()}, "body": json.dumps(event(id=path))}, api=api)
        assert response["statusCode"] == 200, path


def test_unexpected_failure_is_a_json_500(keys):
    api, sqs = make(keys)

    def boom(**_kwargs):
        raise RuntimeError("sqs down")
    sqs.send_message = boom
    status, body = call(api, "/v1/events", event(), keys.token())
    assert status == 500 and body == {"ok": False, "error": "internal", "message": "RuntimeError"}
