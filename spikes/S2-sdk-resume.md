# Spike S2: Claude Agent SDK transcript resume on a fresh machine

Status: **pass (local proxy)**. Re-running on a real AgentCore microVM with an S3 Files AP is still pending, because no dshsa VPC can be created yet (VPC quota 15/15).
Date 2026-11-01 · claude-agent-sdk 0.2.176 (CLI bundled) · Bedrock `global.anthropic.claude-sonnet-5-5` · harness `S2-sdk-resume/run.sh`.

## Method

Every phase runs in a **brand-new container**: new hostname, empty HOME and /tmp, uid 1000. The only thing the phases share is a volume at `/mnt/work`, which stands in for the ticket AP. The settings are `CLAUDE_CONFIG_DIR=/mnt/work/.claude`, `cwd=/mnt/work/repo` and `setting_sources=[]`. The session id is deterministic: `uuid5(ticket)`, passed as `session_id=` on the first run and as `resume=` afterwards.

## Results (`S2-sdk-resume/results/`)

| # | Phase | Outcome | Resume init | Turn time |
|---|---|---|---|---|
| 1 | first: plant codeword, write notes.txt | ok; session id = the requested uuid5 | 1.75 s | 3.6 s |
| 2 | resume in a new container | `CODEWORD=PELICAN-42 NOTES=hello from vm-1` ✅ | 0.69 s | 2.3 s |
| 3 | long tool call (`sleep 90`); container **SIGKILLed** after 25 s | killed mid-turn | — | — |
| 4 | resume after the kill | codeword and file intact ✅; the model notes that the sleep "was stopped before it finished" | 0.74 s | 2.7 s |
| 5 | resume with a **different cwd** (`/mnt/work/other`) | still resumed (`PELICAN-42`) ✅ | 0.69 s | 1.3 s |

Transcript: one JSONL file per session, `.claude/projects/-mnt-work-repo/<session>.jsonl`, append-only, about 120–165 KB after 5 short turns. The whole `.claude` directory is 220 KB.
Directories are created 0700 and owned by uid 1000, so the AP's posix uid 1000 matches.

## Findings / recommendations

1. **Use a deterministic SDK session id** (`session_id=uuid5(NAMESPACE_URL, "dshsa/" + ticketKey)`). Then `state.json` doesn't need to store `sdkSessionId` (§4.10). The value may still be kept there for debugging.
2. **A crash mid-turn is safe**: the transcript stays consistent and the next resume continues. A *mid-tool* kill leaves the tool unfinished, and the model sees that. So after a resume the agent should get a "recovery" note, as DSH does (`RECOVERY_NOTE`), telling it to re-check the repo before repeating external actions.
3. **Resume does not depend on cwd** in this SDK version. Still keep `cwd=/mnt/work/repo` fixed.
4. **Resume start-up is fast** (≈0.7 s to init). Most of the microVM cold-start cost will be the mount (the reference reports 1–38 s) and the repo checkout.
5. `CLAUDE_CONFIG_DIR` also holds `.claude.json`, backups, shell snapshots and `session-env`. Those are small and safe on the AP. Bedrock credentials are **not** written there; they come from the environment and the instance role.
6. The SDK also offers a pluggable `session_store` (`SessionStore`, `import_session_to_store`). That would be a fallback if S1 shows that small appends on S3 Files are too slow or unsafe. No contract change is needed now.

**§4.10 impact**: no structural change. Optional simplification: derive `sdkSessionId` instead of storing it.
**§4.4 impact**: none.
