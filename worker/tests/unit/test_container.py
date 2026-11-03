"""Container logic without a microVM: inbox/state, rendering, gateway dispatch and binding, the agent's turn loop."""
import asyncio
import json

import agent_core
import dshsa_contracts as contracts
import gateway_core
import pytest
import render
from conftest import ASSIGNMENT, CELL, TICKET
from gateway_core import Gateway
from inbox import Store

KEY = contracts.ticket_key(CELL, TICKET)


def inp(i, kind="trigger", text="hello"):
    return {"id": f"in-{i}", "kind": kind, "at": "2026-11-01T00:00:00Z", "text": text, "source": "github"}


# ---- inbox -----------------------------------------------------------------------------------------------------------
def test_inbox_dedups_and_tracks_reads(tmp_path):
    store = Store(str(tmp_path))
    assert store.append([inp(1), inp(2), inp(1)]) == ["in-1", "in-2", "in-1"]
    assert store.append([inp(2), inp(3)]) == ["in-2", "in-3"]
    assert [i["id"] for i in store.inputs()] == ["in-1", "in-2", "in-3"]
    store.mark_read(["in-1", "in-2"])
    assert [i["id"] for i in store.unread()] == ["in-3"]
    store.update_state(clean=False)
    assert store.state()["read"] == ["in-1", "in-2"] and store.state()["clean"] is False


def test_inbox_survives_a_torn_last_line(tmp_path):
    store = Store(str(tmp_path))
    store.append([inp(1)])
    with open(store.inbox_path, "a") as f:
        f.write('{"id": "in-2", "kind"')
    assert [i["id"] for i in store.inputs()] == ["in-1"]
    assert store.append([inp(2)]) == ["in-2"]


def test_inbox_ignores_inputs_without_id(tmp_path):
    store = Store(str(tmp_path))
    assert store.append([{"kind": "text"}, "junk", inp(1)]) == ["in-1"]


# ---- render ----------------------------------------------------------------------------------------------------------
def test_session_id_is_the_contracts_derivation():
    assert render.sdk_session_id(KEY) == contracts.sdk_session_id(KEY) != render.sdk_session_id("f" * 32)


def test_trigger_card_and_header():
    card = json.loads(render.input_message({**inp(1), "url": "https://x", "meta": {"from": "alice", "secret": "no"}}))
    assert card == {"trigger_id": "in-1", "source": "github", "at": "2026-11-01T00:00:00Z", "text": "hello", "from": "alice", "url": "https://x"}
    # The card names the domain Trigger (meta.triggerId), never the Ticket Input id: the cell checks answers/acks against triggers.
    named = json.loads(render.input_message({**inp(4), "meta": {"triggerId": "trg-4", "from": "alice", "human": True}}))
    assert named["trigger_id"] == "trg-4" and "human" not in named
    assert render.assignment_message({"ticketId": "t"}, recovery=False, card=False) is None
    header = render.assignment_message({"ticketId": "t", "mandate": {"strength": "inferred"}}, recovery=True)
    assert "limited proactive authorization" in header and render.RECOVERY_NOTE in header
    assert "resumed it under the same mandate" in render.input_message(inp(2, kind="resume", text="thanks"))
    long = render.input_message(inp(3, text="x" * 5000))
    assert "5000 chars" in long


def test_cell_rendered_trigger_card_passes_through():
    # What the cell sends (executor/agentcore.ts input + messages.ts triggerMessage): the card is the text, the input id differs.
    cell_card = {"trigger_id": "trg-9", "from": "ou_alice", "thread": "feishu:oc_1:om_1", "at": "2026-11-01T00:00:00Z", "text": "ship it",
                 "source_url": "https://feishu/x", "replies_to": {"trigger_id": "trg-8", "preview": "can you?"}, "context": True}
    item = {"id": "input-77", "kind": "trigger", "at": "2026-11-01T00:00:00Z", "source": "feishu", "text": json.dumps(cell_card),
            "meta": {"triggerId": "trg-9", "from": "ou_alice", "human": True}}
    out = render.input_message(item)
    assert json.loads(out) == cell_card  # verbatim: not re-wrapped, no input id anywhere
    assert "input-77" not in out and "input-77" not in render.steer_context([item]) and "input-77" not in render.turn_prompt([item])
    # The cell's id-only form (trigger not in its store) gets the trigger id from meta when the card lacks one.
    bare = render.input_message({**item, "text": json.dumps({"read": "trigger/trg-9"})})
    assert json.loads(bare) == {"trigger_id": "trg-9", "read": "trigger/trg-9"}
    # The cell sends the RESUMED notice as the text; the worker does not repeat it.
    assert render.input_message(inp(5, kind="resume", text=render.RESUMED)).count(render.RESUMED) == 1


def test_tool_schemas_say_which_id_to_copy():
    specs = agent_core.TOOL_SPECS
    hints = [specs["ack"][1]["properties"]["trigger_id"], specs["handback"][1]["properties"]["trigger_id"],
             specs["report"][1]["properties"]["question_for_trigger_id"], specs["report"][1]["properties"]["reply_to_trigger_id"]]
    assert all("never an input or event id" in h["description"] for h in hints)


# ---- gateway ---------------------------------------------------------------------------------------------------------
class FakeMounter:
    def __init__(self, fail=False):
        self.fail, self.mounts, self.tokens = fail, 0, []
        self._mounted = False

    async def ensure(self, token):
        if self.fail:
            raise RuntimeError("broker refused: unauthorized")
        self.mounts += 1
        self._mounted = True
        return {"ticketKey": KEY}

    def note_token(self, token):
        self.tokens.append(token)

    def mounted(self):
        return self._mounted


class FakeAgent:
    def __init__(self):
        self.calls, self.state = [], "idle"

    async def call(self, path, body=None):
        self.calls.append((path, body))
        if path == "/status":
            return {"state": self.state}
        return {"ok": True}


def request(keys, action="start", inputs=None, **token):
    return {"v": 1, "action": action, "token": keys.token(**token), "inputs": inputs or [],
            "ticket": {"tenantId": "acme", "cellId": CELL, "ticketId": TICKET, "assignmentId": ASSIGNMENT, "title": "t", "scope": "s", "mandate": {}},
            "config": {"model": "m", "systemPrompt": "", "skills": [], "env": {},
                       "repo": {"fullName": "acme/app", "defaultBranch": "main", "cloneUrl": "https://github.com/acme/app.git"}}}


def gateway(keys, tmp_path, mounter=None):
    agent = FakeAgent()
    gw = Gateway(verifier=keys.verifier(), mounter=mounter or FakeMounter(), agent=agent, store=Store(str(tmp_path)), version=VERSION)
    return gw, agent


VERSION = "0123456789abcdef"


async def test_start_mounts_writes_inbox_and_runs(keys, tmp_path):
    gw, agent = gateway(keys, tmp_path)
    res = await gw.handle(request(keys, inputs=[inp(1)]), contracts.runtime_session_id(CELL, TICKET))
    assert res == {"ok": True, "accepted": ["in-1"], "state": "idle", "workerVersion": VERSION}
    assert ("/run", {"assignmentId": ASSIGNMENT, "recovery": False}) in agent.calls
    saved = Store(str(tmp_path)).config()
    assert saved["ticketKey"] == KEY and "token" not in json.dumps(saved)


async def test_start_is_idempotent_and_deliver_nudges(keys, tmp_path):
    gw, agent = gateway(keys, tmp_path)
    await gw.handle(request(keys, inputs=[inp(1)]))
    res = await gw.handle(request(keys, action="deliver", inputs=[inp(1), inp(2)]))
    assert res["accepted"] == ["in-1", "in-2"]
    assert [p for p, _ in agent.calls if p in ("/run", "/nudge")] == ["/run", "/nudge"]
    assert gw.mounter.mounts == 1


async def test_deliver_first_on_a_new_vm_resumes_with_recovery(keys, tmp_path):
    Store(str(tmp_path)).update_state(clean=False, assignmentId=ASSIGNMENT)
    gw, agent = gateway(keys, tmp_path)
    await gw.handle(request(keys, action="deliver", inputs=[inp(5)]))
    assert ("/run", {"assignmentId": ASSIGNMENT, "recovery": True}) in agent.calls


async def test_vm_binds_to_the_first_ticket(keys, tmp_path):
    gw, _ = gateway(keys, tmp_path)
    await gw.handle(request(keys))
    other = request(keys)
    other_cell = "acme--gh999"
    from conftest import KID

    from dshsa_worker.ticket_token import claims_for, sign
    other["token"] = sign(claims_for(other_cell, "t2", "a0"), keys.private, KID)
    other["ticket"].update(cellId=other_cell, ticketId="t2", assignmentId="a0")
    res = await gw.handle(other)
    assert res["ok"] is False and res["error"] == "bound_to_other_ticket"


@pytest.mark.parametrize("mutate,error", [
    (lambda r, k: r.update(token=k.token(key=k.other)), "unauthorized"),
    (lambda r, k: r["ticket"].update(ticketId="someone-else"), "unauthorized"),
    (lambda r, k: r["ticket"].update(assignmentId="assignment-other"), "unauthorized"),
    (lambda r, k: r.update(v=2), "bad_request"),
    (lambda r, k: r.pop("config"), "bad_request"),
])
async def test_refusals(keys, tmp_path, mutate, error):
    gw, agent = gateway(keys, tmp_path)
    req = request(keys)
    mutate(req, keys)
    res = await gw.handle(req)
    assert res["ok"] is False and res["error"] == error
    assert not [c for c in agent.calls if c[0] == "/run"]


async def test_restarted_agent_is_put_back_to_work(keys, tmp_path):
    gw, agent = gateway(keys, tmp_path)
    await gw.handle(request(keys, inputs=[inp(1)]))
    gw.store.update_state(clean=False)  # the agent process died mid-turn

    async def restarted(path, body=None):
        agent.calls.append((path, body))
        if path == "/status":
            return {"state": "idle"}
        return {"ok": False, "error": "no_assignment"} if path == "/nudge" else {"ok": True}
    agent.call = restarted
    res = await gw.handle(request(keys, action="deliver", inputs=[inp(2)]))
    assert res["ok"] is True
    assert [c for c in agent.calls if c[0] in ("/run", "/nudge")][-2:] == [("/nudge", None), ("/run", {"assignmentId": ASSIGNMENT, "recovery": True})]


async def test_session_header_must_match_token(keys, tmp_path):
    gw, _ = gateway(keys, tmp_path)
    res = await gw.handle(request(keys), "dshsa-" + "0" * 64)
    assert res["error"] == "unauthorized"


async def test_mount_failure_is_reported_not_raised(keys, tmp_path):
    gw, agent = gateway(keys, tmp_path, FakeMounter(fail=True))
    res = await gw.handle(request(keys))
    assert res["ok"] is False and res["error"] == "mount_failed"
    assert gw.bound_sub is None


async def test_every_invocation_response_names_the_worker_version(keys, tmp_path):
    # The cell compares this with SSM /dshsa-worker/version to stop sessions still on an old microVM (contracts WorkerVersion).
    gw, _ = gateway(keys, tmp_path)
    rsid = contracts.runtime_session_id(CELL, TICKET)
    answers = [await gw.handle({"v": 2}, rsid),                                         # bad_request
               await gw.handle(request(keys, action="status"), "dshsa-" + "0" * 64),   # rejected: another session
               await gw.handle(request(keys, action="status"), rsid),
               await gw.handle(request(keys, inputs=[inp(1)]), rsid)]
    assert [a["ok"] for a in answers] == [False, False, True, True]
    assert all(a[contracts.WORKER_VERSION_FIELD] == VERSION for a in answers)
    assert gw.versioned({"ok": True, "accepted": [], "state": "idle"})["workerVersion"] == VERSION


def test_worker_version_comes_from_the_image_file_or_the_env(tmp_path, monkeypatch):
    monkeypatch.delenv(contracts.WORKER_VERSION_ENV, raising=False)
    baked = tmp_path / "WORKER_VERSION"
    baked.write_text("feedfacecafebeef\n")
    assert gateway_core.worker_version(str(baked)) == "feedfacecafebeef"
    assert gateway_core.worker_version(str(tmp_path / "missing")) == "unknown"
    monkeypatch.setenv(contracts.WORKER_VERSION_ENV, "override")
    assert gateway_core.worker_version(str(baked)) == "override"


async def test_stop_and_status(keys, tmp_path):
    gw, agent = gateway(keys, tmp_path)
    assert (await gw.handle(request(keys, action="status")))["state"] == "idle"
    await gw.handle(request(keys))
    agent.state = "running"
    assert await gw.busy() is True
    res = await gw.handle(request(keys, action="stop"))
    assert res["ok"] is True and ("/stop", None) in agent.calls


async def test_token_kept_is_the_latest_expiry(keys, tmp_path):
    gw, _ = gateway(keys, tmp_path)
    import time
    now = int(time.time())
    late = request(keys, iat=now, exp=now + 7000)
    early = request(keys, action="deliver", iat=now, exp=now + 600)
    await gw.handle(late)
    await gw.handle(early)
    assert gw.token == late["token"]


# ---- agent -----------------------------------------------------------------------------------------------------------
class FakeCp:
    def __init__(self):
        self.events = []

    async def event(self, kind, body, tries=4):
        self.events.append((kind, body))
        return {"status": 200, "ok": True}

    async def read(self, resource):
        return {"status": 200, "ok": True, "content": resource}


def worker(tmp_path, runner, store=None):
    store = store or Store(str(tmp_path))
    store.save_config({"ticketKey": KEY, "ticket": {"ticketId": TICKET, "mandate": {}}, "config": {}})
    cp = FakeCp()
    sleeps = []

    async def sleep(s):
        sleeps.append(s)
    w = agent_core.Worker(store, cp, runner, repo_dir=str(tmp_path / "repo"), config_dir=str(tmp_path / ".claude"), sleep=sleep)
    return w, store, cp, sleeps


async def drain(w):
    for _ in range(50):
        await asyncio.sleep(0)
        if w._task and w._task.done():
            return
    await asyncio.wait_for(w._task, 2)


async def test_turn_reports_waiting_with_last_words_when_no_report(tmp_path):
    prompts = []

    async def runner(w, prompt):
        prompts.append(prompt)
        w.turn.last_text = "I looked around."
    w, store, cp, _ = worker(tmp_path, runner)
    store.append([{"id": "assignment:a0", "kind": "text", "at": "t", "text": "CARD"}, inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert prompts == ["CARD\n\n" + render.input_message(inp(1))]
    assert [k for k, _ in cp.events] == ["inputs.read", "report", "turn.ended"]
    assert cp.events[1][1] == {"state": "waiting", "text": "I looked around."}
    assert store.state()["clean"] is True and not store.unread()


async def test_report_tool_suppresses_waiting(tmp_path):
    async def runner(w, prompt):
        await w.tool("report", {"state": "ready", "summary": "done", "pr_number": 7, "reply_to_trigger_id": "in-1"})
    w, store, cp, _ = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    kinds = [k for k, _ in cp.events]
    assert kinds == ["inputs.read", "report", "turn.ended"]
    assert cp.events[1][1] == {"state": "ready", "text": "done", "prNumber": 7, "answers": "in-1"}


async def test_inputs_during_a_turn_are_steered_at_the_step_boundary(tmp_path):
    seen = []

    async def runner(w, prompt):
        w.store.append([inp(2)])
        seen.append(await w.steer())
        seen.append(await w.steer())
        await w.tool("report", {"state": "progress", "summary": "ok"})
    w, store, cp, _ = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert "New messages arrived" in seen[0] and seen[1] is None
    assert [b for k, b in cp.events if k == "inputs.read"] == [{"inputIds": ["in-1"]}, {"inputIds": ["in-2"]}]


async def test_transient_failures_retry_then_fail(tmp_path):
    calls = []

    async def runner(w, prompt):
        calls.append(prompt)
        raise RuntimeError("ThrottlingException: rate limit 429")
    w, store, cp, sleeps = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert len(calls) == 4 and sleeps == [15, 30, 60]
    assert cp.events[-2][0] == "report" and cp.events[-2][1]["state"] == "failed"
    assert cp.events[-1] == ("turn.ended", {"reason": "error:RuntimeError"})


async def test_permanent_failure_fails_at_once(tmp_path):
    async def runner(w, prompt):
        raise ValueError("bad config")
    w, store, cp, sleeps = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert sleeps == [] and cp.events[-2][1]["state"] == "failed"


async def test_stop_interrupts_without_waiting_report(tmp_path):
    async def runner(w, prompt):
        await w.stop()
        raise RuntimeError("interrupted")
    w, store, cp, _ = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert [k for k, _ in cp.events] == ["inputs.read", "turn.ended"] and cp.events[-1][1] == {"reason": "interrupted"}


async def test_recovery_header_on_new_assignment(tmp_path):
    prompts = []

    async def runner(w, prompt):
        prompts.append(prompt)
        await w.tool("report", {"state": "progress", "summary": "x"})
    w, store, cp, _ = worker(tmp_path, runner)
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=True)
    await drain(w)
    assert render.RECOVERY_NOTE in prompts[0]


@pytest.mark.parametrize("err,expected", [("ECONNRESET", True), ("HTTP 503 from Bedrock", True), ("overloaded_error", True),
                                          ("ValidationException: bad model", False)])
def test_transient_classifier(err, expected):
    assert agent_core.transient(RuntimeError(err)) is expected


async def test_ack_and_handback_map_to_events(tmp_path):
    w, _, cp, _ = worker(tmp_path, None)
    w.assignment_id = ASSIGNMENT
    await w.tool("ack", {"trigger_id": "in-1", "text": "On it"})
    await w.tool("handback", {"trigger_id": "in-2", "reason": "other ticket"})
    await w.tool("thread_unrelated", {"thread": "github:issue/3", "reason": "nope"})
    assert cp.events == [("ack", {"text": "On it", "triggerId": "in-1"}), ("handback", {"triggerIds": ["in-2"], "reason": "other ticket"}),
                         ("thread.unrelated", {"thread": "github:issue/3", "reason": "nope"})]
    await w.tool("thread_follow", {"thread": "github:7", "reason": "same bug"})
    assert cp.events[-1] == ("thread.follow", {"thread": "github:7", "reason": "same bug"})


async def test_checkpoint_runs_before_turn_ended(tmp_path):
    order = []

    async def runner(w, prompt):
        await w.tool("report", {"state": "progress", "summary": "x"})
    w, store, cp, _ = worker(tmp_path, runner)

    async def checkpoint():
        order.append(("checkpoint", [k for k, _ in cp.events]))
        return {"bytes": 1}
    w.checkpoint = checkpoint
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert order == [("checkpoint", ["inputs.read", "report"])] and cp.events[-1][0] == "turn.ended"


async def test_failed_preparation_is_retried_before_any_turn(tmp_path):
    turns, attempts = [], []

    async def runner(w, prompt):
        turns.append(prompt)
        await w.tool("report", {"state": "progress", "summary": "x"})
    w, store, cp, _ = worker(tmp_path, runner)

    async def prepare():
        attempts.append(1)
        return len(attempts) > 1  # the first clone fails, the second works
    w.prepare = prepare
    store.append([inp(1)])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert turns == [] and [i["id"] for i in store.unread()] == ["in-1"]
    w.nudge()
    await drain(w)
    assert len(attempts) == 2 and len(turns) == 1 and not store.unread()


# ---- v7: model + effort, agent check, skill pruning, retry resend (claude-worker-model-effort) -----------------------
def options(config, resume=False):
    return agent_core.sdk_options(config, repo_dir="/r", config_dir="/c", session="s-1", resume=resume)


def test_sdk_options_carry_model_and_effort():
    out = options({"model": "global.anthropic.claude-sonnet-5-5", "effort": "low"})
    assert out["model"] == "global.anthropic.claude-sonnet-5-5" and out["effort"] == "low"
    assert out["session_id"] == "s-1" and "resume" not in out
    assert options({}, resume=True)["resume"] == "s-1"


@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh", "max"])
def test_sdk_options_accept_every_claude_effort(effort):
    assert options({"effort": effort})["effort"] == effort


def test_sdk_options_without_effort_leave_the_cli_default():
    out = options({"model": "global.anthropic.claude-opus-5-5"})
    assert "effort" not in out and out["model"] == "global.anthropic.claude-opus-5-5"
    assert options({"model": ""})["model"] is None


@pytest.mark.parametrize("effort", ["none", "ultra", "HIGH", 3])
def test_sdk_options_drop_an_unknown_effort_and_say_so(effort, capsys):
    assert "effort" not in options({"effort": effort})
    lines = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [line["event"] for line in lines] == ["effort_ignored"]


def test_sdk_options_filter_the_cell_env():
    env = options({"env": {"AWS_BEARER_TOKEN_BEDROCK": "x", "AWS_REGION": "us-east-1", "HOME": "/x", "CLAUDE_CONFIG_DIR": "/y", "FOO": "1"}})["env"]
    assert env == {"FOO": "1", "CLAUDE_CONFIG_DIR": "/c", "CLAUDE_CODE_USE_BEDROCK": "1"}


def with_agent(keys, agent, action="start"):
    req = request(keys, action, inputs=[inp(1)])
    req["config"]["agent"] = agent
    return req


async def test_gateway_rejects_another_agent_before_any_side_effect(keys, tmp_path):
    mounter = FakeMounter()
    gw, agent = gateway(keys, tmp_path, mounter)
    result = await gw.handle(with_agent(keys, "codex"))
    assert result["ok"] is False and result["error"] == "bad_request" and "claude" in result["message"]
    assert mounter.mounts == 0 and agent.calls == [] and not (tmp_path / ".dshsa").exists()
    assert result[contracts.WORKER_VERSION_FIELD] == VERSION


@pytest.mark.parametrize("agent", ["claude", None])
async def test_gateway_accepts_its_own_agent_or_none(keys, tmp_path, agent):
    gw, _ = gateway(keys, tmp_path)
    req = with_agent(keys, agent) if agent else request(keys, inputs=[inp(1)])
    assert (await gw.handle(req))["ok"] is True


async def test_codex_gateway_rejects_a_claude_ticket(keys, tmp_path):
    gw = Gateway(verifier=keys.verifier(), mounter=FakeMounter(), agent=FakeAgent(), store=Store(str(tmp_path)), version=VERSION, agent_type="codex")
    assert (await gw.handle(with_agent(keys, "claude")))["error"] == "bad_request"
    assert (await gw.handle(with_agent(keys, "codex")))["ok"] is True


def test_write_skills_keeps_exactly_the_configured_skills(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("x")
    agent_core.write_skills(str(tmp_path), [{"name": "a", "content": "A"}, {"name": "b", "content": "B"}])
    (tmp_path / "skills" / "linked").symlink_to(outside, target_is_directory=True)
    (tmp_path / "skills" / ".system").mkdir()
    agent_core.write_skills(str(tmp_path), [{"name": "a", "content": "A2"}])
    assert sorted(p.name for p in (tmp_path / "skills").iterdir()) == ["a"]
    assert (tmp_path / "skills" / "a" / "SKILL.md").read_text() == "A2"
    assert (outside / "keep.txt").exists()  # a symlinked entry is unlinked, never followed


def failing_runner(prompts, delivered_before_failure):
    async def runner(w, prompt):
        prompts.append(prompt)
        if len(prompts) > 1:
            return
        if delivered_before_failure is not None:
            w.turn.delivered = False
            if delivered_before_failure:
                w.turn.delivered = True
        raise RuntimeError("ECONNRESET 503")
    return runner


@pytest.mark.parametrize("delivered, resent", [(False, True), (True, False), (None, False)])
async def test_a_retry_resends_inputs_that_never_reached_the_agent(tmp_path, delivered, resent):
    prompts = []
    w, store, cp, sleeps = worker(tmp_path, failing_runner(prompts, delivered))
    store.append([inp(1, text="please fix the login bug")])
    w.run(ASSIGNMENT, recovery=False)
    await drain(w)
    assert len(prompts) == 2 and sleeps == [15]
    assert ("please fix the login bug" in prompts[1]) is resent
    assert "passing reason" in prompts[1]
