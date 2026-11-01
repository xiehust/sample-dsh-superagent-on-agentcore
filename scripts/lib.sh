# Shared helpers for dshsa scripts. Source, don't execute.
set -euo pipefail
export AWS_REGION=ap-northeast-1 AWS_DEFAULT_REGION=ap-northeast-1
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The target account is pinned per installation, not in the repository: export DSHSA_ACCOUNT, or put
# `DSHSA_ACCOUNT=<12-digit id>` in the untracked scripts/local.env (gitignored).
[[ -f "$ROOT_DIR/scripts/local.env" ]] && source "$ROOT_DIR/scripts/local.env"
DSHSA_STACKS=(dshsa-shared dshsa-worker dshsa-host dshsa-ingress dshsa-panel)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[1;34m[dshsa]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[dshsa] %s\033[0m\n' "$*" >&2; exit 1; }

preflight() {
  command -v aws >/dev/null || die "aws CLI not found"
  command -v pnpm >/dev/null || die "pnpm not found"
  local account
  account="$(aws sts get-caller-identity --query Account --output text)" || die "no AWS credentials"
  if [[ "${DSHSA_ALLOW_ANY_ACCOUNT:-}" != "true" ]]; then
    [[ "${DSHSA_ACCOUNT:-}" =~ ^[0-9]{12}$ ]] || die "set DSHSA_ACCOUNT to the target AWS account id (or in scripts/local.env); see README"
  fi
  if [[ "$account" != "${DSHSA_ACCOUNT:-}" && "${DSHSA_ALLOW_ANY_ACCOUNT:-}" != "true" ]]; then
    die "credentials are for $account, dshsa targets $DSHSA_ACCOUNT (set DSHSA_ALLOW_ANY_ACCOUNT=true to override)"
  fi
  export CDK_DEFAULT_ACCOUNT="$account" CDK_DEFAULT_REGION="$AWS_REGION" DSHSA_ACCOUNT="${DSHSA_ACCOUNT:-$account}"
}

# Context flags for cdk from env: DSHSA_VPC_ID, DSHSA_AZS, DSHSA_RETAIN, DSHSA_DEV_CALLBACK.
cdk_context() {
  local args=()
  [[ -n "${DSHSA_VPC_ID:-}" ]] && args+=(-c "vpcId=$DSHSA_VPC_ID")
  [[ -n "${DSHSA_AZS:-}" ]] && args+=(-c "azs=$DSHSA_AZS")
  [[ "${DSHSA_RETAIN:-}" == "true" ]] && args+=(-c retain=true)
  [[ "${DSHSA_DEV_CALLBACK:-}" == "true" ]] && args+=(-c devCallback=true)
  [[ "${DSHSA_ALLOW_ANY_ACCOUNT:-}" == "true" ]] && args+=(-c allowAnyAccount=true)
  # printf with no arguments still prints one empty line, which mapfile would turn into an empty cdk argument.
  if ((${#args[@]})); then printf '%s\n' "${args[@]}"; fi
}

stack_output() { # stack key — prints nothing when the stack or output is missing (never the CLI's literal "None")
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true)"
  [[ "$value" == "None" ]] || printf '%s' "$value"
}

# Words of an `aws ... --output text` result, one per line; the CLI prints "None" for an empty result, which is dropped.
aws_words() {
  local word
  for word in $1; do [[ "$word" == "None" ]] || printf '%s\n' "$word"; done
}
