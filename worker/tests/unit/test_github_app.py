import json

import pytest

from dshsa_worker import github_app
from dshsa_worker.github_app import OPTIONAL_WRITE_PERMISSIONS, WRITE_PERMISSIONS, GithubApp


def fake(installation_permissions, status=200):
    calls = []

    def request(method, url, token, body=None, timeout=15):
        calls.append((method, url, body))
        if method == "GET":
            return status, json.dumps({"permissions": installation_permissions}).encode(), "application/json"
        return 201, json.dumps({"token": "ghs_x", "expires_at": "2026-11-03T16:00:00Z"}).encode(), "application/json"
    return calls, request


@pytest.fixture(autouse=True)
def no_jwt(monkeypatch):
    monkeypatch.setattr(github_app, "app_jwt", lambda *_a, **_k: "jwt")  # no key needed for the request shape


def app(request):
    return GithubApp("1", "PEM", request=request)


def test_workflows_is_requested_when_the_installation_grants_it():
    calls, request = fake({"contents": "write", "workflows": "write"})
    app(request).installation_token(7, 9, WRITE_PERMISSIONS, OPTIONAL_WRITE_PERMISSIONS)
    assert calls[-1][2]["permissions"] == {**WRITE_PERMISSIONS, "workflows": "write"}


def test_workflows_is_left_out_when_the_installation_lacks_it_or_github_does_not_say():
    for granted, status in (({"contents": "write"}, 200), ({"workflows": "read"}, 200), ({}, 404)):
        calls, request = fake(granted, status)
        app(request).installation_token(7, 9, WRITE_PERMISSIONS, OPTIONAL_WRITE_PERMISSIONS)
        assert calls[-1][2]["permissions"] == WRITE_PERMISSIONS


def test_no_optional_means_no_installation_lookup():
    calls, request = fake({"workflows": "write"})
    app(request).installation_token(7, 9, WRITE_PERMISSIONS)
    assert [c[0] for c in calls] == ["POST"]
