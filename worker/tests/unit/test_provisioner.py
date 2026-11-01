import dshsa_contracts as contracts
import pytest
from conftest import CELL, TICKET, FakeDdb

from dshsa_worker.provisioner import Provisioner, handler

TABLE = "dshsa-ticket-storage"
FS = "fs-0123456789abcdef0"
KEY = contracts.ticket_key(CELL, TICKET)
EVENT = {"action": "ensure", "tenantId": "acme", "cellId": CELL, "ticketId": TICKET}


class NotFound(Exception):
    pass


class FakeS3Files:
    class exceptions:  # noqa: N801 - botocore shape
        ResourceNotFoundException = NotFound

    def __init__(self):
        self.created, self.deleted, self.aps = [], [], {}

    def create_access_point(self, **kwargs):
        self.created.append(kwargs)
        ap = f"fsap-{len(self.created):04d}"
        self.aps[ap] = "creating"
        return {"accessPointId": ap, "status": "creating"}

    def get_access_point(self, accessPointId):  # noqa: N803
        if accessPointId not in self.aps:
            raise NotFound()
        state = self.aps[accessPointId]
        self.aps[accessPointId] = "available"
        return {"accessPointId": accessPointId, "status": state}

    def delete_access_point(self, accessPointId):  # noqa: N803
        self.deleted.append(accessPointId)
        self.aps.pop(accessPointId, None)


def make():
    s3files, ddb = FakeS3Files(), FakeDdb()
    return Provisioner(s3files=s3files, ddb=ddb, table=TABLE, file_system_id=FS, sleep=lambda _s: None), s3files, ddb


def test_ensure_creates_ap_with_ticket_root_and_posix_user():
    prov, s3files, ddb = make()
    rec = handler(EVENT, provisioner=prov)
    call = s3files.created[0]
    assert call["clientToken"] == KEY and call["fileSystemId"] == FS
    assert call["posixUser"] == {"uid": 1000, "gid": 1000}
    assert call["rootDirectory"] == {"path": contracts.access_point_root("acme", CELL, TICKET),
                                     "creationPermissions": {"ownerUid": 1000, "ownerGid": 1000, "permissions": "0700"}}
    assert {"key": "dshsa:managed", "value": "true"} in call["tags"]
    assert rec["ok"] is True and rec["status"] == "active" and rec["runtimeSessionId"] == contracts.runtime_session_id(CELL, TICKET)
    assert ddb.calls[-1][0] == "put_item" and "ConditionExpression" in ddb.calls[-1][1]


def test_ensure_is_idempotent():
    prov, s3files, _ = make()
    first = handler(EVENT, provisioner=prov)
    second = handler(EVENT, provisioner=prov)
    assert first["accessPointId"] == second["accessPointId"] and len(s3files.created) == 1


def test_ensure_recreates_when_ap_vanished():
    prov, s3files, _ = make()
    first = handler(EVENT, provisioner=prov)
    s3files.aps.clear()
    second = handler(EVENT, provisioner=prov)
    assert second["accessPointId"] != first["accessPointId"] and second["createdAt"] == first["createdAt"]


def test_disable_then_ensure_refuses_and_delete_removes_ap():
    prov, s3files, _ = make()
    rec = handler(EVENT, provisioner=prov)
    assert handler({**EVENT, "action": "disable"}, provisioner=prov)["status"] == "disabled"
    assert handler(EVENT, provisioner=prov)["error"] == "bad_request"
    assert handler({**EVENT, "action": "delete"}, provisioner=prov)["status"] == "deleted"
    assert s3files.deleted == [rec["accessPointId"]]


@pytest.mark.parametrize("event", [
    {"action": "ensure", "tenantId": "beta", "cellId": CELL, "ticketId": TICKET},
    {"action": "ensure", "tenantId": "acme", "cellId": "bad cell", "ticketId": TICKET},
    {"action": "ensure", "tenantId": "acme", "cellId": CELL},
    {"action": "explode", "tenantId": "acme", "cellId": CELL, "ticketId": TICKET},
    {**EVENT, "ticketKey": "0" * 32},
    {**EVENT, "rootPath": "/tenants/acme/cells/x"},
])
def test_bad_requests(event):
    prov, s3files, _ = make()
    result = handler(event, provisioner=prov)
    assert result["ok"] is False and result["error"] == "bad_request"
    assert not s3files.created


def test_accepts_matching_derived_ids_from_the_cell():
    prov, _, _ = make()
    event = {**EVENT, "ticketKey": KEY, "runtimeSessionId": contracts.runtime_session_id(CELL, TICKET),
             "rootPath": contracts.access_point_root("acme", CELL, TICKET)}
    assert handler(event, provisioner=prov)["ok"] is True


def test_root_path_fits_the_s3files_access_point_pattern():
    from dshsa_worker.provisioner import AP_PATH_RE, MAX_AP_PATH_COMPONENTS
    root = contracts.access_point_root("acme", CELL, TICKET)
    assert len([p for p in root.split("/") if p]) <= MAX_AP_PATH_COMPONENTS == 4
    assert AP_PATH_RE.match(root)
    prov, s3files, _ = make()
    handler(EVENT, provisioner=prov)
    assert AP_PATH_RE.match(s3files.created[0]["rootDirectory"]["path"])


@pytest.mark.parametrize("path", ["/tenants/a/b/c/d", "/tenants/.hidden", "/tenants/a;b", "tenants/a"])
def test_bad_root_paths_are_refused_before_the_api(path):
    from dshsa_worker.provisioner import BadRequest, check_root
    with pytest.raises(BadRequest):
        check_root(path)


def test_validation_exception_is_permanent_not_retryable():
    class Rejected(Exception):
        response = {"Error": {"Code": "ValidationException", "Message": "rootDirectory.path"}}
    prov, s3files, _ = make()

    def fail(**_kwargs):
        raise Rejected("rootDirectory.path must match")
    s3files.create_access_point = fail
    result = handler(EVENT, provisioner=prov)
    assert result["ok"] is False and result["error"] == "bad_request" and "ValidationException" in result["message"]


def test_throttling_is_internal_and_retryable():
    class Throttled(Exception):
        response = {"Error": {"Code": "ThrottlingException"}}
    prov, s3files, _ = make()

    def fail(**_kwargs):
        raise Throttled("slow down")
    s3files.create_access_point = fail
    assert handler(EVENT, provisioner=prov)["error"] == "internal"
