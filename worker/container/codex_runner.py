"""The Codex worker's runner: turns of a `codex app-server` thread (codex 0.166.0, JSON-RPC over stdio) for `agent_core.Worker`.

Same contract as `agent_core.sdk_runner`: one call per turn, `worker.tool` for the six DSH tools (offered as dynamicTools),
`worker.interrupt` (turn/interrupt), `worker.cli_started`, `worker.turn.last_text`, `worker.turn.delivered`; a failed turn raises.
- One app-server per agent process, started on the first turn (after the V2 restore: never with pre-snapshot credentials),
  killed with the agent (PDEATHSIG), restarted when it died or when the cell's systemPrompt/skills changed (then resumed).
- The thread id is server-generated: stored in `.dshsa/state.json` before the first turn/start; a fresh VM resumes it from
  the rollout. CODEX_HOME is on local disk; only `$CODEX_HOME/sessions` links to the ticket's AP (`/mnt/work/.codex/sessions`), so
  codex's writer locks, SQLite, logs and helper links never outlive the VM (docs: network file systems; L8).
- Inputs that arrive during a turn are steered in with turn/steer at tool boundaries (`Worker.steer_with`).
Design: .trellis/tasks/11-03-codex-worker/design.md.
"""
from __future__ import annotations

import asyncio
import contextlib
import ctypes
import hashlib
import json
import os
import re
import shutil
import signal
import time
from collections.abc import Awaitable, Callable
from typing import Any

import agent_core
import dshsa_contracts as contracts
import render

PROVIDER = "amazon-bedrock-runtime"
DEFAULT_MODEL = contracts.DEFAULT_MODELS["worker"]["codex"]
# turn/start efforts of the pinned codex without `ultra` (it turns on sub-agents); the catalog's codex-worker set.
CODEX_EFFORTS = ("low", "medium", "high", "xhigh", "max")
TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex-config.toml")
CODEX_BIN = os.environ.get("CODEX_BIN", "codex")
LOCAL_DIR = os.environ.get("CODEX_LOCAL_DIR", "/home/agent/.codex-local")
USER_SKILLS = "/home/agent/.agents/skills"
ADMIN_SKILLS = "/etc/codex/skills"
TOOL_BOUNDARY = ("commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall")
# Every delta stream: the worker only needs completed items.
OPT_OUT = ["item/agentMessage/delta", "item/plan/delta", "command/exec/outputDelta", "process/outputDelta", "item/commandExecution/outputDelta",
           "item/fileChange/outputDelta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/reasoning/summaryPartAdded",
           "thread/realtime/item/transcript/delta", "thread/realtime/transcript/delta", "thread/realtime/outputAudio/delta"]
# `-c` overrides beat $CODEX_HOME/config.toml, which the agent could rewrite on the AP.
LOCKED = {"model_provider": PROVIDER, "forced_login_method": "api", "chatgpt_base_url": "http://127.0.0.1:9", "web_search": "disabled",
          "check_for_update_on_startup": False, "skills.bundled.enabled": False, "analytics.enabled": False, "feedback.enabled": False,
          "history.persistence": "none", "features.plugins": False, "features.remote_plugin": False, "features.apps": False,
          "features.memories": False, "features.multi_agent": False, "features.multi_agent_v2": False, "features.browser_use": False,
          "features.computer_use": False, "features.image_generation": False, "features.code_mode_host": False,
          "features.skill_mcp_dependency_install": False, "features.unbounded_connection_retries": False, "features.guardian_approval": False}
# Never from the process environment: the API-key path, the gateway's root-only mount profile, other agents' settings.
DENY_ENV = ("AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE")
DENY_PREFIX = ("OPENAI_", "CODEX_")
FLUSH_WAIT_S = 5.0
READ_LIMIT = 64 << 20  # one JSON-RPC line (a command's aggregated output) may be large
PR_SET_PDEATHSIG = 1


def log(event: str, **fields: Any) -> None:
    print(json.dumps({"component": "agent", "event": event, **fields}), flush=True)


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{code} {message}")
        self.code, self.data = code, data
        reason = data.get("reason") if isinstance(data, dict) else None
        self.status = 503 if reason == "serverShuttingDown" else 400


class CodexTurnError(RuntimeError):
    """A failed turn; `status` feeds `agent_core.transient` (408/429/5xx retry, other 4xx fail at once)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class AppServerExited(CodexTurnError):
    def __init__(self, detail: str = "") -> None:
        super().__init__(f"codex app-server exited{': ' + detail if detail else ''}", 503)


def error_status(info: Any) -> int | None:
    """HTTP-like status of a turn error's `codexErrorInfo`: a string tag or `{tag: {httpStatusCode}}`."""
    if isinstance(info, dict):
        for tag, value in info.items():
            code = value.get("httpStatusCode") if isinstance(value, dict) else None
            if isinstance(code, int):
                return code
            return error_status(tag)
        return None
    return {"usageLimitExceeded": 429, "serverOverloaded": 429, "unauthorized": 401, "badRequest": 400, "contextWindowExceeded": 400,
            "sandboxError": 400}.get(str(info))


# ---- configuration, environment, CODEX_HOME --------------------------------------------------------------------------
def toml_value(value: Any) -> str:
    return ("true" if value else "false") if isinstance(value, bool) else json.dumps(value)


def config_overrides() -> list[str]:
    return [arg for key, value in LOCKED.items() for arg in ("-c", f"{key}={toml_value(value)}")]


def render_config(template: str, region: str, local: str) -> str:
    return template.replace("{region}", region).replace("{local}", local)


def child_env(config: dict[str, Any], codex_home: str, local: str, base: dict[str, str] | None = None) -> dict[str, str]:
    """The agent's environment (AgentCore's credential provider variables included) minus DENY, plus the cell's filtered env."""
    base = dict(os.environ if base is None else base)
    env = {k: v for k, v in base.items() if k not in DENY_ENV and not k.startswith(DENY_PREFIX)}
    cell = {k: v for k, v in (config.get("env") or {}).items()
            if not k.startswith(("AWS_", "CODEX_", "OPENAI_", "LD_")) and k not in ("HOME", "PATH", "RUST_LOG")}
    return {**env, **cell, "HOME": "/home/agent", "CODEX_HOME": codex_home, "CODEX_SQLITE_HOME": local, "RUST_LOG": "warn", "GIT_TERMINAL_PROMPT": "0"}


def codex_effort(model: str, effort: Any) -> str | None:
    passed = contracts.worker_effort("codex", model, effort) if isinstance(effort, str) else None
    if passed in CODEX_EFFORTS:
        return passed
    if effort is not None:
        log("effort_ignored", effort=str(effort)[:20], model=model)
    return None


def prompt_hash(config: dict[str, Any]) -> str:
    return hashlib.sha256((config.get("systemPrompt") or "").encode()).hexdigest()[:32]


def instructions_note(system_prompt: str) -> dict[str, Any]:
    """turn/start.additionalContext for a thread whose developer instructions changed since it started: codex 0.166.0 injects
    `developerInstructions` only when a thread starts, never on resume (L1, 2026-11-03)."""
    text = ("The operator updated your instructions for this ticket. They replace the developer instructions you were given "
            "earlier:\n\n" + (system_prompt or "(none: follow your base instructions)"))
    return {"dshsa-instructions": {"kind": "application", "value": text}}  # `name` is accepted only on untrusted context


def instructions_hash(config: dict[str, Any]) -> str:
    skills = [{"name": s.get("name", ""), "content": s.get("content", "")} for s in config.get("skills") or []]
    return hashlib.sha256(json.dumps([config.get("systemPrompt", ""), skills], sort_keys=True).encode()).hexdigest()


def remove_tree(path: str, event: str) -> None:
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)
    else:
        return
    log(event, path=path)


def link_sessions(codex_home: str, sessions_dir: str) -> None:
    """`$CODEX_HOME/sessions` -> the ticket's AP (`/mnt/work/.codex/sessions`): only the rollouts are shared between microVMs.
    Everything else codex keeps in CODEX_HOME stays on this VM's disk, above all `thread-writer-locks/`: file locks on S3 Files
    (NFS) outlive a stopped VM by their lease, so a fresh VM found the thread "already has an active writer" (L8, 2026-11-03)."""
    os.makedirs(sessions_dir, exist_ok=True)
    link = os.path.join(codex_home, "sessions")
    if os.path.islink(link):
        if os.readlink(link) == sessions_dir:
            return
        os.unlink(link)
    elif os.path.isdir(link):  # rollouts written locally (never expected): keep them on the AP before linking
        for entry in os.listdir(link):
            target = os.path.join(sessions_dir, entry)
            if os.path.isdir(target) and os.path.isdir(os.path.join(link, entry)):
                shutil.copytree(os.path.join(link, entry), target, dirs_exist_ok=True)
            else:
                shutil.move(os.path.join(link, entry), target)
        shutil.rmtree(link)
    os.symlink(sessions_dir, link)


def prepare_home(codex_home: str, config: dict[str, Any], *, region: str, local: str, template: str = TEMPLATE,
                 user_skills: str = USER_SKILLS, sessions_dir: str | None = None) -> None:
    """Before an app-server start: the locked config, exactly the cell's skills, no bundled or user skill roots (design §6.1),
    and (in the image) the rollouts on the AP."""
    os.makedirs(codex_home, exist_ok=True)
    if sessions_dir:
        link_sessions(codex_home, sessions_dir)
    os.makedirs(os.path.join(local, "log"), exist_ok=True)
    with open(template) as f:
        rendered = render_config(f.read(), region, local)
    tmp = os.path.join(codex_home, "config.toml.tmp")
    with open(tmp, "w") as f:
        f.write(rendered)
    os.replace(tmp, os.path.join(codex_home, "config.toml"))
    agent_core.write_skills(codex_home, config.get("skills") or [])  # prunes `.system` and anything else not configured
    remove_tree(user_skills, "codex_user_skills_removed")


# ---- rollout reads (design §12: join on turn_id) ---------------------------------------------------------------------
def rollout_tail(path: str | None, max_bytes: int = 4 << 20) -> list[dict[str, Any]]:
    if not path:
        return []
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            data = f.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if size > max_bytes:
        lines = lines[1:]
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue  # a line still being written
    return out


def rollout_has(path: str | None, turn_id: str | None, kind: str) -> bool:
    """`kind`: "user" = the turn's UserMessage was recorded; "complete" = its task_complete (or turn_aborted) was."""
    if not turn_id:
        return False
    for line in rollout_tail(path):
        payload = line.get("payload") if isinstance(line, dict) else None
        if line.get("type") != "event_msg" or not isinstance(payload, dict) or payload.get("turn_id") != turn_id:
            continue
        if kind == "complete" and payload.get("type") in ("task_complete", "turn_aborted"):
            return True
        if kind == "user" and payload.get("type") == "item_completed" and (payload.get("item") or {}).get("type") == "UserMessage":
            return True
    return False


ROOT_LINE = re.compile(r"^- `(r\d+)` = `([^`]+)`", re.M)
SKILL_LINE = re.compile(r"^- ([^:\n]+): .*\(file: (r\d+)/", re.M)


def skills_listing(path: str | None) -> dict[str, Any] | None:
    """The newest `<skills_instructions>` developer message: {"roots": {rN: dir}, "skills": [(name, rN)]}."""
    found = None
    for line in rollout_tail(path):
        payload = line.get("payload") or {}
        if line.get("type") == "response_item" and payload.get("type") == "message" and payload.get("role") == "developer":
            for item in payload.get("content") or []:
                text = item.get("text", "") if isinstance(item, dict) else ""
                if "<skills_instructions>" in text:
                    found = text
    if found is None:
        return None
    return {"roots": dict(ROOT_LINE.findall(found)), "skills": [(name.strip(), root) for name, root in SKILL_LINE.findall(found)]}


def unexpected_skills(listing: dict[str, Any], codex_home: str, repo_dir: str, wanted: set[str]) -> list[str]:
    """Roots other than $CODEX_HOME/skills and `.agents/skills` under the repo, or extra names under $CODEX_HOME/skills."""
    real = os.path.realpath  # codex lists canonical paths (symlinks resolved)
    ours = real(os.path.join(codex_home, "skills")).rstrip("/")
    repo = real(repo_dir).rstrip("/") + "/"
    problems = []
    for key, root in listing["roots"].items():
        root = real(root).rstrip("/")
        if root != ours and not (root.startswith(repo) and root.endswith("/.agents/skills")) and root != repo + ".agents/skills":
            problems.append(f"root {key}={root}")
    shown = set()
    for name, key in listing["skills"]:
        if real(listing["roots"].get(key, "")).rstrip("/") == ours:
            shown.add(agent_core.skill_name(name))
            if agent_core.skill_name(name) not in wanted:
                problems.append(f"skill {name}")
    problems += [f"missing skill {name}" for name in sorted(wanted - shown)]  # e.g. a SKILL.md codex refused to load
    return problems


# ---- JSON-RPC over stdio -----------------------------------------------------------------------------------------------
def _pdeathsig() -> None:  # the app-server dies with the agent: a restarted agent never shares a rollout with an orphan
    ctypes.CDLL(None, use_errno=True).prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)


class AppServer:
    def __init__(self, command: list[str], env: dict[str, str], cwd: str,
                 on_request: Callable[[str, dict[str, Any]], Awaitable[Any]]) -> None:
        self.command, self.env, self.cwd, self.on_request = command, env, cwd, on_request
        self.proc: asyncio.subprocess.Process | None = None
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self.notifications: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
        self.next_id = 0
        self.exited = asyncio.Event()
        self._tasks: set[asyncio.Task[Any]] = set()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.returncode is None and not self.exited.is_set()

    async def start(self, client_version: str) -> None:
        self.proc = await asyncio.create_subprocess_exec(*self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                         stderr=asyncio.subprocess.PIPE, env=self.env, cwd=self.cwd, limit=READ_LIMIT,
                                                         preexec_fn=_pdeathsig)
        self._spawn(self._read())
        self._spawn(self._stderr())
        await self.request("initialize", {"clientInfo": {"name": "dshsa-worker", "title": "dshsa worker", "version": client_version},
                                          "capabilities": {"experimentalApi": True, "optOutNotificationMethods": OPT_OUT}}, timeout=60)
        await self._send({"method": "initialized", "params": {}})

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, message: dict[str, Any]) -> None:
        if not self.proc or not self.proc.stdin or self.exited.is_set():
            raise AppServerExited()
        try:
            self.proc.stdin.write((json.dumps(message) + "\n").encode())
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as error:
            raise AppServerExited(type(error).__name__) from error

    async def request(self, method: str, params: dict[str, Any], timeout: float | None = None) -> Any:
        self.next_id += 1
        rid = self.next_id
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            await self._send({"method": method, "id": rid, "params": params})
            return await asyncio.wait_for(future, timeout)
        finally:
            self.pending.pop(rid, None)

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while line := await self.proc.stdout.readline():
                try:
                    message = json.loads(line)
                except ValueError:
                    log("codex_bad_line", line=line[:200].decode(errors="replace"))
                    continue
                if not isinstance(message, dict):
                    continue
                if "method" in message and "id" in message:
                    self._spawn(self._answer(message))
                elif "method" in message:
                    await self.notifications.put((message["method"], message.get("params") or {}))
                elif "id" in message:
                    future = self.pending.get(message["id"])
                    if future and not future.done():
                        if "error" in message:
                            err = message["error"] or {}
                            future.set_exception(JsonRpcError(int(err.get("code", -32000)), str(err.get("message", "")), err.get("data")))
                        else:
                            future.set_result(message.get("result"))
        except (ValueError, asyncio.LimitOverrunError) as error:  # a line beyond READ_LIMIT: the stream is unusable
            log("codex_read_failed", error=str(error)[:200])
        finally:
            self.exited.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(AppServerExited())
            await self.notifications.put(None)

    async def _answer(self, message: dict[str, Any]) -> None:
        method, rid = message["method"], message["id"]
        try:
            result = await self.on_request(method, message.get("params") or {})
            reply: dict[str, Any] = {"id": rid, "result": result}
        except JsonRpcError as error:
            reply = {"id": rid, "error": {"code": error.code, "message": str(error)}}
        except Exception as error:  # noqa: BLE001 - every request gets an answer, or the turn blocks
            log("codex_request_failed", method=method, error=f"{type(error).__name__}: {str(error)[:200]}")
            reply = {"id": rid, "error": {"code": -32603, "message": str(error)[:500]}}
        with contextlib.suppress(AppServerExited):
            await self._send(reply)

    async def _stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while line := await self.proc.stderr.readline():
            print(json.dumps({"component": "codex", "line": line.decode(errors="replace").rstrip()[:500]}), flush=True)

    async def close(self) -> None:
        if self.proc and self.proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                self.proc.kill()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.proc.wait(), 5)
        self.exited.set()


# ---- the runner ----------------------------------------------------------------------------------------------------------
class CodexRunner:
    """`agent_core.Worker`'s runner for the Codex image (agent.py, DSHSA_AGENT=codex)."""

    def __init__(self, *, codex_home: str, repo_dir: str, local_dir: str = LOCAL_DIR, command: list[str] | None = None,
                 region: str | None = None, template: str = TEMPLATE, user_skills: str = USER_SKILLS, base_env: dict[str, str] | None = None,
                 flush_wait_s: float = FLUSH_WAIT_S, sessions_dir: str | None = None) -> None:
        self.codex_home, self.repo_dir, self.local_dir, self.template, self.user_skills = codex_home, repo_dir, local_dir, template, user_skills
        self.sessions_dir = sessions_dir
        self.command = command or [CODEX_BIN, "app-server", *config_overrides()]
        self.region = region or os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or contracts.REGION
        self.base_env, self.flush_wait_s = base_env, flush_wait_s
        self.server: AppServer | None = None
        self.started_with: str | None = None  # instructions_hash of the running server's thread
        self.thread_id: str | None = None
        self.thread_path: str | None = None
        self.lost_note = False
        self.skills_checked = False
        self.worker: agent_core.Worker | None = None

    # ---- server requests (all answered) ----------------------------------------------------------------------------
    async def on_request(self, method: str, params: dict[str, Any]) -> Any:
        if method == "item/tool/call":
            assert self.worker is not None
            tool = params.get("tool", "")
            if tool not in agent_core.DSHSA_TOOLS:
                return {"success": False, "contentItems": [{"type": "inputText", "text": f"unknown tool {tool}"}]}
            try:
                result = await self.worker.tool(tool, params.get("arguments") or {})
            except Exception as error:  # noqa: BLE001 - a bad argument is the model's to fix, not a failed turn
                result = {"status": 0, "error": f"{type(error).__name__}: {str(error)[:300]}"}
            ok = 200 <= int(result.get("status", 0) or 0) < 300
            return {"success": ok, "contentItems": [{"type": "inputText", "text": json.dumps(result)[:20000]}]}
        log("codex_server_request", method=method)
        if method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval"):
            return {"decision": "accept"}  # the policy is full access already; declining would only stall the work
        if method in ("execCommandApproval", "applyPatchApproval"):
            return {"decision": "approved"}
        if method == "item/permissions/requestApproval":
            return {"permissions": {}}
        if method == "item/tool/requestUserInput":
            return {"answers": {}}  # nobody is there to answer: the model reports with human_action instead
        if method == "mcpServer/elicitation/request":
            return {"action": "decline", "content": None}
        if method == "currentTime/read":
            return {"currentTimeAt": int(time.time())}
        raise JsonRpcError(-32601, f"{method} is not supported by the dshsa worker")

    # ---- server and thread ---------------------------------------------------------------------------------------
    async def ensure(self, worker: agent_core.Worker, config: dict[str, Any], model: str) -> None:
        wanted = instructions_hash(config)
        if self.server and self.server.alive() and self.started_with == wanted:
            return
        if self.server is not None:
            log("codex_instructions_changed" if self.server.alive() else "codex_server_restart")
            await self.server.close()
        started = time.monotonic()
        await asyncio.to_thread(prepare_home, self.codex_home, config, region=self.region, local=self.local_dir, template=self.template,
                                user_skills=self.user_skills, sessions_dir=self.sessions_dir)
        env = child_env(config, self.codex_home, self.local_dir, self.base_env)
        self.server = AppServer(self.command, env, self.repo_dir, self.on_request)
        await self.server.start(os.environ.get(contracts.WORKER_VERSION_ENV, "dev"))
        await self.open_thread(worker, config, model)
        self.started_with, self.skills_checked = wanted, False
        log("cli_started", ms=int((time.monotonic() - started) * 1000), first=not worker.cli_started, agent="codex")
        worker.cli_started = True  # the binary's start-up pages have been read: the gateway may release the snapshot pins

    async def open_thread(self, worker: agent_core.Worker, config: dict[str, Any], model: str) -> None:
        assert self.server
        common = {"cwd": self.repo_dir, "approvalPolicy": "never", "sandbox": "danger-full-access",
                  "developerInstructions": config.get("systemPrompt") or None, "model": model}
        state = await asyncio.to_thread(worker.store.state)
        stored, path = state.get("codexThreadId"), state.get("codexThreadPath")
        if stored:
            for extra in ({}, {"path": path} if path else None):
                if extra is None:
                    continue
                try:
                    result = await self.server.request("thread/resume", {"threadId": stored, "excludeTurns": True, **common, **extra}, timeout=120)
                    self._keep(result)
                    log("codex_thread_resumed", threadId=self.thread_id, by="path" if extra else "id")
                    return
                except JsonRpcError as error:
                    log("codex_resume_failed", threadId=stored, by="path" if extra else "id", error=str(error)[:300])
            # The rollout file appears with the first turn: a thread that never ran a turn lost no conversation.
            self.lost_note = bool(state.get("codexTurnAt"))
            log("codex_thread_lost", threadId=stored, hadTurns=self.lost_note)
        result = await self.server.request("thread/start", {**common, "modelProvider": PROVIDER, "serviceName": "dshsa-worker",
                                                            "dynamicTools": dynamic_tools()}, timeout=120)
        self._keep(result)
        await asyncio.to_thread(worker.store.update_state, codexThreadId=self.thread_id, codexThreadPath=self.thread_path,
                                codexThreadAt=agent_core.now(), codexPromptHash=prompt_hash(config))
        log("codex_thread_started", threadId=self.thread_id)

    def _keep(self, result: Any) -> None:
        thread = (result or {}).get("thread") or {}
        if not thread.get("id"):
            raise CodexTurnError("app-server returned no thread id", 500)
        self.thread_id, self.thread_path = thread["id"], thread.get("path") or self.thread_path

    # ---- one turn ------------------------------------------------------------------------------------------------
    async def __call__(self, worker: agent_core.Worker, prompt: str) -> None:
        self.worker = worker
        if worker.turn:
            worker.turn.delivered = False
        cfg = await asyncio.to_thread(worker.store.config)
        config = cfg.get("config") or {}
        model = config.get("model") or DEFAULT_MODEL
        effort = codex_effort(model, config.get("effort"))
        turn_id: str | None = None
        try:
            await self.ensure(worker, config, model)
            assert self.server and self.thread_id
            if self.lost_note:
                prompt, self.lost_note = f"{render.RECOVERY_NOTE}\n\n{prompt}", False
            state = await asyncio.to_thread(worker.store.state)
            changed = state.get("codexPromptHash") not in (None, prompt_hash(config))  # None: a pre-hash thread, assume unchanged
            params = {"threadId": self.thread_id, "input": [{"type": "text", "text": prompt}], "model": model, "summary": "none",
                      "cwd": self.repo_dir, "approvalPolicy": "never", "sandboxPolicy": {"type": "dangerFullAccess"},
                      **({"effort": effort} if effort else {})}
            if changed:
                params["additionalContext"] = instructions_note(config.get("systemPrompt") or "")
            started = time.monotonic()
            turn = (await self.server.request("turn/start", params, timeout=120) or {}).get("turn") or {}
            turn_id = turn.get("id")
            server, thread_id = self.server, self.thread_id

            async def interrupt() -> None:
                await server.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, timeout=30)
            worker.interrupt = interrupt  # first: a /stop may arrive while anything below awaits
            if worker.stopped:
                await interrupt()
            await asyncio.to_thread(worker.store.update_state, codexTurnAt=agent_core.now(), codexPromptHash=prompt_hash(config))
            if changed:
                log("codex_instructions_sent", turnId=turn_id)
            usage = await self.events(worker, turn_id)
            log("codex_turn", turnId=turn_id, model=model, effort=effort, ms=int((time.monotonic() - started) * 1000), usage=usage)
            await self.flushed(turn_id)
            if not self.skills_checked:
                self.skills_checked = True
                await asyncio.to_thread(self.check_skills, config)
        except BaseException:
            if worker.turn and not worker.turn.delivered:  # the crash may have come after the rollout write, before its notification
                worker.turn.delivered = await asyncio.to_thread(rollout_has, self.thread_path, turn_id, "user")
            raise

    async def events(self, worker: agent_core.Worker, turn_id: str | None) -> dict[str, Any] | None:
        assert self.server
        usage, failure, final, steering = None, None, False, None
        while True:
            event = await self.server.notifications.get()
            if event is None:
                raise AppServerExited()
            method, params = event
            if params.get("turnId") not in (None, turn_id) and method != "turn/completed":
                continue
            if method == "item/completed":
                item = params.get("item") or {}
                kind = item.get("type")
                if kind == "userMessage" and worker.turn and not worker.turn.delivered:
                    # True only once the rollout holds it (a resumed thread gets it back); else stay False, re-checked on failure.
                    if await asyncio.to_thread(rollout_has, self.thread_path, turn_id, "user"):
                        worker.turn.delivered = True
                elif kind == "agentMessage" and worker.turn and (item.get("text") or "").strip():
                    if item.get("phase") == "final_answer" or not final:
                        worker.turn.last_text, final = item["text"].strip(), item.get("phase") == "final_answer"
                elif kind in TOOL_BOUNDARY and (steering is None or steering.done()):
                    steering = asyncio.ensure_future(worker.steer_with(self.steer_into(turn_id)))
            elif method == "thread/tokenUsage/updated":
                usage = params.get("tokenUsage") or params.get("usage") or usage
            elif method == "error" and not params.get("willRetry"):
                failure = params.get("error") or {}
            elif method == "turn/completed":
                turn = params.get("turn") or {}
                if turn.get("id") not in (None, turn_id):
                    continue
                if steering is not None:
                    with contextlib.suppress(Exception):
                        await steering
                status = turn.get("status")
                if status == "failed":
                    error = turn.get("error") or failure or {}
                    raise CodexTurnError(f"turn failed: {str(error.get('message', ''))[:400]}", error_status(error.get("codexErrorInfo")))
                return usage

    def steer_into(self, turn_id: str | None) -> Callable[[str], Awaitable[bool]]:
        async def deliver(text: str) -> bool:
            if not self.server or not turn_id:
                return False
            try:
                await self.server.request("turn/steer", {"threadId": self.thread_id, "input": [{"type": "text", "text": text}],
                                                         "expectedTurnId": turn_id}, timeout=30)
                log("codex_steered", turnId=turn_id)
                return True
            except (JsonRpcError, AppServerExited, TimeoutError) as error:
                log("codex_steer_failed", turnId=turn_id, error=str(error)[:200])
                return False
        return deliver

    async def flushed(self, turn_id: str | None) -> None:
        """Bounded wait for the turn's task_complete in the rollout, so the os.sync() before turn.ended covers it."""
        deadline = time.monotonic() + self.flush_wait_s
        while time.monotonic() < deadline:
            if await asyncio.to_thread(rollout_has, self.thread_path, turn_id, "complete"):
                return
            await asyncio.sleep(0.1)
        log("codex_rollout_unflushed", turnId=turn_id)

    def check_skills(self, config: dict[str, Any]) -> None:
        wanted = {name for s in config.get("skills") or [] if (name := agent_core.skill_name(s.get("name", "")))}
        listing = skills_listing(self.thread_path) or {"roots": {}, "skills": []}
        log("codex_skills", roots=listing["roots"], names=[name for name, _ in listing["skills"]])
        problems = unexpected_skills(listing, self.codex_home, self.repo_dir, wanted)
        if problems:
            print(json.dumps({"component": "agent", "event": "codex_skills_unexpected", "level": "WARNING", "problems": problems[:20]}), flush=True)


def dynamic_tools() -> list[dict[str, Any]]:
    """The six DSH tools as app-server DynamicToolSpecs (names and shapes fixed for a thread's life: they are restored from the rollout)."""
    return [{"type": "function", "name": name, "description": agent_core.TOOL_SPECS[name][0], "inputSchema": agent_core.TOOL_SPECS[name][1]}
            for name in agent_core.DSHSA_TOOLS]
