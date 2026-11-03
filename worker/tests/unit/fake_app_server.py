"""A scripted stand-in for `codex app-server` (0.166.0 wire shapes) for test_codex_runner.py. Standard library only; run with -I.

FAKE_DIR/script.json: {"turns": [[step, ...], ...], "steer_fail": bool}. Turns are counted across processes (FAKE_DIR/turns).
Steps: "user" (UserMessage to rollout + item/completed), "user-silent" (rollout only), ["tool", name, args], ["request", method, params], ["agent", text],
"steer-wait", "interrupt-wait", "die", ["fail", codexErrorInfo], "complete" (implicit at the end).
Everything received and every answer to a server request is appended to FAKE_DIR/log.jsonl.
"""
import json
import os
import select
import sys
import time
import uuid

D = os.environ["FAKE_DIR"]
SCRIPT = json.load(open(os.path.join(D, "script.json")))
THREADS = os.path.join(D, "threads.json")
BUF = b""
RESPONSES: dict = {}
SEEN = {"steer": 0, "interrupt": 0}
NEXT = [100]


def record(kind, value):
    with open(os.path.join(D, "log.jsonl"), "a") as f:
        f.write(json.dumps({"kind": kind, "pid": os.getpid(), **value}) + "\n")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def threads():
    return json.load(open(THREADS)) if os.path.exists(THREADS) else {}


def rollout(thread_id, line):
    with open(threads()[thread_id], "a") as f:
        f.write(json.dumps(line) + "\n")


def read_one(timeout):
    global BUF
    while b"\n" not in BUF:
        if not select.select([0], [], [], timeout)[0]:
            return False
        chunk = os.read(0, 65536)
        if not chunk:
            sys.exit(0)
        BUF += chunk
    line, BUF = BUF.split(b"\n", 1)
    message = json.loads(line)
    record("in", {"message": message})
    if "method" in message and "id" in message:
        handle(message)
    elif "id" in message:
        RESPONSES[message["id"]] = message
    return True


def wait(predicate, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end and not predicate():
        read_one(0.05)
    return predicate()


def server_request(method, params):
    NEXT[0] += 1
    rid = NEXT[0]
    send({"method": method, "id": rid, "params": params})
    wait(lambda: rid in RESPONSES)
    record("answer", {"method": method, "response": RESPONSES.get(rid)})
    return RESPONSES.get(rid)


def thread_result(thread_id):
    return {"thread": {"id": thread_id, "path": threads()[thread_id]}, "model": "m", "modelProvider": "amazon-bedrock-runtime"}


def handle(message):
    method, rid, params = message["method"], message["id"], message.get("params") or {}
    if method == "initialize":
        send({"id": rid, "result": {"userAgent": "fake/0.166.0"}})
    elif method == "thread/start":
        thread_id = str(uuid.uuid4())
        path = os.path.join(D, f"rollout-{thread_id}.jsonl")
        open(path, "w").write(json.dumps({"type": "session_meta", "payload": {"id": thread_id}}) + "\n")
        json.dump({**threads(), thread_id: path}, open(THREADS, "w"))
        send({"id": rid, "result": thread_result(thread_id)})
    elif method == "thread/resume":
        known = threads()
        if params.get("threadId") in known:
            send({"id": rid, "result": thread_result(params["threadId"])})
        else:
            send({"id": rid, "error": {"code": -32600, "message": "no rollout found for thread id"}})
    elif method == "turn/start":
        if any(c.get("name") is not None and c.get("kind") != "untrusted" for c in (params.get("additionalContext") or {}).values()):
            send({"id": rid, "error": {"code": -32600, "message": "additional context name is only supported for untrusted context"}})
            return
        turn(rid, params)
    elif method == "turn/steer":
        SEEN["steer"] += 1
        if SCRIPT.get("steer_fail"):
            send({"id": rid, "error": {"code": -32600, "message": "no active turn"}})
        else:
            send({"id": rid, "result": {"turnId": params.get("expectedTurnId")}})
    elif method == "turn/interrupt":
        SEEN["interrupt"] += 1
        send({"id": rid, "result": {}})
    else:
        send({"id": rid, "error": {"code": -32601, "message": f"fake: {method}"}})


def turn(rid, params):
    count_path = os.path.join(D, "turns")
    n = int(open(count_path).read()) if os.path.exists(count_path) else 0
    open(count_path, "w").write(str(n + 1))
    state_path = os.environ.get("FAKE_STATE")
    stored = json.load(open(state_path)).get("codexThreadId") if state_path and os.path.exists(state_path) else None
    record("turn", {"n": n, "threadStored": stored == params["threadId"]})
    thread_id, turn_id = params["threadId"], f"turn-{n}"
    send({"id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
    steps = SCRIPT["turns"][n] if n < len(SCRIPT["turns"]) else ["user"]

    def item(value):
        send({"method": "item/completed", "params": {"threadId": thread_id, "turnId": turn_id, "item": value, "completedAtMs": 0}})

    def completed(status, error=None):
        if status != "failed":
            rollout(thread_id, {"type": "event_msg", "payload": {"type": "task_complete" if status == "completed" else "turn_aborted", "turn_id": turn_id}})
        send({"method": "turn/completed", "params": {"threadId": thread_id, "turn": {"id": turn_id, "status": status, "error": error}}})

    for step in steps:
        kind = step if isinstance(step, str) else step[0]
        if kind in ("user", "user-silent"):  # user-silent: recorded in the rollout, but the server dies before it notifies
            rollout(thread_id, {"type": "event_msg", "payload": {"type": "item_completed", "turn_id": turn_id, "item": {"type": "UserMessage"}}})
            if kind == "user":
                item({"type": "userMessage", "id": "u", "content": []})
        elif kind == "tool":
            server_request("item/tool/call", {"threadId": thread_id, "turnId": turn_id, "callId": "c", "namespace": None, "tool": step[1],
                                              "arguments": step[2]})
            item({"type": "dynamicToolCall", "id": "c", "tool": step[1], "arguments": step[2], "status": "completed"})
        elif kind == "request":
            server_request(step[1], step[2])
        elif kind == "agent":
            item({"type": "agentMessage", "id": "a", "text": step[1], "phase": "final_answer"})
        elif kind == "developer":
            content = [{"type": "input_text", "text": step[1]}]
            rollout(thread_id, {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": content}})
        elif kind == "steer-wait":
            wait(lambda: SEEN["steer"] > 0, 5)
        elif kind == "interrupt-wait":
            wait(lambda: SEEN["interrupt"] > 0, 5)
            return completed("interrupted")
        elif kind == "die":
            os._exit(1)
        elif kind == "fail":
            return completed("failed", {"message": "boom", "codexErrorInfo": step[1]})
    completed("completed")


record("env", {"env": {k: v for k, v in os.environ.items() if k.startswith(("AWS_", "CODEX_", "OPENAI_", "HOME", "FOO"))}, "argv": sys.argv[1:]})
while True:
    read_one(1.0)
