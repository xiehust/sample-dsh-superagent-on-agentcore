#!/usr/bin/env bash
# Deploy the dshsa platform (only dshsa-* stacks, named explicitly; never --all).
# Usage: scripts/deploy.sh [stack ...]   e.g. scripts/deploy.sh dshsa-shared dshsa-panel
# Env: DSHSA_VPC_ID (import a VPC instead of creating dshsa-vpc), DSHSA_AZS, DSHSA_RETAIN, DSHSA_DEV_CALLBACK.
source "$(dirname "$0")/lib.sh"
preflight

stacks=("$@")
[[ ${#stacks[@]} -eq 0 ]] && stacks=("${DSHSA_STACKS[@]}")
for s in "${stacks[@]}"; do [[ "$s" == dshsa-* ]] || die "refusing non-dshsa stack $s"; done

log "installing workspace dependencies"
(cd "$ROOT" && pnpm install --frozen-lockfile)
if [[ -f "$ROOT/packages/panel/package.json" ]]; then
  log "building panel SPA"
  (cd "$ROOT" && pnpm --filter @dshsa/panel build)
fi

mapfile -t ctx < <(cdk_context)
log "cdk deploy ${stacks[*]}"
(cd "$ROOT/infra" && pnpm exec cdk deploy "${stacks[@]}" "${ctx[@]+"${ctx[@]}"}" --require-approval never --exclusively \
  --outputs-file "$ROOT/infra/cdk-outputs.json")

# Verify denial, not success: the panel API must refuse an anonymous caller with the authorizer's 401.
api="$(stack_output dshsa-panel PanelApiUrl)"
if [[ -n "$api" ]]; then
  command -v curl >/dev/null || die "curl not found (needed for the anonymous-denial check)"
  anon="$(mktemp)"; trap 'rm -f "$anon"' EXIT
  code="$(curl -s -o "$anon" -w '%{http_code}' "$api/v1/cells" || true)"
  if [[ "$code" != "401" ]] || ! grep -q Unauthorized "$anon"; then
    die "SECURITY: anonymous GET $api/v1/cells returned $code (expected 401 Unauthorized from the JWT authorizer)"
  fi
  log "anonymous panel API call denied (401) ✓"
  log "panel: $(stack_output dshsa-panel PanelUrl)"
fi

# Ingress gate (owner 95): anonymous, forged-signature and wrong-body webhooks must be refused with a gate error code.
if [[ " ${stacks[*]} " == *" dshsa-ingress "* ]]; then
  (cd "$ROOT" && pnpm --filter @dshsa/sources check:ingress) || die "SECURITY: ingress webhook did not refuse anonymous/forged requests"
  log "ingress webhook refuses anonymous and forged deliveries ✓"
fi
