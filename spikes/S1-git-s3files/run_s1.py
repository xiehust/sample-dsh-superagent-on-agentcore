"""Spike S1 driver on the deployed dshsa-worker (ap-northeast-1), admin role only:
  1. provision a spike ticket, start its session (gateway mounts the ticket AP at /mnt/work)
  2. run bench.sh inside the microVM as uid 1000 via InvokeAgentRuntimeCommand (S3 Files mount vs local /tmp)
  3. prefix check: a file written at /mnt/work/out/... must appear at bucket key tenants/<t>/cells/<c>/tickets/<key>/out/...
  4. delete the spike ticket's access point
Usage (from worker/): uv run python ../spikes/S1-git-s3files/run_s1.py [--runs 3]
"""
import argparse
import base64
import json
import os
import statistics
import sys
import time
import uuid

import boto3

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [os.path.join(HERE, "..", "..", "worker", "tests"), os.path.join(HERE, "..", "..", "worker", "src"),
                os.path.join(HERE, "..", "..", "packages", "contracts", "python")]
import dshsa_contracts as contracts  # noqa: E402
import isolation_test as iso  # noqa: E402


def main(runs: int, region: str, skip_bench: bool = False) -> int:
    env = iso.Env(region)
    ticket = f"spike-s1-{uuid.uuid4().hex[:8]}"
    rec = env.provision(ticket)
    if rec.get("ok") is not True:
        print("provisioning failed, aborting:", rec, flush=True)
        return 2
    print("provisioned", rec.get("accessPointId"), rec.get("rootPath"), flush=True)
    results: dict = {"ticket": ticket, "rootPath": rec.get("rootPath")}
    try:
        token = env.token(ticket)
        t0 = time.time()
        res = env.invoke(ticket, "start", token)
        results["start"] = {"response": res, "seconds": round(time.time() - t0, 1)}
        print("start", res, f"{time.time() - t0:.1f}s", flush=True)
        code, out = env.run_as_root(ticket, "mount | grep /mnt/work; df -h /mnt/work | tail -1")
        results["mount"] = out.strip()
        print(out.strip(), flush=True)

        script = base64.b64encode(open(os.path.join(HERE, "bench.sh"), "rb").read()).decode()
        env.run_as_root(ticket, f"echo {script} | base64 -d > /tmp/bench.sh && chmod 755 /tmp/bench.sh")
        # Detached inside the microVM (a long clone on S3 Files outlasts any single command stream), polled with short commands.
        if skip_bench:
            lines: list[dict] = []
            prev = json.load(open(os.path.join(HERE, "results.json"))) if os.path.exists(os.path.join(HERE, "results.json")) else {}
            results["median_ms"], results["raw"] = prev.get("median_ms", {}), prev.get("raw", [])
        launch = ("rm -f /tmp/s1.jsonl /tmp/s1.done; chmod 644 /tmp/bench.sh; "
                  f"setsid nohup bash -c '/usr/sbin/runuser -u agent -- bash /tmp/bench.sh https://github.com/django/django.git {runs} "
                  "> /tmp/s1.jsonl 2>&1; echo $? > /tmp/s1.done' >/dev/null 2>&1 < /dev/null & echo launched")
        if not skip_bench:
            code, out = env.run_as_root(ticket, launch, timeout=60)
            print("bench:", out.strip(), flush=True)
            lines: list[dict] = []
            deadline, seen = time.time() + 3 * 3600, 0
            while time.time() < deadline:
                time.sleep(30)
                code, out = env.run_as_root(ticket, "cat /tmp/s1.jsonl; echo; echo DONE=$(cat /tmp/s1.done 2>/dev/null)", timeout=60)
                rows = [line for line in out.splitlines() if line.startswith("{")]
                for line in rows[seen:]:
                    print("  ", line, flush=True)
                seen = len(rows)
                done = next((line[5:] for line in out.splitlines() if line.startswith("DONE=")), "")
                if done:
                    lines = [json.loads(line) for line in rows]
                    other = [line for line in out.splitlines() if line and not line.startswith(("{", "DONE="))]
                    if done.strip() != "0" or other:
                        results.setdefault("errors", []).append({"rc": done.strip(), "out": "\n".join(other)[-4000:]})
                        print("  bench rc", done.strip(), "\n".join(other)[-1500:], flush=True)
                    break
            else:
                results.setdefault("errors", []).append({"error": "bench did not finish in 3 h"})
            results["raw"] = lines

        # S1b (contract v5): checkpoint/resume of the real repo.py for Django, detached the same way.
        ck = base64.b64encode(open(os.path.join(HERE, "ckpt_bench.py"), "rb").read()).decode()
        env.run_as_root(ticket, f"echo {ck} | base64 -d > /tmp/ckpt_bench.py && chmod 644 /tmp/ckpt_bench.py && rm -f /tmp/s1b.jsonl /tmp/s1b.done")
        env.run_as_root(ticket, "setsid nohup bash -c '/usr/sbin/runuser -u agent -- python3.12 /tmp/ckpt_bench.py "
                                f"https://github.com/django/django.git main {runs} > /tmp/s1b.jsonl 2>&1; echo $? > /tmp/s1b.done' "
                                ">/dev/null 2>&1 < /dev/null &", timeout=60)
        ckpt_rows: list[dict] = []
        deadline = time.time() + 2 * 3600
        while time.time() < deadline:
            time.sleep(30)
            _, out = env.run_as_root(ticket, "cat /tmp/s1b.jsonl; echo; echo DONE=$(cat /tmp/s1b.done 2>/dev/null)", timeout=60)
            done = next((line[5:] for line in out.splitlines() if line.startswith("DONE=")), "")
            if done:
                ckpt_rows = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
                for row in ckpt_rows:
                    print("  ckpt", row, flush=True)
                if done.strip() != "0":
                    results.setdefault("errors", []).append({"ckpt_rc": done.strip(), "out": out[-4000:]})
                    print("  ckpt bench rc", done.strip(), out[-1500:], flush=True)
                break
        results["checkpoint"] = ckpt_rows
        table: dict = {}
        for row in results["raw"]:
            if "ms" in row:
                table.setdefault(row["step"], {}).setdefault(row["target"], []).append(row["ms"])
        results["median_ms"] = {step: {t: statistics.median(v) for t, v in targets.items()} for step, targets in table.items()}
        for step, targets in results["median_ms"].items():
            ap, local = targets.get("/mnt/work/spike-s1"), targets.get("/tmp/spike-s1")
            print(f"{step:16} s3files {ap:>8} ms   local {local:>8} ms   x{(ap / local) if local else 0:.1f}", flush=True)

        # Prefix mapping (design §4.10 / panel transcript): AP root path == bucket key prefix.
        marker = f"prefix-check-{uuid.uuid4().hex[:6]}.txt"
        code, out = env.run_as_root(ticket, f"/usr/sbin/runuser -u agent -- sh -c 'mkdir -p /mnt/work/out && echo dshsa > /mnt/work/out/{marker}' "
                                            f"&& ls -l /mnt/work/out/{marker}")
        print("  marker write:", code, out.strip()[-300:], flush=True)
        if code != 0 or marker not in out:
            results["prefix"] = {"error": "marker write failed", "rc": code, "out": out[-1000:]}
            return 3
        written = time.time()
        s3 = boto3.client("s3", region_name=region)
        key = f"{rec['rootPath'].lstrip('/')}/out/{marker}"
        bucket = f"dshsa-data-{env.account}"
        found = False
        while time.time() - written <= 900 and not found:
            listing = s3.list_objects_v2(Bucket=bucket, Prefix=key)
            found = any(o["Key"] == key for o in listing.get("Contents", []))
            if not found:
                time.sleep(5)
        # Export latency: how long after the write the object appeared in the bucket (5 s polling resolution).
        results["prefix"] = {"bucket": bucket, "key": key, "found": found, "export_s": round(time.time() - written, 1)}
        print("prefix check", results["prefix"], flush=True)
    finally:
        try:
            env.stop(ticket)
        except Exception:  # noqa: BLE001
            pass
        env.provision(ticket, "delete")
        with open(os.path.join(HERE, "results.json"), "w") as f:
            json.dump(results, f, indent=1)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--region", default=contracts.REGION)
    parser.add_argument("--skip-bench", action="store_true", help="only the v5 checkpoint/resume measurement (keeps the bench results)")
    args = parser.parse_args()
    sys.exit(main(args.runs, args.region, args.skip_bench))
