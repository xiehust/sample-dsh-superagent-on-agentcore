"""codex_runner against a scripted fake app-server (fake_app_server.py): handshake, thread start/resume, the DSH tools,
steering, interrupt, error mapping, input-loss safety, configuration and skills lock-down (codex-worker design)."""
import asyncio
import json
import os
import sys

import agent_core
import codex_runner
import pytest
import render
from conftest import ASSIGNMENT
from inbox import Store

FAKE = os.path.join(os.path.dirname(__file__), "fake_app_server.py")
CONFIG = {"model": "global.openai.gpt-6.1-terra", "effort": "high", "systemPrompt": "Be careful.", "skills": [], "env": {},
          "repo": {"fullName": "acme/app", "defaultBranch": "main", "cloneUrl": "https://github.com/acme/app.git"}}


def inp(i, text=None):
    return {"id": f"in-{i}", "kind": "text", "at": "2026-11-03T00:00:00Z", "text": text or f"message number {i}"}


class Cp:
    def __init__(self):
        self.events, self.on = [], {}

    async def event(self, kind, body, tries=4):
        self.events.append((kind, body))
        if kind in self.on:
            self.on[kind]()
        return {"status": 200, "ok": True}

    async def read(self, resource):
        return {"status": 200, "content": resource}


class Env:
    """One ticket: AP-like work dir, the fake's directory, a Worker and a CodexRunner (a new one = a new agent process)."""

    def __init__(self, tmp_path, script, config=None):
        self.tmp, self.fake = tmp_path, tmp_path / "fake"
        self.fake.mkdir()
        (self.fake / "script.json").write_text(json.dumps(script))
        self.store = Store(str(tmp_path / "work"))
        self.store.ensure()
        self.set_config(config or CONFIG)
        self.cp, self.sleeps = Cp(), []
        self.new_process()

    def set_config(self, config):
        self.store.save_config({"ticketKey": "k", "ticket": {"ticketId": "t", "mandate": {}}, "config": config})

    def new_process(self):
        async def sleep(s):
            self.sleeps.append(s)
        self.runner = codex_runner.CodexRunner(
            codex_home=str(self.tmp / "work" / ".codex"), repo_dir=str(self.tmp / "repo"), local_dir=str(self.tmp / "local"),
            command=[sys.executable, "-I", FAKE], region="ap-northeast-1", user_skills=str(self.tmp / "home" / ".agents" / "skills"),
            base_env={"PATH": os.environ.get("PATH", ""), "FAKE_DIR": str(self.fake), "FAKE_STATE": str(self.tmp / "work" / ".dshsa" / "state.json")},
            flush_wait_s=1.0)
        (self.tmp / "repo").mkdir(exist_ok=True)
        self.worker = agent_core.Worker(self.store, self.cp, self.runner, repo_dir=str(self.tmp / "repo"), config_dir=str(self.tmp / "work" / ".codex"),
                                        sleep=sleep)
        return self.worker

    async def run(self, *inputs):
        self.store.append(list(inputs))
        self.worker.run(ASSIGNMENT, recovery=False)
        for _ in range(400):
            await asyncio.sleep(0.02)
            if self.worker._task and self.worker._task.done():
                break
        await asyncio.wait_for(self.worker._task, 10)

    async def close(self):
        if self.runner.server:
            await self.runner.server.close()

    def log(self, kind=None, method=None):
        lines = [json.loads(line) for line in (self.fake / "log.jsonl").read_text().splitlines()]
        lines = [line for line in lines if kind is None or line["kind"] == kind]
        if method:
            lines = [line for line in lines if line.get("message", {}).get("method") == method]
        return lines

    def params(self, method):
        return [line["message"]["params"] for line in self.log("in", method)]


@pytest.fixture
def env(tmp_path):
    def make(script, config=None):
        return Env(tmp_path, script, config)
    return make


async def test_a_turn_starts_a_thread_stores_its_id_first_and_maps_the_tools(env):
    e = env({"turns": [["user", ["tool", "report", {"state": "ready", "summary": "done", "pr_number": 3}], ["agent", "All done."]]]})
    await e.run(inp(1))
    start = e.params("thread/start")[0]
    assert start["modelProvider"] == "amazon-bedrock-runtime" and start["sandbox"] == "danger-full-access" and start["approvalPolicy"] == "never"
    assert [t["name"] for t in start["dynamicTools"]] == agent_core.DSHSA_TOOLS and start["developerInstructions"] == "Be careful."
    assert e.log("turn")[0]["threadStored"] is True  # state.json had the thread id before turn/start
    turn = e.params("turn/start")[0]
    assert turn["model"] == "global.openai.gpt-6.1-terra" and turn["effort"] == "high" and "message number 1" in turn["input"][0]["text"]
    answer = e.log("answer")[0]["response"]["result"]
    assert answer["success"] is True and answer["contentItems"][0]["type"] == "inputText"
    assert ("report", {"state": "ready", "text": "done", "prNumber": 3}) in e.cp.events
    assert not [b for k, b in e.cp.events if k == "report" and b["state"] == "waiting"]
    assert e.cp.events[-1] == ("turn.ended", {"reason": "idle"}) and e.worker.cli_started
    assert e.store.state()["codexThreadId"] == e.runner.thread_id
    await e.close()


async def test_a_new_process_resumes_the_stored_thread(env):
    e = env({"turns": [["user"], ["user"]]})
    await e.run(inp(1))
    first = e.runner.thread_id
    await e.close()
    e.new_process()
    await e.run(inp(2))
    assert len(e.params("thread/start")) == 1
    resume = e.params("thread/resume")[0]
    assert resume["threadId"] == first and resume["excludeTurns"] is True and resume["developerInstructions"] == "Be careful."
    await e.close()


async def test_a_lost_rollout_starts_a_new_thread_with_the_recovery_note(env, capsys):
    e = env({"turns": [["user"]]})
    e.store.update_state(codexThreadId="gone", codexThreadPath="/nowhere.jsonl", codexTurnAt="2026-11-03T00:00:00Z")
    await e.run(inp(1))
    assert [p["threadId"] for p in e.params("thread/resume")] == ["gone", "gone"]  # by id, then by path
    assert len(e.params("thread/start")) == 1 and e.store.state()["codexThreadId"] != "gone"
    assert render.RECOVERY_NOTE in e.params("turn/start")[0]["input"][0]["text"]
    assert "codex_thread_lost" in capsys.readouterr().out
    await e.close()


async def test_a_thread_that_never_ran_a_turn_restarts_without_the_recovery_note(env):
    e = env({"turns": [["user"]]})
    e.store.update_state(codexThreadId="never-used", codexThreadPath="/nowhere.jsonl")  # rollouts appear with the first turn
    await e.run(inp(1))
    assert len(e.params("thread/start")) == 1 and render.RECOVERY_NOTE not in e.params("turn/start")[0]["input"][0]["text"]
    assert e.store.state()["codexTurnAt"]
    await e.close()


async def test_an_unknown_tool_answers_unsuccessfully(env):
    e = env({"turns": [["user", ["tool", "rm_rf", {}]]]})
    await e.run(inp(1))
    assert e.log("answer")[0]["response"]["result"]["success"] is False
    await e.close()


async def test_inputs_during_a_turn_are_steered_at_a_tool_boundary(env):
    e = env({"turns": [["user", ["tool", "ack", {"trigger_id": "t1", "text": "on it"}], "steer-wait"]]})
    e.cp.on["ack"] = lambda: e.store.append([inp(2, "also update the docs")])
    await e.run(inp(1))
    steer = e.params("turn/steer")
    assert len(steer) == 1 and steer[0]["expectedTurnId"] == "turn-0" and "also update the docs" in steer[0]["input"][0]["text"]
    assert {"inputIds": ["in-2"]} in [b for k, b in e.cp.events if k == "inputs.read"]
    assert len(e.params("turn/start")) == 1
    await e.close()


async def test_a_failed_steer_leaves_the_input_for_the_next_turn(env):
    e = env({"steer_fail": True, "turns": [["user", ["tool", "ack", {"trigger_id": "t1", "text": "on it"}]], ["user"]]})
    e.cp.on["ack"] = lambda: e.store.append([inp(2, "also update the docs")])
    await e.run(inp(1))
    turns = e.params("turn/start")
    assert len(turns) == 2 and "also update the docs" in turns[1]["input"][0]["text"]
    await e.close()


async def test_stop_interrupts_the_turn(env):
    e = env({"turns": [["user", ["tool", "ack", {"trigger_id": "t1", "text": "on it"}], "interrupt-wait"]]})
    e.cp.on["ack"] = lambda: asyncio.ensure_future(e.worker.stop())
    await e.run(inp(1))
    assert e.params("turn/interrupt")[0]["turnId"] == "turn-0"
    assert e.cp.events[-1] == ("turn.ended", {"reason": "interrupted"})
    assert not [b for k, b in e.cp.events if k == "report"]
    await e.close()


async def test_a_throttled_turn_retries_with_continue(env):
    e = env({"turns": [["user", ["fail", {"responseStreamDisconnected": {"httpStatusCode": 429}}]], ["user"]]})
    await e.run(inp(1, "fix the login bug"))
    turns = e.params("turn/start")
    assert e.sleeps == [15] and len(turns) == 2
    assert "Continue the assignment" in turns[1]["input"][0]["text"] and "fix the login bug" not in turns[1]["input"][0]["text"]
    await e.close()


async def test_a_forbidden_turn_fails_at_once(env):
    e = env({"turns": [["user", ["fail", {"httpConnectionFailed": {"httpStatusCode": 403}}]]]})
    await e.run(inp(1))
    assert e.sleeps == [] and ("report", {"state": "failed", "text": "The worker failed: turn failed: boom"}) in e.cp.events
    await e.close()


async def test_an_app_server_that_dies_before_recording_the_prompt_gets_it_again(env):
    e = env({"turns": [["die"], ["user"]]})
    await e.run(inp(1, "fix the login bug"))
    turns = e.params("turn/start")
    assert e.sleeps == [15] and len(turns) == 2 and "fix the login bug" in turns[1]["input"][0]["text"]
    assert len({line["pid"] for line in e.log("env")}) == 2 and e.params("thread/resume")  # a new server resumed the thread
    await e.close()


async def test_an_app_server_that_dies_after_recording_the_prompt_continues(env):
    e = env({"turns": [["user", "die"], ["user"]]})
    await e.run(inp(1, "fix the login bug"))
    turns = e.params("turn/start")
    assert len(turns) == 2 and "fix the login bug" not in turns[1]["input"][0]["text"]
    await e.close()


async def test_a_prompt_recorded_without_a_notification_is_not_sent_twice(env):
    """The crash came after the rollout write but before its notification: the failure path reads the rollout."""
    e = env({"turns": [["user-silent", "die"], ["user"]]})
    await e.run(inp(1, "fix the login bug"))
    turns = e.params("turn/start")
    assert len(turns) == 2 and "fix the login bug" not in turns[1]["input"][0]["text"]
    await e.close()


SERVER_REQUESTS = [("item/commandExecution/requestApproval", {"decision": "accept"}), ("item/fileChange/requestApproval", {"decision": "accept"}),
                   ("execCommandApproval", {"decision": "approved"}), ("applyPatchApproval", {"decision": "approved"}),
                   ("item/permissions/requestApproval", {"permissions": {}}), ("item/tool/requestUserInput", {"answers": {}}),
                   ("mcpServer/elicitation/request", {"action": "decline", "content": None})]


async def test_every_server_request_gets_an_answer(env):
    methods = [m for m, _ in SERVER_REQUESTS] + ["currentTime/read", "account/chatgptAuthTokens/refresh", "attestation/generate", "made/up"]
    e = env({"turns": [["user", *[["request", m, {}] for m in methods]]]})
    await e.run(inp(1))
    answers = {a["method"]: a["response"] for a in e.log("answer")}
    for method, result in SERVER_REQUESTS:
        assert answers[method]["result"] == result
    assert isinstance(answers["currentTime/read"]["result"]["currentTimeAt"], int)
    for method in ("account/chatgptAuthTokens/refresh", "attestation/generate", "made/up"):
        assert answers[method]["error"]["code"] == -32601
    await e.close()


async def test_model_and_effort_follow_the_config_of_each_turn(env, capsys):
    e = env({"turns": [["user"], ["user"], ["user"]]})
    await e.run(inp(1))
    e.set_config({**CONFIG, "model": "global.openai.gpt-6.1-sol", "effort": "low"})
    await e.run(inp(2))
    e.set_config({k: v for k, v in CONFIG.items() if k != "effort"} | {"effort": "ultra"})
    await e.run(inp(3))
    turns = e.params("turn/start")
    assert [(t["model"], t.get("effort")) for t in turns] == [("global.openai.gpt-6.1-terra", "high"), ("global.openai.gpt-6.1-sol", "low"),
                                                              ("global.openai.gpt-6.1-terra", None)]
    assert "effort_ignored" in capsys.readouterr().out
    assert len({line["pid"] for line in e.log("env")}) == 1  # same prompt and skills: the server keeps running
    await e.close()


async def test_a_changed_prompt_or_skills_restarts_the_server_and_resumes_with_it(env):
    e = env({"turns": [["user"], ["user"]]})
    await e.run(inp(1))
    e.set_config({**CONFIG, "systemPrompt": "Be bold.", "skills": [{"name": "dsh-superagent-review", "content": "x"}]})
    await e.run(inp(2))
    assert len({line["pid"] for line in e.log("env")}) == 2
    assert e.params("thread/resume")[0]["developerInstructions"] == "Be bold."
    # codex injects developerInstructions only at thread start: the new prompt rides on the next turn, once.
    turns = e.params("turn/start")
    assert "additionalContext" not in turns[0]
    note = turns[1]["additionalContext"]["dshsa-instructions"]
    assert note["kind"] == "application" and note["value"].endswith("Be bold.")
    assert (e.tmp / "work" / ".codex" / "skills" / "dsh-superagent-review" / "SKILL.md").exists()
    await e.close()


async def test_the_server_env_keeps_credentials_and_drops_denied_names(env):
    e = env({"turns": [["user"]]}, {**CONFIG, "env": {"AWS_REGION": "us-east-1", "OPENAI_API_KEY": "k", "FOO": "bar", "HOME": "/x"}})
    e.runner.base_env.update({"AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://169.254.170.23/v1/credentials", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/t",
                              "AWS_REGION": "ap-northeast-1", "AWS_BEARER_TOKEN_BEDROCK": "secret", "AWS_PROFILE": "ticket-mount",
                              "AWS_SHARED_CREDENTIALS_FILE": "/root/.aws/credentials", "CODEX_HOME": "/elsewhere", "OPENAI_BASE_URL": "x"})
    await e.run(inp(1))
    seen = e.log("env")[0]["env"]
    assert seen["AWS_CONTAINER_CREDENTIALS_FULL_URI"] and seen["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"] == "/t" and seen["AWS_REGION"] == "ap-northeast-1"
    for name in ("AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "OPENAI_BASE_URL", "OPENAI_API_KEY"):
        assert name not in seen
    assert seen["CODEX_HOME"] == str(e.tmp / "work" / ".codex") and seen["HOME"] == "/home/agent" and seen["FOO"] == "bar"
    await e.close()


# ---- pure parts ------------------------------------------------------------------------------------------------------
def test_rendered_config_and_overrides_lock_the_codex_down():
    rendered = codex_runner.render_config(open(codex_runner.TEMPLATE).read(), "ap-northeast-1", "/local")
    for line in ['model_provider = "amazon-bedrock-runtime"', 'chatgpt_base_url = "http://127.0.0.1:9"', 'web_search = "disabled"',
                 'forced_login_method = "api"', 'sqlite_home = "/local"', 'region = "ap-northeast-1"', "plugins = false", "multi_agent = false",
                 "memories = false", "apps = false", "browser_use = false", "computer_use = false", "image_generation = false",
                 "unbounded_connection_retries = false", "guardian_approval = false", 'persistence = "none"']:
        assert line in rendered, line
    assert "[skills.bundled]\nenabled = false" in rendered and "{" not in rendered.replace("{region}", "")
    args = codex_runner.config_overrides()
    pairs = dict(arg.split("=", 1) for arg in args[1::2])
    assert args[::2] == ["-c"] * len(pairs)
    assert pairs["model_provider"] == '"amazon-bedrock-runtime"' and pairs["skills.bundled.enabled"] == "false"
    assert pairs["features.multi_agent"] == "false" and pairs["chatgpt_base_url"] == '"http://127.0.0.1:9"'
    assert pairs["features.guardian_approval"] == "false"


def test_prepare_home_leaves_only_the_cells_skills(tmp_path):
    home, user = tmp_path / ".codex", tmp_path / "home" / ".agents" / "skills"
    (home / "skills" / ".system" / "skill-installer").mkdir(parents=True)
    (home / "skills" / "old").mkdir()
    (user / "mine").mkdir(parents=True)
    codex_runner.prepare_home(str(home), {"skills": [{"name": "dsh-superagent-x", "content": "c"}]}, region="r", local=str(tmp_path / "l"),
                              user_skills=str(user))
    assert sorted(p.name for p in (home / "skills").iterdir()) == ["dsh-superagent-x"]
    assert not user.exists() and (home / "config.toml").read_text().count('region = "r"') == 1


SKILLS_BLOCK = """<skills_instructions>
## Skills
### Skill roots
- `r0` = `{home}/skills`
- `r1` = `{repo}/.agents/skills`
{extra}### Available skills
- dsh-superagent-x: Ours. (file: r0/dsh-superagent-x/SKILL.md)
- repo-skill: The repo's. (file: r1/repo-skill/SKILL.md)
{extra_skill}</skills_instructions>"""


def write_listing(tmp_path, extra="", extra_skill=""):
    path = tmp_path / "rollout.jsonl"
    text = SKILLS_BLOCK.format(home="/mnt/work/.codex", repo="/home/agent/work/repo", extra=extra, extra_skill=extra_skill)
    content = [{"type": "input_text", "text": text}]
    path.write_text(json.dumps({"type": "response_item", "payload": {"type": "message", "role": "developer", "content": content}}) + "\n")
    return str(path)


def test_skills_listing_accepts_the_cell_and_repo_roots(tmp_path):
    listing = codex_runner.skills_listing(write_listing(tmp_path))
    assert listing["roots"] == {"r0": "/mnt/work/.codex/skills", "r1": "/home/agent/work/repo/.agents/skills"}
    assert listing["skills"] == [("dsh-superagent-x", "r0"), ("repo-skill", "r1")]
    assert codex_runner.unexpected_skills(listing, "/mnt/work/.codex", "/home/agent/work/repo", {"dsh-superagent-x"}) == []


def test_skills_listing_flags_user_system_admin_roots_and_extra_names(tmp_path):
    extra = "- `r2` = `/home/agent/.agents/skills`\n- `r3` = `/mnt/work/.codex/skills/.system`\n- `r4` = `/etc/codex/skills`\n"
    listing = codex_runner.skills_listing(write_listing(tmp_path, extra, "- stale: x (file: r0/stale/SKILL.md)\n"))
    problems = codex_runner.unexpected_skills(listing, "/mnt/work/.codex", "/home/agent/work/repo", {"dsh-superagent-x"})
    assert problems == ["root r2=/home/agent/.agents/skills", "root r3=/mnt/work/.codex/skills/.system", "root r4=/etc/codex/skills", "skill stale"]


@pytest.mark.parametrize("info, status", [({"responseStreamDisconnected": {"httpStatusCode": 503}}, 503), ("usageLimitExceeded", 429),
                                          ("contextWindowExceeded", 400), ({"unauthorized": None}, 401), (None, None), ("other", None)])
def test_error_status(info, status):
    assert codex_runner.error_status(info) == status
    if status:
        assert agent_core.transient(codex_runner.CodexTurnError("x", status)) is (status in (429, 503))


async def test_steer_with_marks_inputs_read_only_once_delivered(tmp_path):
    store = Store(str(tmp_path))
    store.ensure()
    cp = Cp()
    w = agent_core.Worker(store, cp, None, repo_dir=str(tmp_path), config_dir=str(tmp_path))
    store.append([inp(1)])

    async def refuse(text):
        return False

    async def accept(text):
        return "message number 1" in text
    assert await w.steer_with(refuse) is False and [i["id"] for i in store.unread()] == ["in-1"] and cp.events == []
    assert await w.steer_with(accept) is True and store.unread() == [] and cp.events == [("inputs.read", {"inputIds": ["in-1"]})]


async def test_a_new_vm_sends_a_prompt_that_changed_since_the_thread_started_once(env):
    e = env({"turns": [["user"], ["user"], ["user"]]})
    await e.run(inp(1))
    await e.close()
    e.set_config({**CONFIG, "systemPrompt": "Be bold."})
    e.new_process()  # a fresh VM: no memory of what the running server was started with, only state.json
    await e.run(inp(2))
    await e.run(inp(3))
    turns = e.params("turn/start")
    assert ["additionalContext" in t for t in turns] == [False, True, False]
    await e.close()


def test_skill_roots_are_compared_as_real_paths(tmp_path):
    (tmp_path / "real" / "work" / ".codex" / "skills").mkdir(parents=True)
    (tmp_path / "real" / "repo" / ".agents" / "skills").mkdir(parents=True)
    (tmp_path / "link").symlink_to(tmp_path / "real", target_is_directory=True)
    listing = {"roots": {"r0": str(tmp_path / "real" / "work" / ".codex" / "skills"), "r1": str(tmp_path / "real" / "repo" / ".agents" / "skills")},
               "skills": [("dsh-superagent-x", "r0")]}
    assert codex_runner.unexpected_skills(listing, str(tmp_path / "link" / "work" / ".codex"), str(tmp_path / "link" / "repo"), {"dsh-superagent-x"}) == []


def test_a_cell_skill_codex_did_not_load_is_flagged(tmp_path):
    listing = {"roots": {}, "skills": []}  # codex refused every SKILL.md (no frontmatter): it lists nothing
    assert codex_runner.unexpected_skills(listing, "/mnt/work/.codex", "/home/agent/work/repo", {"dsh-superagent-github"}) == [
        "missing skill dsh-superagent-github"]
