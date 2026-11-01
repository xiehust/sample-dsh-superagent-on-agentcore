"""The worker agent: turns of a Claude Agent SDK session over the ticket's inbox (design §4.4/§4.5, DSH Executor semantics).

- One SDK session per ticket with a deterministic id (`render.sdk_session_id`), resumed across microVMs (spike S2).
- A turn takes every unread input. Inputs that arrive during a turn are injected at the next tool boundary through a
  PostToolUse hook (DSH "steer"); the rest start the next turn.
- Tools map 1:1 to WorkerEvents posted through the gateway's local proxy, which adds the ticket token.
- A turn that made no report ends with `report waiting` carrying its last words (DSH `workerIdle`), then `turn.ended`.
- Passing Bedrock/network failures retry the turn 3 times (15/30/60 s), then `report failed` (DSH `transient`).
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import render
from inbox import Store

PASSING = re.compile("|".join(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "socket hang up", "fetch failed",
                               "network error", "overloaded", "rate limit", "throttl", r"\b(?:408|429|50[0-4])\b"]), re.IGNORECASE)
RETRY_DELAYS = (15, 30, 60)
BUILTIN_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch",
                 "TodoWrite", "Task", "NotebookEdit", "Skill"]
DSHSA_TOOLS = ["report", "ack", "handback", "thread_follow", "thread_unrelated", "read"]


def transient(error: BaseException | str) -> bool:
    status = getattr(error, "status", None) or getattr(error, "api_error_status", None)
    if isinstance(status, int):
        return status in (408, 429) or status >= 500
    return bool(PASSING.search(f"{type(error).__name__} {error}"))


def now() -> str:
    return datetime.now(UTC).isoformat()


class ControlPlane:
    """Posts to worker-api through the gateway proxy. Each event keeps its id across retries, so delivery is idempotent."""

    def __init__(self, post: Callable[[str, dict[str, Any]], Awaitable[tuple[int, dict[str, Any]]]], ticket_key: str, assignment: Callable[[], str]):
        self._post, self.ticket_key, self.assignment = post, ticket_key, assignment

    async def event(self, kind: str, body: dict[str, Any], tries: int = 4) -> dict[str, Any]:
        event = {"id": uuid.uuid4().hex, "ticketKey": self.ticket_key, "assignmentId": self.assignment(), "at": now(), "type": kind, "body": body}
        last: tuple[int, dict[str, Any]] = (0, {})
        for attempt in range(tries):
            try:
                last = await self._post("/v1/events", event)
            except Exception as error:  # noqa: BLE001 - network to the proxy; retry
                last = (0, {"error": str(error)})
            if 200 <= last[0] < 300 or 400 <= last[0] < 500 and last[0] not in (408, 429):
                break
            await asyncio.sleep(min(2 ** attempt, 10))
        if not 200 <= last[0] < 300:
            print(json.dumps({"component": "agent", "event": "event_failed", "type": kind, "status": last[0], "detail": str(last[1])[:300]}), flush=True)
        return {"status": last[0], **last[1]}

    async def read(self, resource: str) -> dict[str, Any]:
        status, body = await self._post("/v1/read", {"resource": resource})
        return {"status": status, **body}


class TurnContext:
    """What one turn's tools and hooks share."""

    def __init__(self) -> None:
        self.reported = False
        self.last_text = ""
        self.steered: list[str] = []


class Worker:
    def __init__(self, store: Store, cp: ControlPlane, runner: Callable[..., Awaitable[None]], *, repo_dir: str, config_dir: str,
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
                 checkpoint: Callable[[], Awaitable[dict[str, Any]]] | None = None) -> None:
        self.store, self.cp, self.runner, self.repo_dir, self.config_dir, self.sleep = store, cp, runner, repo_dir, config_dir, sleep
        self.checkpoint = checkpoint
        self.status = "idle"
        self.wake = asyncio.Event()
        self.assignment_id = ""
        self.recovery = False
        self.header_due = False
        self.turn: TurnContext | None = None
        self.interrupt: Callable[[], Awaitable[None]] | None = None
        self.stopped = False
        self._task: asyncio.Task[None] | None = None
        # Work to do before the first turn of a run (repo preparation), off the control request: returns False to stop.
        self.prepare: Callable[[], Awaitable[bool]] | None = None

    # ---- control (gateway) ----------------------------------------------------------------------------------------
    def run(self, assignment_id: str, recovery: bool) -> None:
        if assignment_id != self.assignment_id:
            self.assignment_id, self.recovery, self.header_due = assignment_id, recovery, True
        self.stopped = False
        self.nudge()

    def nudge(self) -> None:
        if self.assignment_id and not self.stopped:
            self.status = "running"  # /ping turns HealthyBusy before the turn starts, so AgentCore never reaps queued work
        self.wake.set()
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self.loop())

    async def stop(self) -> None:
        self.stopped = True
        if self.interrupt is not None:
            try:
                await self.interrupt()
            except Exception as error:  # noqa: BLE001
                print(json.dumps({"component": "agent", "event": "interrupt_failed", "error": str(error)}), flush=True)

    # ---- loop ------------------------------------------------------------------------------------------------------
    async def loop(self) -> None:
        try:
            while True:
                await self.wake.wait()
                self.wake.clear()
                if self.prepare is not None:
                    prepare, self.prepare = self.prepare, None
                    if not await prepare():
                        self.prepare = prepare  # retry on the next nudge; never run a turn without a working copy
                        return
                while not self.stopped and self.assignment_id and await asyncio.to_thread(self.store.unread):
                    await self.one_turn()
                if not self.wake.is_set():
                    return
        finally:
            if self.status == "running" and self.turn is None:
                self.status = "idle"

    def session_exists(self, session_id: str) -> bool:
        return bool(glob.glob(os.path.join(self.config_dir, "projects", "*", f"{session_id}.jsonl")))

    async def take(self, inputs: list[dict[str, Any]]) -> None:
        ids = [item["id"] for item in inputs]
        if ids:
            await asyncio.to_thread(self.store.mark_read, ids)
            await self.cp.event("inputs.read", {"inputIds": ids})

    async def steer(self) -> str | None:
        """PostToolUse: inputs that arrived during the turn, as additional context at this step boundary."""
        fresh = await asyncio.to_thread(self.store.unread)
        if not fresh or self.stopped:
            return None
        await self.take(fresh)
        if self.turn:
            self.turn.steered += [item["id"] for item in fresh]
        return render.steer_context(fresh)

    async def one_turn(self) -> None:
        inputs = await asyncio.to_thread(self.store.unread)
        header = None
        if self.header_due:
            # The cell sends the assignment card as the `assignment:<id>` text input; only render one when it did not.
            carded = any(str(item.get("id", "")).startswith("assignment:") for item in inputs)
            config = await asyncio.to_thread(self.store.config)
            header = render.assignment_message(config.get("ticket", {}), self.recovery, card=not carded)
        await self.take(inputs)
        self.header_due = False
        prompt = render.turn_prompt(inputs, header)
        self.status, self.turn = "running", TurnContext()
        await asyncio.to_thread(self.store.update_state, assignmentId=self.assignment_id, clean=False, turnStartedAt=now())
        reason = "idle"
        try:
            for attempt in range(len(RETRY_DELAYS) + 1):
                try:
                    await self.runner(self, prompt)
                    break
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - classified below
                    if self.stopped:
                        reason = "interrupted"
                        break
                    if attempt < len(RETRY_DELAYS) and transient(error):
                        print(json.dumps({"component": "agent", "event": "turn_retry", "attempt": attempt + 1, "error": str(error)[:300]}), flush=True)
                        await self.sleep(RETRY_DELAYS[attempt])
                        prompt = f"Your last turn failed for a passing reason ({str(error)[:200]}). Continue the assignment where it stopped."
                        continue
                    reason = f"error:{type(error).__name__}"
                    await self.cp.event("report", {"state": "failed", "text": f"The worker failed: {str(error)[:1000]}"})
                    self.turn.reported = True
                    break
            if self.stopped and reason == "idle":
                reason = "interrupted"
            if not self.turn.reported and reason != "interrupted":
                text = self.turn.last_text.strip() or "Worker ended without a status report."
                await self.cp.event("report", {"state": "waiting", "text": text[:4000]})
            # Checkpoint the local working copy to the AP and flush, before saying the turn ended: the host may stop the VM next.
            if self.checkpoint is not None:
                await self.checkpoint()
            await asyncio.to_thread(os.sync)
            await self.cp.event("turn.ended", {"reason": reason})
        finally:
            self.status, self.turn, self.interrupt = "idle", None, None
            await asyncio.to_thread(self.store.update_state, clean=True, lastEnd=now())

    # ---- tools -----------------------------------------------------------------------------------------------------
    async def tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        """The six DSH worker tools (dsh src/app/tools/executor.ts) as WorkerEvents (§4.5)."""
        if name == "report":
            body = {"state": args["state"], "text": args.get("summary", "")}
            for src, dst in (("human_action", "question"), ("question_for_trigger_id", "askedBy"), ("reply_to_trigger_id", "answers"),
                             ("pr_number", "prNumber"), ("links", "links")):
                if src in args:
                    body[dst] = args[src]
            result = await self.cp.event("report", body)
            if self.turn and 200 <= result.get("status", 0) < 300:
                self.turn.reported = True
            return result
        if name == "ack":
            return await self.cp.event("ack", {"text": args["text"], "triggerId": args["trigger_id"]})
        if name == "handback":
            return await self.cp.event("handback", {"triggerIds": [args["trigger_id"]], "reason": args["reason"]})
        if name == "thread_follow":
            return await self.cp.event("thread.follow", {"thread": args["thread"], "reason": args.get("reason") or "related context"})
        if name == "thread_unrelated":
            return await self.cp.event("thread.unrelated", {"thread": args["thread"], "reason": args.get("reason") or "unrelated to this ticket"})
        if name == "read":
            return await self.cp.read(args["resource"])
        raise ValueError(f"unknown tool {name}")


TRIGGER_ID_HINT = ("Copy it exactly from a trigger_id field (a trigger card, a batch line or replies_to); never an input or "
                   "event id: the orchestrator refuses any id that is not one of this ticket's triggers.")
TOOL_SPECS: dict[str, tuple[str, dict[str, Any]]] = {
    "report": ("Report the ticket's state to the orchestrator: progress (internal update, work continues), waiting, ready (reviewed result, "
               "with its PR), blocked (a person must act), failed, or dropped (nothing to do; ends silently).", {
        "type": "object", "required": ["state", "summary"], "properties": {
            "state": {"type": "string", "enum": ["progress", "waiting", "ready", "blocked", "failed", "dropped"]},
            "summary": {"type": "string", "description": "Changes, tests actually run, risks; the user-visible outcome first."},
            "human_action": {"type": ["string", "null"], "description": "One concrete question for the ticket owner; null clears a pending one."},
            "question_for_trigger_id": {"type": "string", "description": "The trigger_id of the human message that raised the question. " + TRIGGER_ID_HINT},
            "reply_to_trigger_id": {"type": "string", "description": "The trigger_id of the explicit human question this report answers. " + TRIGGER_ID_HINT},
            "pr_number": {"type": ["integer", "null"], "description": "The ticket's PR number, when one exists."},
            "links": {"type": "array", "items": {"type": "object", "properties": {"url": {"type": "string"}, "label": {"type": "string"}}}}}}),
    "ack": ("Acknowledge a person's request on this ticket's threads that you will do (one short sentence naming the change).", {
        "type": "object", "required": ["trigger_id", "text"], "properties": {
            "trigger_id": {"type": "string", "description": "The request acknowledged. " + TRIGGER_ID_HINT}, "text": {"type": "string"}}}),
    "handback": ("Hand back a message that asks for work beyond this ticket or for another ticket; it goes to a fresh evaluation.", {
        "type": "object", "required": ["trigger_id", "reason"], "properties": {
            "trigger_id": {"type": "string", "description": "The message handed back. " + TRIGGER_ID_HINT}, "reason": {"type": "string"}}}),
    "thread_follow": ("Follow a related thread for context only, by its thread key <source>:<id> (such as github:42), with a one-sentence reason.", {
        "type": "object", "required": ["thread", "reason"], "properties": {"thread": {"type": "string"}, "reason": {"type": "string"}}}),
    "thread_unrelated": ("Drop an attached thread that turned out to be unrelated to this ticket, with a one-sentence reason.", {
        "type": "object", "required": ["thread", "reason"], "properties": {"thread": {"type": "string"}, "reason": {"type": "string"}}}),
    "read": ("Read a source record: github/<repo-relative REST path> such as github/issues/12/comments.", {
        "type": "object", "required": ["resource"], "properties": {"resource": {"type": "string"}}}),
}


async def sdk_runner(worker: Worker, prompt: str) -> None:
    """Runs one turn with the Claude Agent SDK (imported lazily so unit tests need no SDK)."""
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        HookMatcher,
        ResultMessage,
        TextBlock,
        create_sdk_mcp_server,
        tool,
    )

    cfg = await asyncio.to_thread(worker.store.config)  # NFS read: off the loop that serves /status
    config, ticket_key = cfg.get("config", {}), cfg.get("ticketKey", "")

    def make(name: str):
        description, schema = TOOL_SPECS[name]

        @tool(name, description, schema)
        async def run(args: dict[str, Any]) -> dict[str, Any]:
            result = await worker.tool(name, args)
            ok = 200 <= int(result.get("status", 0)) < 300
            return {"content": [{"type": "text", "text": json.dumps(result)[:20000]}], **({} if ok else {"is_error": True})}
        return run

    server = create_sdk_mcp_server("dshsa", tools=[make(name) for name in DSHSA_TOOLS])

    async def on_tool(_input: Any, _tool_use_id: str | None, _context: Any) -> dict[str, Any]:
        extra = await worker.steer()
        return {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": extra}} if extra else {}

    session = render.sdk_session_id(ticket_key)
    resume = await asyncio.to_thread(worker.session_exists, session)
    env = {k: v for k, v in (config.get("env") or {}).items() if not k.startswith("AWS_") and k not in ("CLAUDE_CONFIG_DIR", "HOME")}
    options = ClaudeAgentOptions(
        cwd=worker.repo_dir, model=config.get("model") or None, permission_mode="bypassPermissions",
        system_prompt={"type": "preset", "preset": "claude_code", "append": config.get("systemPrompt", "")},
        setting_sources=["user", "project"], mcp_servers={"dshsa": server},
        allowed_tools=BUILTIN_TOOLS + [f"mcp__dshsa__{name}" for name in DSHSA_TOOLS],
        hooks={"PostToolUse": [HookMatcher(hooks=[on_tool])]},
        env={**env, "CLAUDE_CONFIG_DIR": worker.config_dir, "CLAUDE_CODE_USE_BEDROCK": "1"},
        **({"resume": session} if resume else {"session_id": session}),
    )
    async with ClaudeSDKClient(options=options) as client:
        worker.interrupt = client.interrupt
        await client.query(prompt)
        async for message in client.receive_response():
            if isinstance(message, AssistantMessage):
                text = "\n".join(block.text for block in message.content if isinstance(block, TextBlock)).strip()
                if text and worker.turn:
                    worker.turn.last_text = text
            elif isinstance(message, ResultMessage) and message.is_error and not worker.stopped:
                raise RuntimeError(f"turn failed: {message.subtype} {message.api_error_status or ''} {(message.errors or '')}"[:500])


def write_skills(config_dir: str, skills: list[dict[str, str]]) -> None:
    for skill in skills or []:
        name = re.sub(r"[^a-z0-9-]", "-", skill.get("name", "").lower()).strip("-")
        if not name:
            continue
        path = os.path.join(config_dir, "skills", name)
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "SKILL.md"), "w") as f:
            f.write(skill.get("content", ""))


def monotonic() -> float:
    return time.monotonic()
