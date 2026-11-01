#!/usr/bin/env bash
# E2E harness against the deployed dshsa platform. Usage: scripts/e2e/run.sh [--keep] [--only panel] [--strict [--wait 30]]
source "$(dirname "$0")/../lib.sh"
preflight
cd "$ROOT" && exec pnpm --filter @dshsa/control-api e2e "$@"
