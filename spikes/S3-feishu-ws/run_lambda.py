"""Drive the Tokyo probe Lambda asynchronously (a sync invoke idle >10 min loses its connection on the way back):
N sample runs of 14 min staggered back to back, plus one idle-hold run; results are read from CloudWatch Logs by collect()."""
import json
import os
import sys
import time

import boto3

FN = "dshsa-spike-s3-probe"
REGION = "ap-northeast-1"
OUT = os.path.join(os.path.dirname(__file__), "results")


def start(runs: int) -> None:
    lmb = boto3.client("lambda", region_name=REGION)
    lmb.invoke(FunctionName=FN, InvocationType="Event", Payload=json.dumps({"hold": True, "seconds": 840}).encode())
    for i in range(runs):
        lmb.invoke(FunctionName=FN, InvocationType="Event", Payload=json.dumps({"seconds": 840, "interval": 15}).encode())
        print(f"run {i + 1} started {time.strftime('%H:%M:%S')}", flush=True)
        if i + 1 < runs:
            time.sleep(850)


def collect(since_ms: int) -> None:
    logs = boto3.client("logs", region_name=REGION)
    samples, summaries, holds = [], [], []
    for page in logs.get_paginator("filter_log_events").paginate(logGroupName=f"/aws/lambda/{FN}", startTime=since_ms):
        for event in page["events"]:
            msg = event["message"].strip()
            if msg.startswith("SAMPLE "):
                samples.append(msg[7:])
            elif msg.startswith("SUMMARY "):
                summaries.append(json.loads(msg[8:]))
            elif msg.startswith("HOLD "):
                holds.append(json.loads(msg[5:]))
    with open(os.path.join(OUT, "tokyo-samples.jsonl"), "w") as f:
        f.write("\n".join(samples) + "\n")
    with open(os.path.join(OUT, "tokyo-hold.json"), "w") as f:
        json.dump(holds, f, indent=1)
    print(f"{len(samples)} samples, {len(summaries)} summaries, {len(holds)} holds")


if __name__ == "__main__":
    if sys.argv[1] == "start":
        start(int(sys.argv[2]))
    else:
        collect(int(sys.argv[2]))
