"""Spike S2: does a Claude Agent SDK session resume from a transcript on a shared volume, in a fresh machine?

Each phase runs in a brand-new container that shares only /mnt/work (the stand-in for the ticket's S3 Files AP):
  first   - deterministic session id, plant a codeword, write a file
  resume  - resume by id: does the model recall the codeword and the file?
  long    - start a long tool call; the harness SIGKILLs the container mid-turn
  cwd     - resume with a different cwd, to see whether the transcript lookup depends on it
Prints one JSON line with the outcome.
"""
import asyncio
import json
import os
import sys
import time
import uuid

from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, ResultMessage, SystemMessage, TextBlock, project_key_for_directory, query

WORK = "/mnt/work"
SESSION = str(uuid.uuid5(uuid.NAMESPACE_URL, "dshsa/spike-s2/" + os.environ.get("TICKET", "t1")))
MODEL = os.environ.get("MODEL", "global.anthropic.claude-sonnet-5-5")
PROMPTS = {
    "first": "Remember this codeword for later: PELICAN-42. Then use the Write tool to create notes.txt containing the line 'hello from vm-1'. Reply with DONE only.",
    "resume": "What codeword did I give you earlier? Also read notes.txt and quote it. Answer in one line: CODEWORD=<word> NOTES=<content>.",
    "long": "Use the Bash tool to run exactly: sleep 90 && echo slept. Then reply SLEPT.",
    "cwd": "What codeword did I give you earlier? One word.",
}


async def main(phase: str) -> None:
    cwd = f"{WORK}/other" if phase == "cwd" else f"{WORK}/repo"
    os.makedirs(cwd, exist_ok=True)
    options = ClaudeAgentOptions(
        cwd=cwd, model=MODEL, permission_mode="bypassPermissions", allowed_tools=["Read", "Write", "Bash"], max_turns=6,
        setting_sources=[], env={"CLAUDE_CONFIG_DIR": f"{WORK}/.claude", "CLAUDE_CODE_USE_BEDROCK": "1"},
        **({"session_id": SESSION} if phase == "first" else {"resume": SESSION}),
        **({"resume_drops_turn": os.environ.get("DROP") == "1"} if phase != "first" and os.environ.get("DROP") else {}),
    )
    started, texts, result, init = time.time(), [], None, None
    try:
        async for message in query(prompt=PROMPTS[phase], options=options):
            if isinstance(message, SystemMessage) and message.subtype == "init":
                init = time.time() - started
            elif isinstance(message, AssistantMessage):
                texts += [block.text for block in message.content if isinstance(block, TextBlock)]
            elif isinstance(message, ResultMessage):
                result = message
        error = None
    except Exception as exc:  # noqa: BLE001 - the failure is the result
        error = f"{type(exc).__name__}: {exc}"[:500]
    projects = os.path.join(WORK, ".claude", "projects")
    transcripts = {}
    for root, _dirs, files in os.walk(projects):
        for name in files:
            path = os.path.join(root, name)
            transcripts[os.path.relpath(path, projects)] = os.path.getsize(path)
    print(json.dumps({
        "phase": phase, "host": os.uname().nodename, "uid": os.getuid(), "session": SESSION, "cwd": cwd,
        "projectKey": project_key_for_directory(cwd), "error": error, "initS": round(init, 2) if init else None,
        "seconds": round(time.time() - started, 1), "resultSession": getattr(result, "session_id", None),
        "isError": getattr(result, "is_error", None), "turns": getattr(result, "num_turns", None),
        "cost": getattr(result, "total_cost_usd", None), "text": " | ".join(texts)[-400:], "transcripts": transcripts,
    }))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
