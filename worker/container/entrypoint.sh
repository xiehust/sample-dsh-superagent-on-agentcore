#!/bin/bash
# Container entrypoint (root), as agentcore-s3files-per-user-isolation/container/entrypoint.sh (MIT). Process tree:
#   entrypoint.sh (root)
#   ├─ watchdog supervisor (root) -> amazon-efs-mount-watchdog: keeps the TLS tunnel alive with the rotated profile
#   ├─ efs-utils log forwarder     -> stdout
#   ├─ agent.py                    -> drops to uid $AGENT_UID + NoNewPrivs before importing anything
#   └─ gateway.py (root, :8080)    -> verify token, mint creds, mount, rotate, inbox, CP proxy on 127.0.0.1:8090
set -u
export HOME=/root
export PYTHONPATH=/app
AGENT_UID="${AGENT_UID:-1000}"

if [[ "${MOUNT_MODE:-s3files}" != "local" ]]; then
  supervise_watchdog() {
    local backoff=1
    while true; do
      /usr/bin/amazon-efs-mount-watchdog
      echo "{\"component\":\"entrypoint\",\"event\":\"watchdog_exited\",\"code\":$?}"
      sleep "$backoff"; backoff=$(( backoff < 30 ? backoff * 2 : 30 ))
    done
  }
  supervise_watchdog &
  mkdir -p /var/log/amazon/efs
  touch /var/log/amazon/efs/mount.log /var/log/amazon/efs/mount-watchdog.log
  tail -q -n0 -F /var/log/amazon/efs/mount.log /var/log/amazon/efs/mount-watchdog.log | sed -u 's/^/[efs-utils] /' &
fi

mkdir -p "${WORK_DIR:-/mnt/work}"
# The agent restarts if it dies; the gateway's next /run puts it back to work from the inbox and state.json.
( while true; do python3.12 /app/agent.py; echo '{"component":"entrypoint","event":"agent_exited","code":'$?'}'; sleep 1; done ) &

exec python3.12 /app/gateway.py
