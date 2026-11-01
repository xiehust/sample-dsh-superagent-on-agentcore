"""What the agent reads: the first assignment message, each input, and the fixed notes. Ported in spirit from
dsh-superagent-prototype/src/executor/dsh.ts (`ticketExecution`, `inputMessage`, `RESUMED`, `RECOVERY_NOTE`; MIT)."""
from __future__ import annotations

import hashlib
import json
from typing import Any

import dshsa_contracts

TRIGGER_CHARS = 4000
ASSIGNMENT_CHARS = 1500

RECOVERY_NOTE = ("The worker restarted during this ticket (a new machine resumed the same work directory and conversation). "
                 "Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed "
                 "external operation. Finish the original assignment and report its status.")
RESUMED = ("This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for "
           "more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond "
           "that scope or for another ticket, hand it back with the handback tool and report dropped; if it needs nothing, such as "
           "thanks, report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.")
INFERRED = ("This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module "
            "within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions "
            "or clarification, stop and report dropped; do not expand scope.")


def sdk_session_id(ticket_key: str) -> str:
    """Deterministic Claude Agent SDK session id per ticket (contracts v2, spike S2): no stored id is needed to resume."""
    return dshsa_contracts.sdk_session_id(ticket_key)


def event_id(ticket_key: str, assignment_id: str, kind: str, n: int | str) -> str:
    return hashlib.sha256(f"{ticket_key}/{assignment_id}/{kind}/{n}".encode()).hexdigest()[:32]


def _capped(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}… ({len(text)} chars; read the rest from its source)"


def _cell_card(text: str) -> dict[str, Any] | None:
    """The cell's own trigger card when `text` is one (a JSON object naming a trigger), else None."""
    if not text.startswith("{"):
        return None
    try:
        card = json.loads(text)
    except ValueError:
        return None
    return card if isinstance(card, dict) and ("trigger_id" in card or "read" in card) else None


def input_message(item: dict[str, Any]) -> str:
    kind = item.get("kind")
    text = str(item.get("text", ""))
    if kind == "trigger":
        meta = item.get("meta") or {}
        cell_card = _cell_card(text)
        if cell_card is not None:
            # The cell already rendered the DSH trigger card (cell executor/messages.ts triggerMessage: trigger_id = the domain
            # Trigger id, thread, replies_to.trigger_id, context, source_url). Pass it through instead of wrapping it in a second
            # card whose `text` would be that JSON as an escaped string. Only fill in a missing trigger_id from meta.
            if not cell_card.get("trigger_id") and meta.get("triggerId"):
                return json.dumps({"trigger_id": meta["triggerId"], **cell_card}, ensure_ascii=False)
            return text
        # The domain Trigger id (WorkerInput.meta.triggerId), not the Ticket Input id: ack, handback and report answers/askedBy
        # name triggers, and the cell refuses any other id. The input id is only a fallback for an input without its trigger.
        card = {"trigger_id": meta.get("triggerId") or item.get("id"), "source": item.get("source"), "at": item.get("at"),
                "text": _capped(text, TRIGGER_CHARS)}
        for key in ("from", "thread", "replies_to", "routing_note", "context"):
            if key in meta:
                card[key] = meta[key]
        if item.get("url"):
            card["url"] = item["url"]
        return json.dumps(card, ensure_ascii=False)
    if kind == "policy":
        return text or "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment."
    if kind == "resume":
        # The cell sends the RESUMED notice itself as the text (messages.ts inputMessage); add it only when it is missing.
        return text if RESUMED in text else f"{RESUMED}\n\n{text}".strip()
    return text


def assignment_message(ticket: dict[str, Any], recovery: bool, card: bool = True) -> str | None:
    """The header of an assignment's first turn: the ticket card (unless the cell sent one), the proactive limits, the recovery note."""
    mandate = ticket.get("mandate") or {}
    parts = []
    if card:
        parts.append(json.dumps({"ticket_id": ticket.get("ticketId"), "title": ticket.get("title"),
                                 "scope": _capped(str(ticket.get("scope", "")), ASSIGNMENT_CHARS),
                                 **({"routing_note": ticket["note"]} if ticket.get("note") else {})}, ensure_ascii=False))
        if mandate.get("strength") == "inferred":
            parts.append(INFERRED)
    if recovery:
        parts.append(RECOVERY_NOTE)
    return "\n\n".join(parts) or None


def turn_prompt(inputs: list[dict[str, Any]], header: str | None = None) -> str:
    """One user message: the optional assignment header, then every waiting input in order."""
    blocks = [header] if header else []
    blocks += [message for message in (input_message(item) for item in inputs) if message]
    return "\n\n".join(blocks) or "Continue the assignment and report its status."


def steer_context(inputs: list[dict[str, Any]]) -> str:
    """Inputs that arrived while a turn runs, injected at the next step boundary (DSH steer)."""
    return "New messages arrived for this ticket while you were working; take them into account:\n\n" + turn_prompt(inputs)
