"""Live L1 probe of the Codex worker runner against real Bedrock (opt-in; codex-worker implement.md L1). Not collected by pytest.

Runs `codex_runner.CodexRunner` + `agent_core.Worker` exactly as the codex image does (fake control plane, local scratch dirs):
  1. one turn per model (gpt-6.1-terra, gpt-6-astra, gpt-6.1-sol) that must call the DSH `report` tool;
  2. resume from a fresh CODEX_HOME that holds only a copy of `sessions/` (a new microVM on the same AP);
  3. a turn that runs a shell command and edits a file (captures the CommandExecution / FileChange rollout shapes);
  4. a systemPrompt + skills change: the app-server restarts and resumes the thread with the new developer instructions;
  5. the skills the model is shown: only the cell's (pre-seeded `.system` must be gone) and the repo's `.agents/skills`.
Makes Bedrock calls only (InvokeModel via the Responses API, region ap-northeast-1): no deploy, no other AWS writes. Credentials:
the desktop chain's frozen session keys, passed as env vars (AWS_BEARER_TOKEN_BEDROCK is denied by child_env, as in the image).

Usage (from worker/):  DSHSA_LIVE=1 CODEX_BIN=<pinned codex 0.166.0 binary> uv run python tests/live/codex_l1.py [out.json]
Persists only redacted results (home paths, account ids).
"""
from __future__ import annotations

import asyncio
import contextlib
import getpass
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "..", "container"), os.path.join(HERE, "..", "..", "..", "packages", "contracts", "python")]

import agent_core  # noqa: E402
import boto3  # noqa: E402
import codex_runner  # noqa: E402
from inbox import Store  # noqa: E402

REGION = "ap-northeast-1"
MODELS = ["global.openai.gpt-6.1-terra", "global.openai.gpt-6-astra", "global.openai.gpt-6.1-sol"]
ROOT = os.path.expanduser("~/.cache/dshsa-codex-l1")
SKILL = {"name": "dsh-superagent-probe", "content": "---\nname: dsh-superagent-probe\ndescription: Probe skill of the dshsa worker.\n---\nSay probe.\n"}
SKILL2 = {"name": "dsh-superagent-probe-two", "content": "---\nname: dsh-superagent-probe-two\ndescription: Second probe skill.\n---\nSay two.\n"}
REPORT = "Call the report tool exactly once with state \"progress\" and summary \"{tag}\". Do nothing else and do not run commands."


def redact(value):
    text = json.dumps(value)
    for path, label in ((os.path.realpath(ROOT), "<root>"), (ROOT, "<root>"), (os.path.realpath(os.path.expanduser("~")), "<home>"),
                        (os.path.expanduser("~"), "<home>")):
        text = text.replace(path, label)
    text = re.sub(r"\b\d{12}\b", "<account>", text)
    text = text.replace(getpass.getuser(), "<user>")
    text = re.sub(r"(AKIA|ASIA)[A-Z0-9]{16}", "<key>", text)
    return json.loads(text)


class Tee(io.TextIOBase):
    """Captures the runner's JSON log lines (and keeps them visible)."""

    def __init__(self, out):
        self.out, self.lines, self.buf = out, [], ""

    def write(self, s):
        self.out.write(s)
        self.buf += s
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            with contextlib.suppress(ValueError):
                self.lines.append(json.loads(line))
        return len(s)

    def flush(self):
        self.out.flush()

    def events(self, name):
        return [line for line in self.lines if line.get("event") == name]


class Cp:
    def __init__(self):
        self.events = []

    async def event(self, kind, body, tries=4):
        self.events.append((kind, body))
        return {"status": 200, "ok": True}

    async def read(self, resource):
        return {"status": 200, "content": f"(probe) {resource}"}


def credentials_env() -> dict[str, str]:
    frozen = boto3.Session().get_credentials().get_frozen_credentials()
    env = {k: v for k, v in os.environ.items() if k not in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE")}
    env.update(AWS_ACCESS_KEY_ID=frozen.access_key, AWS_SECRET_ACCESS_KEY=frozen.secret_key, AWS_REGION=REGION, AWS_DEFAULT_REGION=REGION)
    if frozen.token:
        env["AWS_SESSION_TOKEN"] = frozen.token
    return env


class Ticket:
    def __init__(self, name: str, base_env: dict[str, str], codex_bin: str):
        self.dir = os.path.join(ROOT, name)
        shutil.rmtree(self.dir, ignore_errors=True)
        self.work, self.repo, self.local = os.path.join(self.dir, "work"), os.path.join(self.dir, "repo"), os.path.join(self.dir, "local")
        os.makedirs(os.path.join(self.repo, ".agents", "skills", "repo-probe"))
        with open(os.path.join(self.repo, ".agents", "skills", "repo-probe", "SKILL.md"), "w") as f:
            f.write("---\nname: repo-probe\ndescription: A skill shipped in the repository.\n---\nSay repo.\n")
        with open(os.path.join(self.repo, "README.md"), "w") as f:
            f.write("# probe repo\n")
        subprocess.run(["git", "init", "-q"], cwd=self.repo, check=True)
        self.store = Store(self.work)
        self.store.ensure()
        self.base_env, self.codex_bin, self.cp = base_env, codex_bin, Cp()
        os.makedirs(os.path.join(self.work, ".codex", "skills", ".system", "skill-installer"))  # must be removed before start

    def config(self, model, prompt="You are the dshsa probe worker.", skills=(SKILL,), effort="low"):
        self.store.save_config({"ticketKey": "probe", "ticket": {"ticketId": "probe", "mandate": {}},
                                "config": {"model": model, "effort": effort, "systemPrompt": prompt, "skills": list(skills), "env": {"FOO": "bar"}}})

    def process(self, codex_home=None, local=None):
        self.runner = codex_runner.CodexRunner(
            codex_home=codex_home or os.path.join(self.work, ".codex"), repo_dir=self.repo, local_dir=local or self.local, region=REGION,
            command=[self.codex_bin, "app-server", *codex_runner.config_overrides()], user_skills=os.path.join(self.dir, "home", ".agents", "skills"),
            base_env=self.base_env)

        async def no_sleep(_s):
            return None
        self.worker = agent_core.Worker(self.store, self.cp, self.runner, repo_dir=self.repo, config_dir=os.path.join(self.work, ".codex"),
                                        sleep=no_sleep)

    async def turn(self, text, n):
        self.store.append([{"id": f"in-{n}", "kind": "text", "at": "2026-11-03T00:00:00Z", "text": text}])
        self.worker.run("assignment-0", recovery=False)
        await asyncio.sleep(0)
        await asyncio.wait_for(self.worker._task, 600)

    def reports(self):
        return [body for kind, body in self.cp.events if kind == "report"]

    async def close(self):
        if self.runner.server:
            await self.runner.server.close()


def rollout_lines(path, predicate):
    out = []
    with open(path) as f:
        for line in f:
            with contextlib.suppress(ValueError):
                value = json.loads(line)
                if predicate(value):
                    out.append(value)
    return out


async def main(out_path: str | None) -> dict:
    if os.environ.get("DSHSA_LIVE") != "1" or not os.environ.get("CODEX_BIN"):
        sys.exit("opt-in: set DSHSA_LIVE=1 and CODEX_BIN=<codex 0.166.0 binary>")
    codex_bin = os.environ["CODEX_BIN"]
    env = credentials_env()
    identity = boto3.client("sts", region_name=REGION).get_caller_identity()["Arn"]
    tee = Tee(sys.stdout)
    results: dict = {"codex": subprocess.run([codex_bin, "--version"], capture_output=True, text=True).stdout.strip(), "caller": identity,
                     "checks": {}}
    checks = results["checks"]
    with contextlib.redirect_stdout(tee):
        # 1. one turn per model with a DSH tool call
        terra = None
        for i, model in enumerate(MODELS):
            t = Ticket(model.rsplit(".", 1)[-1].replace("gpt-", ""), env, codex_bin)
            t.config(model)
            t.process()
            started = time.monotonic()
            await t.turn(REPORT.format(tag=f"probe {model}"), 1)
            ok = any(r.get("text") == f"probe {model}" and r.get("state") == "progress" for r in t.reports())
            checks[f"turn_{model}"] = {"ok": ok, "s": round(time.monotonic() - started, 1), "reports": t.reports(),
                                       "turn": (tee.events("codex_turn") or [{}])[-1], "ended": t.cp.events[-1]}
            if i == 0:
                terra = t
            else:
                await t.close()
        assert terra is not None
        # 5. skills shown to the model (first turn of the terra server)
        skills = tee.events("codex_skills")
        checks["skills"] = {"ok": bool(skills) and not tee.events("codex_skills_unexpected")
                            and not os.path.exists(os.path.join(terra.work, ".codex", "skills", ".system")),
                            "listing": skills[0] if skills else None, "unexpected": tee.events("codex_skills_unexpected")}
        # 2. resume from a fresh CODEX_HOME holding only a copy of sessions/ (a new VM: empty SQLite, new local dir)
        await terra.close()
        fresh = os.path.join(terra.dir, "fresh-codex-home")
        shutil.copytree(os.path.join(terra.work, ".codex", "sessions"), os.path.join(fresh, "sessions"))
        before = terra.runner.thread_id
        terra.process(codex_home=fresh, local=os.path.join(terra.dir, "fresh-local"))
        await terra.turn("Call the report tool exactly once with state \"progress\" and, as summary, the exact summary text you reported in "
                         "your previous report. Do nothing else.", 2)
        checks["resume_fresh_home"] = {"ok": terra.runner.thread_id == before and bool(tee.events("codex_thread_resumed"))
                                       and any(r.get("text") == f"probe {MODELS[0]}" for r in terra.reports()[1:]),
                                       "reports": terra.reports()[1:], "resumed": tee.events("codex_thread_resumed")[-1:]}
        # 3. shell command + file edit (on the original home again)
        await terra.close()
        terra.process()
        await terra.turn("Run the shell command `ls -a` in the repository. Then create a file NOTES.md containing exactly the line hello, "
                         "using your file editing tool. Then call the report tool once with state \"progress\" and summary \"edited\".", 3)
        path = terra.runner.thread_path
        commands = rollout_lines(path, lambda v: v.get("type") == "event_msg" and (v.get("payload") or {}).get("type") == "item_completed"
                                 and (v["payload"].get("item") or {}).get("type") in ("CommandExecution", "FileChange"))
        calls = rollout_lines(path, lambda v: v.get("type") == "response_item" and (v.get("payload") or {}).get("type") not in ("message",))
        notes = os.path.join(terra.repo, "NOTES.md")
        kinds = {c["payload"]["item"]["type"] for c in commands}
        checks["shell_and_edit"] = {"ok": os.path.exists(notes) and open(notes).read().strip() == "hello" and {"CommandExecution", "FileChange"} <= kinds
                                    and any(r.get("text") == "edited" for r in terra.reports()), "item_kinds": sorted(kinds),
                                    "response_item_types": sorted({(c["payload"].get("type"), c["payload"].get("name")) for c in calls}, key=str)}
        results["rollout_shapes"] = {"item_completed": commands[:4], "response_items": [c for c in calls if c["payload"].get("type") != "reasoning"][:8]}
        # 4. prompt + skills change: restart and resume with the new developer instructions
        terra.config(MODELS[0], prompt="You are the dshsa probe worker, second edition.", skills=(SKILL, SKILL2))
        pid = terra.runner.server.proc.pid if terra.runner.server and terra.runner.server.proc else None
        await terra.turn(REPORT.format(tag="after prompt change"), 4)
        developer = rollout_lines(path, lambda v: v.get("type") == "response_item" and (v.get("payload") or {}).get("role") == "developer")
        texts = [item.get("text", "") for d in developer for item in d["payload"].get("content") or []]
        new_pid = terra.runner.server.proc.pid if terra.runner.server and terra.runner.server.proc else None
        context = rollout_lines(path, lambda v: "second edition" in json.dumps(v) and v.get("type") == "response_item")
        results["instructions_note_shape"] = context[:2]
        checks["prompt_change"] = {"ok": bool(tee.events("codex_instructions_changed")) and new_pid != pid and bool(tee.events("codex_instructions_sent"))
                                   and bool(context) and any("dsh-superagent-probe-two" in text for text in texts)
                                   and any(r.get("text") == "after prompt change" for r in terra.reports()), "reports": terra.reports()[-2:],
                                   "resumed": tee.events("codex_thread_resumed")[-1:]}
        await terra.close()
    results["ok"] = all(check["ok"] for check in checks.values())
    results = redact(results)
    if out_path:
        with open(out_path, "w") as f:
            json.dump(results, f, indent=1)
    return results


if __name__ == "__main__":
    result = asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
    print(json.dumps({k: v.get("ok") for k, v in result["checks"].items()}, indent=1), file=sys.stderr)
    sys.exit(0 if result["ok"] else 1)
