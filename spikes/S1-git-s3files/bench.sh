#!/bin/bash
# Spike S1: git on the ticket's S3 Files mount vs local disk, inside the worker microVM, as the agent user (uid 1000).
#   bench.sh <repo-url> <runs>   prints one JSON line per (target, run, step) with seconds.
# The clone uses --filter=blob:none like the worker does (worker design §2.3).
set -u
REPO="${1:-https://github.com/django/django.git}"
RUNS="${2:-3}"
TARGETS=("/mnt/work/spike-s1" "/tmp/spike-s1")

t() {  # t <target> <run> <step> <command...>
  local target=$1 run=$2 step=$3; shift 3
  local start end rc
  start=$(date +%s%N)
  "$@" >/dev/null 2>&1; rc=$?
  end=$(date +%s%N)
  printf '{"target":"%s","run":%s,"step":"%s","ms":%s,"rc":%s}\n' "$target" "$run" "$step" "$(( (end - start) / 1000000 ))" "$rc"
}

for run in $(seq 1 "$RUNS"); do
  for base in "${TARGETS[@]}"; do
    rm -rf "$base" && mkdir -p "$base"
    dir="$base/repo"
    t "$base" "$run" clone timeout 2400 git clone --quiet --filter=blob:none "$REPO" "$dir"
    files=$(git -C "$dir" ls-files | wc -l)
    t "$base" "$run" status_cold git -C "$dir" status --porcelain
    t "$base" "$run" status_warm git -C "$dir" status --porcelain
    t "$base" "$run" touch_100 bash -c "git -C '$dir' ls-files | head -100 | while read -r f; do echo '// dshsa' >> '$dir/'\"\$f\"; done"
    t "$base" "$run" status_dirty git -C "$dir" status --porcelain
    t "$base" "$run" add_commit bash -c "git -C '$dir' -c user.name=s1 -c user.email=s1@example.com commit -qam 'spike s1'"
    t "$base" "$run" checkout_branch git -C "$dir" checkout -q -b spike-s1
    t "$base" "$run" grep git -C "$dir" grep -q -I "function" -- .
    t "$base" "$run" log_200 git -C "$dir" log -200 --oneline
    t "$base" "$run" npm_like_write bash -c "mkdir -p '$dir/node_modules_sim' && for i in \$(seq 1 2000); do echo x > '$dir/node_modules_sim/f'\$i; done"
    t "$base" "$run" rm_tree rm -rf "$dir"
    printf '{"target":"%s","run":%s,"step":"files","value":%s}\n' "$base" "$run" "$files"
  done
done
rm -rf /tmp/spike-s1 /mnt/work/spike-s1
