# Spike S1: git on S3 Files vs local disk (real AgentCore microVM)

Status: **done and accepted for phase 1. Decision: working copy on local disk, checkpointed as a bundle to S3 Files** (contract v5 §4.10).
Date 2026-11-01 · ap-northeast-1 · runtime `dshsa_worker`, ticket AP mounted at `/mnt/work` (nfs4.2 through efs-proxy, `nodirects3read`) · harness `S1-git-s3files/{run_s1.py, bench.sh}` run as uid 1000, 3 runs, medians · raw data `S1-git-s3files/results.json`.
Repository: `django/django` (7,085 files), cloned `--filter=blob:none` exactly as the worker does.

## git: S3 Files mount vs local microVM disk (median ms)

| Step | S3 Files | Local | Slower by |
|---|---|---|---|
| clone (blob:none) | 137,765 | 8,287 | 17× |
| status, cold | 12,670 | 235 | 54× |
| status, warm | 3,179 | 166 | 19× |
| touch 100 files | 641 | 7 | 92× |
| status, dirty | 2,235 | 164 | 14× |
| commit -a | 4,516 | 71 | 64× |
| checkout -b | 789 | 31 | 25× |
| grep "function" | 11,063 | 44 | 251× |
| log -200 | 267 | 5 | 53× |
| write 2,000 small files (npm-like) | 22,647 | 59 | 384× |
| rm -rf the tree | 73,791 | 201 | 367× |

Every metadata-heavy operation pays one or more NFS round trips per file (efs-proxy over TLS to the S3 Files mount target). An agent runs `git status`, `grep` and test suites constantly, so a 20–250× penalty on each makes the agent unusable on the mount.

## Export from the file system to S3

The FS is created with no prefix: AP `/tenants/<t>/<cell>/<ticketKey>` == bucket key `tenants/<t>/<cell>/<ticketKey>/`. This was confirmed on real data (`.dshsa/config.json` and `repo/.git/*` appeared under that prefix).
A file written through the mount showed up as an S3 object after **61.8 s** (5 s polling). The synchronization configuration is the default: import `ON_DIRECTORY_FIRST_ACCESS` for objects under 128 KiB, and expiration 30 days after last access. Consequence for the panel (it reads transcripts from S3): it is near-real-time (~1 min).

## Decision (coordinator, contract v5 §4.10) and implementation

- `/home/agent/work/repo`: the working copy on the microVM's **local disk**.
- `/mnt/work` (S3 Files) keeps only `.claude/` (SDK transcripts, append-only), `.dshsa/` (inbox, state, config; fsync'd), `out/` and `repo.bundle`.
- `worker/container/repo.py`:
  - **checkpoint** at every turn end (before `turn.ended`) and on gateway SIGTERM. It snapshots the index to `refs/dshsa/wip-index` and the whole work tree (including untracked, not-ignored files, built with a temporary index) to `refs/dshsa/wip`, without touching the branch, index or work tree. Then `git bundle create --all --not --remotes=origin` → fsync → atomic rename to `repo.bundle` → `sync()`.
  - The bundle is **incremental against origin** (a deviation from "bundle --all", for a reason): the first clone is blob:none, so a full bundle would lazily download every historical blob.
  - **prepare** on a fresh VM: partial clone from GitHub, then fetch the bundle's refs, check out the recorded branch, and restore the work tree (`read-tree -m -u HEAD wip`) and the index (`read-tree wip-index`).
- (Bundle selection and timings were revised after the first microVM run; see S1b below.)
- Tests: `tests/unit/test_repo.py`, against a local bare "GitHub" with partial clone enabled. Local unpushed commit, branch, unstaged modification, staged change, deletion and new untracked file all round-trip exactly, and the checkpoint is shown not to change `git status` or HEAD. Local smoke test (`tests/smoke/local_smoke.py`): the turn-end bundle is written, and an edit made after the last turn survives `docker stop` (SIGTERM → gateway `checkpoint_on_shutdown`, 7 ms) into a fresh container.

## Checkpoint / resume cost (S1b)

`S1-git-s3files/ckpt_bench.py` runs the real `repo.py`. Django: partial clone; a heavy turn (50 modified + 1 local commit, 5 staged, 20 new files); a realistic turn (3 files); a no-op turn; then resume into a fresh local dir.

**First real-microVM run (v5 as first written): bundle 51 MB, 39–40 s; resume 21 s (restore 11.7 s).** Root cause: `git bundle create --all` includes **tags**. Django's clone carries 469 tags, and the ones whose history no origin branch reaches (`archive/attic`, `soc2009`, …) dragged their whole history into the "incremental" bundle, partly through lazy blob fetches. The restore was slow because it fetched that 51 MB bundle. Reproduced locally: `--all` gave 51,184,580 B in 24 s; `--branches --glob=refs/dshsa/* --not --remotes=origin --tags` gave 7,694 B in 39 ms.

Fixes (evaluated as the coordinator proposed):
1. Bundle only `refs/heads/*` and `refs/dshsa/*`, excluding everything reachable from `origin/*` **and tags**. A regression test covers an off-branch tag.
2. **Skip** when nothing changed: the fingerprint is HEAD, branch, index tree, work tree and local heads. A no-op turn costs one snapshot (~0.1 s).
3. Build the bundle on **local** disk, then make one sequential copy to the AP, fsync, rename, `sync()`.
4. The size cap is 50 MB. Above it, the wip falls back to tracked files only, with a warning in the checkpoint result (large untracked build output). Unit tested.
5. The temporary index is seeded from a copy of the real index, so `git add -A` rehashes only changed files: snapshot 0.4 s → 0.1 s on Django.
6. There is no `git fetch origin` right after the fresh clone on resume.

After the fixes. **Real AgentCore microVM, ap-northeast-1, 3 runs** (coordinator's run, `run_s1.py --skip-bench`); local docker for reference:

| | Before (microVM) | **After (microVM)** | After (local docker) |
|---|---|---|---|
| Heavy turn checkpoint | 40 s · 51 MB | **0.5 s** | 0.7 s · 8.0 KB |
| Realistic 3-file turn checkpoint | — | **174 ms · 8.3 KB** | 0.32 s · 8.4 KB |
| No-op turn | — | **0.1 s (skipped)** | 0.10 s |
| Resume in a fresh VM | 21 s (clone 9.3 + restore 11.7) | **≈10 s (clone 9.3 + restore 0.7)** | 7.4 s |
| `git status` identical after resume | yes | **yes ×3** | yes |

Targets are met: ≤ 3 s per turn and ≤ 10 s on SIGTERM. The resume time is now dominated by the partial clone from GitHub (see the hardening list in the worker's implement.md: a resume clone cache).

## Remaining risks

- If a microVM is killed without SIGTERM (crash or hard stop), the work since the last turn-end checkpoint is lost. The last turn's work is always checkpointed, and pushed PR branches are the real durability path.
- If origin is force-pushed so that the bundle's prerequisite commits disappear, restore fails (`git bundle verify`). The agent then reports `failed` and a person retries; the WIP refs are still recoverable from the bundle by hand.
