import json
import pathlib

import dshsa_contracts as c

VECTORS = json.loads((pathlib.Path(__file__).parent.parent / "tests" / "vectors.json").read_text())


def test_vectors_match_ts():
    for v in VECTORS["cases"]:
        cell = c.cell_id(v["tenantId"], v["githubRepoId"])
        assert cell == v["cellId"]
        assert c.ticket_key(cell, v["ticketId"]) == v["ticketKey"]
        assert c.runtime_session_id(cell, v["ticketId"]) == v["runtimeSessionId"]
        assert c.access_point_root(v["tenantId"], cell, v["ticketId"]) == v["accessPointRoot"]
        assert len([x for x in v["accessPointRoot"].split("/") if x]) <= c.MAX_AP_PATH_COMPONENTS
        assert c.ticket_data_prefix(v["tenantId"], cell, v["ticketId"]) == v["accessPointRoot"][1:] + "/"


def _claims(**over):
    v = VECTORS["cases"][0]
    base = dict(iss="dshsa-cp", aud="dshsa-worker", sub=v["ticketKey"], tid=v["tenantId"], cid=v["cellId"], tkt=v["ticketId"],
                asg="a", rsid=v["runtimeSessionId"], iat=1000, exp=4600, jti="jti-12345678")
    base.update(over)
    return base


def test_claims():
    assert c.check_claims(_claims(), 2000)["tid"] == "acme"
    for bad in (_claims(aud="x"), _claims(exp=1000 + 3 * 3600), _claims(sub="0" * 32), _claims(tid="beta-team")):
        try:
            c.check_claims(bad, 2000)
            raise AssertionError("should fail")
        except ValueError:
            pass
    try:
        c.check_claims(_claims(), 4600 + 61)
        raise AssertionError("expired")
    except ValueError:
        pass


def test_invocation_responses_match_ts():
    g = VECTORS["invocationResponses"]
    for case in g["cases"]:
        version = None if case.get("legacy") else g["workerVersion"]
        kind, *args = case["call"]
        built = c.ok_response(*args, worker_version=version) if kind == "ok" else c.error_response(*args, worker_version=version)
        assert built == case["response"]
    assert c.WORKER_VERSION_PARAMETER.startswith("/dshsa-") and c.WORKER_VERSION_FIELD == "workerVersion"
