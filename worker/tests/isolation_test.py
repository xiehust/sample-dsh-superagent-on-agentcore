"""Deployed isolation and resume tests (parent PRD A3, A4) against dshsa-worker. Run from an admin workstation (needs kms:Sign on
the ticket key, lambda:InvokeFunction on the provisioner/broker, bedrock-agentcore:InvokeAgentRuntime[Command], StopRuntimeSession):

  cd worker && uv run python tests/isolation_test.py [--region ap-northeast-1] [--keep]

A3: from inside ticket X's microVM, as root with X's mount credentials: mounting X's AP works (control), mounting Y's AP is denied,
    mounting the file system root is denied, the execution role cannot read the data bucket, the agent user cannot read the
    credentials file; the broker refuses forged and expired tokens; X's session refuses Y's token.
A4: stop X's session (the microVM goes away); a deliver on the same runtimeSessionId resumes in a new microVM with the work
    directory and the SDK transcript intact.
Uses tenant `isotest`, cell `isotest--gh1`; the tickets' access points are deleted at the end unless --keep.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
import time
import uuid

import boto3
from botocore.config import Config
from cryptography.hazmat.primitives.asymmetric import ec

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "src"), os.path.join(HERE, "..", "..", "packages", "contracts", "python")]
import dshsa_contracts as contracts  # noqa: E402

from dshsa_worker.ticket_token import claims_for, kms_sign, sign  # noqa: E402

TENANT, CELL = "isotest", "isotest--gh1"
failures = 0


def check(name: str, ok: bool, detail: str = "") -> bool:
    global failures
    failures += 0 if ok else 1
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)
    return ok


class Env:
    def __init__(self, region: str) -> None:
        self.region = region
        self.cfn = boto3.client("cloudformation", region_name=region)
        self.lmb = boto3.client("lambda", region_name=region)
        self.kms = boto3.client("kms", region_name=region)
        self.ac = boto3.client("bedrock-agentcore", region_name=region, config=Config(read_timeout=900, retries={"max_attempts": 2}))
        self.account = boto3.client("sts").get_caller_identity()["Account"]
        resources = self.cfn.describe_stack_resources(StackName="dshsa-worker")["StackResources"]
        runtime_id = next(r["PhysicalResourceId"] for r in resources if r["ResourceType"] == "AWS::BedrockAgentCore::Runtime")
        self.runtime_arn = runtime_id if runtime_id.startswith("arn:") else f"arn:aws:bedrock-agentcore:{region}:{self.account}:runtime/{runtime_id}"
        self.fs = next(o["OutputValue"] for o in self.cfn.describe_stacks(StackName="dshsa-worker")["Stacks"][0]["Outputs"]
                       if o["OutputKey"] == "DshsaFileSystemId")

    def lambda_call(self, name: str, payload: dict) -> dict:
        return json.loads(self.lmb.invoke(FunctionName=name, Payload=json.dumps(payload).encode())["Payload"].read())

    def provision(self, ticket: str, action: str = "ensure") -> dict:
        return self.lambda_call("dshsa-provisioner", {"action": action, "tenantId": TENANT, "cellId": CELL, "ticketId": ticket})

    def token(self, ticket: str, assignment: str = "a0", **overrides) -> str:
        return kms_sign({**claims_for(CELL, ticket, assignment), **overrides}, self.kms, contracts.TICKET_TOKEN_KEY_ALIAS)

    def invoke(self, ticket: str, action: str, token: str, inputs: list | None = None) -> dict:
        body = {"v": 1, "action": action, "token": token, "inputs": inputs or [],
                "ticket": {"tenantId": TENANT, "cellId": CELL, "ticketId": ticket, "assignmentId": "a0", "title": "isolation", "scope": "test", "mandate": {}},
                "config": {"model": contracts_model(), "systemPrompt": "Isolation test worker. Answer briefly; do not use tools unless asked.",
                           "skills": [], "env": {},
                           "repo": {"fullName": "octocat/Hello-World", "defaultBranch": "master", "cloneUrl": "https://github.com/octocat/Hello-World.git"}}}
        resp = self.ac.invoke_agent_runtime(agentRuntimeArn=self.runtime_arn, runtimeSessionId=contracts.runtime_session_id(CELL, ticket),
                                            payload=json.dumps(body).encode(), contentType="application/json", accept="application/json")
        return json.loads(resp["response"].read())

    def run_as_root(self, ticket: str, command: str, timeout: int = 120) -> tuple[int | None, str]:
        resp = self.ac.invoke_agent_runtime_command(agentRuntimeArn=self.runtime_arn, runtimeSessionId=contracts.runtime_session_id(CELL, ticket),
                                                    body={"command": f"bash -c {shlex.quote(command)}", "timeout": timeout})
        out, code = "", None
        for event in resp["stream"]:
            chunk = event.get("chunk", {})
            if "contentDelta" in chunk:
                out += chunk["contentDelta"].get("stdout", "") + chunk["contentDelta"].get("stderr", "")
            elif "contentStop" in chunk:
                code = chunk["contentStop"].get("exitCode")
        return code, out

    def stop(self, ticket: str) -> None:
        self.ac.stop_runtime_session(agentRuntimeArn=self.runtime_arn, runtimeSessionId=contracts.runtime_session_id(CELL, ticket))


def contracts_model() -> str:
    return os.environ.get("MODEL", "global.anthropic.claude-sonnet-5-5")


def wait_idle(env: Env, ticket: str, token: str, timeout: float = 300) -> str:
    deadline = time.time() + timeout
    state = "?"
    while time.time() < deadline:
        try:
            state = env.invoke(ticket, "status", token).get("state", "?")
        except Exception as error:  # noqa: BLE001 - keep polling; report what happened
            state = f"error:{type(error).__name__}"
        if state == "idle":
            return state
        time.sleep(5)
    return state


def main(region: str, keep: bool) -> int:
    env = Env(region)
    suffix = uuid.uuid4().hex[:8]
    x, y = f"iso-x-{suffix}", f"iso-y-{suffix}"
    rx, ry = env.provision(x), env.provision(y)
    aps = f"{rx.get('accessPointId')} {ry.get('accessPointId')}"
    if not check("provisioner creates both tickets' access points", rx.get("ok") is True and ry.get("ok") is True, aps):
        print("provisioning failed, aborting:", rx, ry)
        for ticket, rec in ((x, rx), (y, ry)):
            if rec.get("ok") is True:
                env.provision(ticket, "delete")
        return failures
    tx, ty = env.token(x), env.token(y)
    try:
        # ---- broker -------------------------------------------------------------------------------------------------
        forged = sign(claims_for(CELL, x, "a0"), ec.generate_private_key(ec.SECP256R1()), "forged-kid")
        now = int(time.time())
        expired = env.token(x, iat=now - 7200, exp=now - 3600)
        check("broker refuses a forged token", "error" in env.lambda_call("dshsa-broker", {"token": forged}))
        check("broker refuses an expired token", "error" in env.lambda_call("dshsa-broker", {"token": expired}))
        good = env.lambda_call("dshsa-broker", {"token": tx})
        check("broker mints for a valid token", good.get("accessPointId") == rx.get("accessPointId"), str(good.get("error", ""))[:200])

        # ---- start X with a first turn (creates the SDK transcript) ------------------------------------------------------
        t0 = time.time()
        res = env.invoke(x, "start", tx, [{"id": "in-1", "kind": "text", "at": "2026-11-01T00:00:00Z",
                                           "text": "Remember the codeword OSPREY-9. Reply with OK only."}])
        check("start X is accepted (mount + run)", res.get("ok") is True, f"{res} in {time.time() - t0:.1f}s")
        t0 = time.time()
        try:
            busy = env.invoke(x, "status", tx)
        except Exception as error:  # noqa: BLE001 - a 504 here is the failure being tested
            busy = {"ok": False, "error": type(error).__name__, "message": str(error)[:200]}
        check("status answers while the turn runs (< 5 s)", busy.get("ok") is True and time.time() - t0 < 5, f"{busy} in {time.time() - t0:.1f}s")
        print("  idle:", wait_idle(env, x, tx))
        res = env.invoke(x, "deliver", ty)
        check("X's session refuses Y's token", res.get("ok") is False, str(res))

        # ---- A3 as root inside X's microVM ---------------------------------------------------------------------------
        code, out = env.run_as_root(x, "id -u")
        check("InvokeAgentRuntimeCommand runs as root (worst case)", code == 0 and out.strip() == "0", out.strip()[:100])

        def try_mount(ap: str | None) -> str:
            target = f"/mnt/atk-{uuid.uuid4().hex[:6]}"
            opt = (f"accesspoint={ap}," if ap else "") + "awsprofile=ticket-mount,nodirects3read"
            _, out = env.run_as_root(x, f"mkdir -p {target} && timeout 90 mount -t s3files -o {opt} {env.fs}:/ {target} && echo MOUNTED && "
                                        f"ls {target} | head -3; umount {target} 2>/dev/null; true", timeout=150)
            return out
        denied = ("access denied", "accessdenied", "permission denied", "not authorized", "failed")
        out = try_mount(rx["accessPointId"])
        if check("control: X's credentials mount X's AP", "MOUNTED" in out, out.strip()[-200:]):
            out = try_mount(ry["accessPointId"])
            check("X's credentials cannot mount Y's AP (session policy)", "MOUNTED" not in out and any(d in out.lower() for d in denied), out.strip()[-200:])
            out = try_mount(None)
            check("X's credentials cannot mount the FS root (FS policy)", "MOUNTED" not in out and any(d in out.lower() for d in denied), out.strip()[-200:])
        bucket = f"dshsa-data-{env.account}"
        probe = f"import boto3; boto3.client('s3').list_objects_v2(Bucket='{bucket}', MaxKeys=1); print('LISTED')"
        _, out = env.run_as_root(x, f"python3.12 -c \"{probe}\" 2>&1 | tail -1")
        check("execution role cannot read the data bucket", "LISTED" not in out and "AccessDenied" in out, out.strip()[-160:])
        _, out = env.run_as_root(x, "/usr/sbin/runuser -u agent -- cat /root/.aws/credentials 2>&1; /usr/sbin/runuser -u agent -- id -u")
        check("agent user cannot read the mount credentials", "Permission denied" in out and "aws_secret_access_key" not in out, out.strip()[-120:])

        # ---- A4: lose the microVM, resume on the same session id (contract v5: local work tree + repo.bundle on the AP) ----
        local = "/home/agent/work/repo"
        env.run_as_root(x, f"/usr/sbin/runuser -u agent -- sh -c 'mkdir -p /mnt/work/out && echo a4-marker > /mnt/work/out/a4.txt && "
                           f"echo a4-edit >> {local}/README && echo a4-new > {local}/a4-new.txt'")
        # A turn end checkpoints the working copy to the bundle (the edit above was made outside a turn).
        env.invoke(x, "deliver", tx, [{"id": "in-ckpt", "kind": "text", "at": "2026-11-01T00:30:00Z", "text": "Reply with OK only."}])
        print("  idle:", wait_idle(env, x, tx))
        _, out = env.run_as_root(x, f"ls -l /mnt/work/repo.bundle; git -C {local} status --porcelain")
        check("turn end wrote repo.bundle to the AP", "repo.bundle" in out and "No such file" not in out, out.strip()[:200])
        # An edit after the last turn: survives only through the gateway's SIGTERM checkpoint (informational).
        env.run_as_root(x, f"/usr/sbin/runuser -u agent -- sh -c 'echo after-turn > {local}/a4-late.txt'")
        env.stop(x)
        time.sleep(10)
        t0 = time.time()
        res = env.invoke(x, "deliver", env.token(x), [{"id": "in-2", "kind": "text", "at": "2026-11-01T01:00:00Z",
                                                       "text": "What codeword did I give you earlier? Reply with the codeword only."}])
        check("deliver after the VM loss is accepted (new microVM)", res.get("ok") is True, f"{res} in {time.time() - t0:.1f}s")
        print("  idle:", wait_idle(env, x, env.token(x)))
        _, files = env.run_as_root(x, f"cat /mnt/work/out/a4.txt; test -d {local}/.git && echo HAS_GIT; tail -1 {local}/README; "
                                      f"cat {local}/a4-new.txt; git -C {local} status --porcelain")
        check("AP files survived the VM loss", "a4-marker" in files, files.strip()[:300])
        check("local edits survived via repo.bundle (modified + untracked)", "HAS_GIT" in files and "a4-edit" in files and "a4-new" in files,
              files.strip()[:300])
        _, late = env.run_as_root(x, f"test -e {local}/a4-late.txt && echo LATE_KEPT || echo LATE_LOST")
        print(f"  INFO  edit made after the last turn (SIGTERM checkpoint): {late.strip()}")
        _, transcript = env.run_as_root(x, "grep -ho 'OSPREY-9' /mnt/work/.claude/projects/*/*.jsonl | wc -l")
        count = transcript.strip().splitlines()[-1] if transcript.strip() else ""
        check("the SDK transcript holds the resumed answer", count.isdigit() and int(count) >= 2, count)
        _, watchdog = env.run_as_root(x, "pgrep -fa amazon-efs-mount-watchdog | grep -v pgrep | head -2")
        check("the efs mount watchdog runs (TLS + credential renewal)", "amazon-efs-mount-watchdog" in watchdog, watchdog.strip()[:200])
    finally:
        for ticket in (x, y):
            try:
                env.stop(ticket)
            except Exception:  # noqa: BLE001 - already gone
                pass
            if not keep:
                env.provision(ticket, "delete")
    print(f"\n{failures} failure(s)")
    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="ap-northeast-1")
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    sys.exit(main(args.region, args.keep))
