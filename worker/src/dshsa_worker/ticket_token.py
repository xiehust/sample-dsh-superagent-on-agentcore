"""Ticket token verification (design §4.3): JWS compact, ES256, signed by KMS `alias/dshsa-ticket-token`.

Used by the broker, worker-api and the in-VM gateway. The public key comes from `kms:GetPublicKey` once per key id and is
cached for the process lifetime: it is not secret, and a rotated key gets a new key id.
"""
from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Callable
from typing import Any

import dshsa_contracts as contracts
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature


class InvalidToken(Exception):
    """Any reason a ticket token is not acceptable. The message is safe to log; never echo the token itself."""


def _b64decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def jose_to_der(signature: bytes) -> bytes:
    if len(signature) != 64:
        raise InvalidToken("bad signature length")
    return encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"))


def der_to_jose(der: bytes) -> bytes:
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def decode(token: str) -> tuple[dict[str, Any], dict[str, Any], bytes, bytes]:
    """Split a compact JWS into (header, claims, signing input, raw signature) without verifying anything."""
    try:
        h, p, s = token.split(".")
        header, claims = json.loads(_b64decode(h)), json.loads(_b64decode(p))
        if not isinstance(header, dict) or not isinstance(claims, dict):
            raise ValueError
        return header, claims, f"{h}.{p}".encode(), _b64decode(s)
    except InvalidToken:
        raise
    except Exception as error:  # noqa: BLE001 - anything malformed is the same failure
        raise InvalidToken("malformed token") from error


class KmsPublicKeys:
    """Resolves a key id to its ECDSA P-256 public key through `kms:GetPublicKey`, caching each one."""

    def __init__(self, kms_client: Any, allowed_key_id: str | None = None) -> None:
        self._kms = kms_client
        self._allowed = allowed_key_id
        self._keys: dict[str, ec.EllipticCurvePublicKey] = {}
        self._lock = threading.Lock()

    def __call__(self, kid: str) -> ec.EllipticCurvePublicKey:
        with self._lock:
            if kid in self._keys:
                return self._keys[kid]
        # The kid is attacker-controlled: refuse a foreign one before it costs a KMS call (throttling, log noise).
        if self._allowed and kid.rsplit("/", 1)[-1] != self._allowed.rsplit("/", 1)[-1]:
            raise InvalidToken("token signed by an unexpected key")
        response = self._kms.get_public_key(KeyId=kid)
        key_id = response["KeyId"].rsplit("/", 1)[-1]
        if self._allowed and key_id != self._allowed.rsplit("/", 1)[-1]:
            raise InvalidToken("token signed by an unexpected key")
        if response.get("KeySpec") != "ECC_NIST_P256" or response.get("KeyUsage") != "SIGN_VERIFY":
            raise InvalidToken("unexpected key type")
        key = serialization.load_der_public_key(response["PublicKey"])
        if not isinstance(key, ec.EllipticCurvePublicKey):
            raise InvalidToken("unexpected key type")
        with self._lock:
            self._keys[kid] = key
        return key


class TicketTokenVerifier:
    """Checks the signature, then the claim semantics of `dshsa_contracts.check_claims` (iss, aud, ids, ttl, 60 s skew)."""

    def __init__(self, public_key: Callable[[str], ec.EllipticCurvePublicKey], clock: Callable[[], float] = time.time) -> None:
        self._public_key = public_key
        self._clock = clock

    def verify(self, token: str) -> contracts.TicketTokenClaims:
        header, claims, signing_input, signature = decode(token)
        if header.get("alg") != "ES256" or header.get("typ") != "JWT" or not isinstance(header.get("kid"), str):
            raise InvalidToken("bad token header")
        try:
            key = self._public_key(header["kid"])
        except InvalidToken:
            raise
        except Exception as error:  # noqa: BLE001 - KMS failures must not leak as 500s with details
            raise InvalidToken("signing key unavailable") from error
        try:
            key.verify(jose_to_der(signature), signing_input, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature as error:
            raise InvalidToken("bad signature") from error
        try:
            return contracts.check_claims(claims, int(self._clock()))
        except ValueError as error:
            raise InvalidToken(str(error)) from error


def sign(claims: dict[str, Any], private_key: ec.EllipticCurvePrivateKey, kid: str) -> str:
    """Test and tooling helper: sign `claims` the way the cell does with KMS (raw r||s signature)."""
    header = {"alg": "ES256", "typ": "JWT", "kid": kid}
    signing_input = f"{b64encode(json.dumps(header).encode())}.{b64encode(json.dumps(claims).encode())}"
    der = private_key.sign(signing_input.encode(), ec.ECDSA(hashes.SHA256()))
    return f"{signing_input}.{b64encode(der_to_jose(der))}"


def kms_sign(claims: dict[str, Any], kms_client: Any, key_id: str) -> str:
    """Tooling helper (deployed tests): sign with KMS, exactly as packages/cell does."""
    meta = kms_client.describe_key(KeyId=key_id)["KeyMetadata"]
    header = {"alg": "ES256", "typ": "JWT", "kid": meta["KeyId"]}
    signing_input = f"{b64encode(json.dumps(header).encode())}.{b64encode(json.dumps(claims).encode())}"
    der = kms_client.sign(KeyId=meta["KeyId"], Message=signing_input.encode(), MessageType="RAW", SigningAlgorithm="ECDSA_SHA_256")["Signature"]
    return f"{signing_input}.{b64encode(der_to_jose(der))}"


def claims_for(cell_id: str, ticket_id: str, assignment_id: str, ttl: int = 3600, now: int | None = None) -> dict[str, Any]:
    """Build a consistent claim set for (cell, ticket, assignment), as the cell does."""
    issued = int(time.time()) if now is None else now
    return {"iss": contracts.TOKEN_ISSUER, "aud": contracts.TOKEN_AUDIENCE, "sub": contracts.ticket_key(cell_id, ticket_id),
            "tid": contracts.tenant_of_cell(cell_id), "cid": cell_id, "tkt": ticket_id, "asg": assignment_id,
            "rsid": contracts.runtime_session_id(cell_id, ticket_id), "iat": issued, "exp": issued + ttl,
            "jti": b64encode(f"{ticket_id}:{assignment_id}:{issued}".encode())[:24]}
