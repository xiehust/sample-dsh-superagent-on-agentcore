#!/bin/bash
# Spike S2 harness: every phase is a fresh container (new hostname, empty /tmp, empty HOME); only ./vol persists.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=dshsa-spike-s2
docker build -q -t "$IMAGE" . >/dev/null
rm -rf vol && mkdir -p vol results && sudo chown 1000:1000 vol 2>/dev/null || chmod 777 vol
eval "$(aws configure export-credentials --format env)"
creds=(-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION=us-west-2)
phase() {  # phase <name> [extra docker args...]
  local name=$1; shift
  docker run --rm --name "s2-$name" -h "vm-$name-$RANDOM" "${creds[@]}" "$@" -v "$PWD/vol:/mnt/work" "$IMAGE" "$name"
}
phase first | tee results/1-first.json
phase resume | tee results/2-resume.json
# Kill a container mid tool call, as an expired or crashed microVM would.
( phase long > results/3-long.json 2>&1 || true ) &
sleep 25; docker kill s2-long >/dev/null; wait || true
echo '{"phase":"long","killed_after_s":25}' >> results/3-long.json
phase resume | tee results/4-resume-after-kill.json
phase cwd | tee results/5-cwd-mismatch.json
ls -laR vol/.claude | head -40 > results/layout.txt
