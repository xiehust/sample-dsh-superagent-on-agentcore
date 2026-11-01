import time

import dshsa_contracts as contracts
import pytest
from conftest import ASSIGNMENT, CELL, TICKET
from cryptography.hazmat.primitives import serialization

from dshsa_worker import ticket_token
from dshsa_worker.ticket_token import InvalidToken, KmsPublicKeys


def test_valid_token_verifies(keys):
    claims = keys.verifier().verify(keys.token())
    assert claims["sub"] == contracts.ticket_key(CELL, TICKET)
    assert claims["asg"] == ASSIGNMENT


@pytest.mark.parametrize("mutate,reason", [
    (lambda k: k.token(key=k.other), "bad signature"),
    (lambda k: k.token(kid="other-kid"), "unexpected key"),
    (lambda k: k.token(aud="someone-else"), "bad iss/aud"),
    (lambda k: k.token(iss="evil"), "bad iss/aud"),
    (lambda k: k.token(sub="0" * 32), "inconsistent ids"),
    (lambda k: k.token(tid="other"), "inconsistent ids"),
    (lambda k: k.token(iat=int(time.time()) - 7300, exp=int(time.time()) - 100), "expired"),
    (lambda k: k.token(exp=int(time.time()) + 3 * 3600), "bad ttl"),
])
def test_bad_tokens_are_refused(keys, mutate, reason):
    with pytest.raises(InvalidToken, match=reason):
        keys.verifier().verify(mutate(keys))


def test_tampered_payload_is_refused(keys):
    header, payload, sig = keys.token().split(".")
    forged = ticket_token.b64encode(b'{"iss":"dshsa-cp"}')
    with pytest.raises(InvalidToken):
        keys.verifier().verify(f"{header}.{forged}.{sig}")


def test_alg_none_is_refused(keys):
    header = ticket_token.b64encode(b'{"alg":"none","typ":"JWT","kid":"x"}')
    payload = keys.token().split(".")[1]
    with pytest.raises(InvalidToken, match="header"):
        keys.verifier().verify(f"{header}.{payload}.")


@pytest.mark.parametrize("token", ["", "a.b", "a.b.c", "!!!.???.***"])
def test_malformed(keys, token):
    with pytest.raises(InvalidToken):
        keys.verifier().verify(token)


def test_skew_allows_60s(keys):
    issued = int(time.time()) - 3600
    token = keys.token(iat=issued, exp=issued + 3600 - 30)  # expired 30 s ago: within skew
    assert keys.verifier().verify(token)


def test_der_jose_roundtrip():
    raw = bytes(range(64))
    assert ticket_token.der_to_jose(ticket_token.jose_to_der(raw)) == raw


class FakeKms:
    def __init__(self, public_der: bytes, key_id: str = "abcd", spec: str = "ECC_NIST_P256") -> None:
        self.der, self.key_id, self.spec, self.calls = public_der, key_id, spec, 0

    def get_public_key(self, KeyId):  # noqa: N803
        self.calls += 1
        return {"KeyId": f"arn:aws:kms:us-west-2:1:key/{self.key_id}", "PublicKey": self.der, "KeySpec": self.spec, "KeyUsage": "SIGN_VERIFY"}


def test_kms_public_key_cached_and_pinned(keys):
    der = keys.private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    kms = FakeKms(der)
    lookup = KmsPublicKeys(kms, "abcd")
    token = ticket_token.sign(ticket_token.claims_for(CELL, TICKET, ASSIGNMENT), keys.private, "abcd")
    verifier = ticket_token.TicketTokenVerifier(lookup)
    verifier.verify(token)
    verifier.verify(token)
    assert kms.calls == 1
    with pytest.raises(InvalidToken, match="unexpected key"):
        KmsPublicKeys(FakeKms(der, key_id="other"), "abcd")("other")
    with pytest.raises(InvalidToken, match="key type"):
        KmsPublicKeys(FakeKms(der, spec="RSA_2048"), "abcd")("abcd")


def test_foreign_kid_is_refused_without_a_kms_call(keys):
    der = keys.private.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    kms = FakeKms(der)
    with pytest.raises(InvalidToken, match="unexpected key"):
        KmsPublicKeys(kms, "abcd")("arn:aws:kms:us-west-2:666:key/evil")
    assert kms.calls == 0
    # The cell signs with the key ARN as kid; the verifiers are configured with the bare key id.
    assert KmsPublicKeys(kms, "abcd")("arn:aws:kms:us-west-2:1:key/abcd") is not None and kms.calls == 1
