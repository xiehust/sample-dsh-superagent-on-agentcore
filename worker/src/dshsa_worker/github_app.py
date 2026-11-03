"""GitHub App helpers for worker-api: the app JWT (RS256), installation tokens scoped to one repository, and repo reads."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from dshsa_worker.ticket_token import b64encode

API = "https://api.github.com"
WRITE_PERMISSIONS = {"contents": "write", "pull_requests": "write", "issues": "write"}
# Asked for only when the installation itself grants them (the App owner opted in): `workflows` lets a worker push changes under
# .github/workflows, which GitHub refuses without it. Requesting a permission the installation lacks would fail the whole token.
OPTIONAL_WRITE_PERMISSIONS = {"workflows": "write"}
READ_PERMISSIONS = {"contents": "read", "pull_requests": "read", "issues": "read"}


class GithubError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def app_jwt(app_id: str | int, private_key_pem: str, now: int | None = None) -> str:
    issued = int(time.time()) if now is None else now
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {"iat": issued - 60, "exp": issued + 540, "iss": str(app_id)}
    signing_input = f"{b64encode(json.dumps(header).encode())}.{b64encode(json.dumps(claims).encode())}"
    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)
    signature = key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())  # type: ignore[call-arg]
    return f"{signing_input}.{b64encode(signature)}"


def _request(method: str, url: str, token: str, body: dict[str, Any] | None = None, timeout: float = 15) -> tuple[int, bytes, str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "dshsa-worker-api", **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https host
            return resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "application/json")


class GithubApp:
    def __init__(self, app_id: str | int, private_key_pem: str, request=_request) -> None:
        self.app_id, self.key, self.request = app_id, private_key_pem, request

    def granted(self, installation_id: int) -> dict[str, str]:
        """The permissions the installation grants (`GET /app/installations/{id}`); empty when GitHub does not say."""
        status, body, _ = self.request("GET", f"{API}/app/installations/{int(installation_id)}", app_jwt(self.app_id, self.key))
        if status != 200:
            return {}
        value = json.loads(body).get("permissions")
        return {str(k): str(v) for k, v in value.items()} if isinstance(value, dict) else {}

    def installation_token(self, installation_id: int, repo_id: int, permissions: dict[str, str],
                           optional: dict[str, str] | None = None) -> dict[str, str]:
        """A token for one repository with `permissions`, plus each of `optional` the installation grants at that level."""
        if optional:
            granted = self.granted(installation_id)
            permissions = {**permissions, **{k: v for k, v in optional.items() if granted.get(k) == v or (v == "read" and granted.get(k) == "write")}}
        status, body, _ = self.request("POST", f"{API}/app/installations/{int(installation_id)}/access_tokens", app_jwt(self.app_id, self.key),
                                       {"repository_ids": [int(repo_id)], "permissions": permissions})
        if status != 201:
            raise GithubError(502, f"installation token failed ({status})")
        data = json.loads(body)
        return {"token": data["token"], "expiresAt": data["expires_at"]}


def safe_repo_path(path: str) -> str:
    """A path relative to /repos/{owner}/{name}/, with its query; refuses traversal, absolute URLs and odd characters."""
    if not path or path.startswith("/") or "://" in path or "\\" in path:
        raise GithubError(403, "resource must be a repo-relative path")
    route, _, query = path.partition("?")
    segments = route.split("/")
    decoded = [urllib.parse.unquote(seg) for seg in segments]
    if any(seg in ("", ".", "..") for seg in segments) or any(seg in (".", "..") or "/" in seg or "\\" in seg for seg in decoded):
        raise GithubError(403, "resource must be a repo-relative path")
    if any(not all(c.isalnum() or c in "-_.%@+=:,~" for c in seg) for seg in segments):
        raise GithubError(403, "unsupported characters in resource path")
    if query and any(not (c.isalnum() or c in "=&-_.%+,:") for c in query):
        raise GithubError(403, "unsupported characters in resource query")
    return route + (f"?{query}" if query else "")


def read_repo(token: str, owner: str, name: str, path: str, request=_request) -> tuple[str, str]:
    url = f"{API}/repos/{urllib.parse.quote(owner)}/{urllib.parse.quote(name)}/{safe_repo_path(path)}"
    status, body, media = request("GET", url, token)
    if status >= 400:
        raise GithubError(404 if status == 404 else 502, f"github read failed ({status})")
    return body.decode("utf-8", errors="replace"), media
