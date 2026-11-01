"""Shared fixtures: a test signing key standing in for KMS, and small fakes of the AWS clients the Lambdas use."""
from __future__ import annotations

import time
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from dshsa_worker import ticket_token

CELL = "acme--gh812345"
TICKET = "ticket-0001"
ASSIGNMENT = "assignment-0"
KID = "11111111-2222-3333-4444-555555555555"


class Keys:
    def __init__(self) -> None:
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.other = ec.generate_private_key(ec.SECP256R1())

    def token(self, *, key: Any = None, kid: str = KID, **overrides: Any) -> str:
        claims = {**ticket_token.claims_for(CELL, TICKET, ASSIGNMENT), **overrides}
        return ticket_token.sign(claims, key or self.private, kid)

    def verifier(self, clock=time.time) -> ticket_token.TicketTokenVerifier:
        public = self.private.public_key()

        def lookup(kid: str):
            if kid != KID:
                raise ticket_token.InvalidToken("token signed by an unexpected key")
            return public
        return ticket_token.TicketTokenVerifier(lookup, clock)


@pytest.fixture
def keys() -> Keys:
    return Keys()


class FakeDdb:
    def __init__(self, tables: dict[str, dict[str, dict[str, Any]]] | None = None) -> None:
        self.tables = tables or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def get_item(self, TableName: str, Key: dict[str, Any], ConsistentRead: bool = False) -> dict[str, Any]:  # noqa: N803
        self.calls.append(("get_item", {"TableName": TableName, "Key": Key}))
        (name, value), = Key.items()
        item = self.tables.get(TableName, {}).get(value["S"])
        return {"Item": item} if item else {}

    def put_item(self, TableName: str, Item: dict[str, Any], **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        self.calls.append(("put_item", {"TableName": TableName, "Item": Item, **kwargs}))
        self.tables.setdefault(TableName, {})[Item["ticketKey"]["S"]] = Item
        return {}

    def update_item(self, TableName: str, Key: dict[str, Any], **kwargs: Any) -> dict[str, Any]:  # noqa: N803
        self.calls.append(("update_item", {"TableName": TableName, "Key": Key, **kwargs}))
        item = self.tables[TableName][Key["ticketKey"]["S"]]
        item["status"] = kwargs["ExpressionAttributeValues"][":s"]
        return {}


def ddb_item(rec: dict[str, Any]) -> dict[str, Any]:
    def enc(v: Any) -> dict[str, Any]:
        if isinstance(v, bool):
            return {"BOOL": v}
        if isinstance(v, int):
            return {"N": str(v)}
        if isinstance(v, dict):
            return {"M": {k: enc(x) for k, x in v.items()}}
        return {"S": str(v)}
    return {k: enc(v) for k, v in rec.items()}
