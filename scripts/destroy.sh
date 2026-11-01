#!/usr/bin/env bash
# Destroy everything dshsa-* in the account (A7). Touches nothing whose name does not start with dshsa.
# Usage: scripts/destroy.sh [--yes]
source "$(dirname "$0")/lib.sh"
preflight

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Destroy ALL dshsa-* resources in $CDK_DEFAULT_ACCOUNT/$AWS_REGION? Type the account id to confirm: " answer
  [[ "$answer" == "$CDK_DEFAULT_ACCOUNT" ]] || die "aborted"
fi

# 1. Runtime-created per-cell queues (dshsa-admin cell add).
queues="$(aws sqs list-queues --queue-name-prefix dshsa-cell- --query 'QueueUrls[]' --output text 2>/dev/null || true)"
for url in $(aws_words "$queues"); do
  [[ "${url##*/}" == dshsa-cell-* ]] || continue
  log "delete queue $url"; aws sqs delete-queue --queue-url "$url"
done

# 2. Runtime-created per-ticket access points on the dshsa file system (provisioner Lambda).
fs="$(stack_output dshsa-worker DshsaFileSystemId)"
if [[ -n "$fs" && "$fs" != "fs-stub" ]]; then
  aps="$(aws s3files list-access-points --file-system-id "$fs" --query 'accessPoints[].accessPointId' --output text 2>/dev/null || true)"
  for ap in $(aws_words "$aps"); do
    log "delete access point $ap"; aws s3files delete-access-point --access-point-id "$ap"
  done
fi

# 3. Stacks, dependents first.
mapfile -t ctx < <(cdk_context)
(cd "$ROOT/infra" && pnpm exec cdk destroy dshsa-panel dshsa-ingress dshsa-host dshsa-worker dshsa-shared "${ctx[@]+"${ctx[@]}"}" --force)

# 4. Runtime-created secrets (dshsa-admin feishu set).
secrets="$(aws secretsmanager list-secrets --filters Key=name,Values=dshsa/feishu/ --query 'SecretList[].ARN' --output text)"
for arn in $(aws_words "$secrets"); do
  [[ "$arn" == *:secret:dshsa/feishu/* ]] || continue
  log "delete secret $arn"; aws secretsmanager delete-secret --secret-id "$arn" --force-delete-without-recovery >/dev/null
done

# 5. Log groups created outside CloudFormation (Lambda/AgentCore defaults).
for prefix in /aws/lambda/dshsa- /aws/bedrock-agentcore/runtimes/dshsa /dshsa/; do
  groups="$(aws logs describe-log-groups --log-group-name-prefix "$prefix" --query 'logGroups[].logGroupName' --output text)"
  for lg in $(aws_words "$groups"); do
    [[ "$lg" == "$prefix"* ]] || continue
    log "delete log group $lg"; aws logs delete-log-group --log-group-name "$lg"
  done
done

# 6. Report anything left with the project tag.
left="$(aws_words "$(aws resourcegroupstaggingapi get-resources --tag-filters Key=project,Values=dshsa --query 'ResourceTagMappingList[].ResourceARN' --output text)")"
if [[ -n "$left" ]]; then log "still tagged project=dshsa (may be pending deletion, e.g. KMS keys):"; printf '  %s\n' $left; else log "nothing tagged project=dshsa remains ✓"; fi
