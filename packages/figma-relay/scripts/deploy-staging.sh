#!/usr/bin/env bash
set -euo pipefail

: "${DEPLOY_ARCHIVE:?DEPLOY_ARCHIVE must point to the relay deployment zip}"

aws_region="${AWS_REGION:-us-east-2}"
deploy_bucket="${DEPLOY_BUCKET:-donatemate-staging-figma-responses}"
deploy_revision="${GITHUB_SHA:-manual-$(date +%s)}"
artifact_key="relay-deployments/${deploy_revision}/figma-relay.zip"
instance_id="$(aws ssm get-parameter \
  --name /donatemate/staging/figma-vm/instance-id \
  --region "$aws_region" \
  --query Parameter.Value \
  --output text)"

if [[ ! "$instance_id" =~ ^i-[a-f0-9]+$ ]]; then
  echo "Invalid Figma VM instance id returned by SSM" >&2
  exit 1
fi

aws s3 cp "$DEPLOY_ARCHIVE" "s3://${deploy_bucket}/${artifact_key}" \
  --region "$aws_region" --only-show-errors

remote_zip="C:\\Windows\\Temp\\figma-relay-${deploy_revision}.zip"
remote_root="C:\\Windows\\Temp\\figma-relay-${deploy_revision}"
parameters="$(jq -cn \
  --arg bucket "$deploy_bucket" \
  --arg key "$artifact_key" \
  --arg zip "$remote_zip" \
  --arg root "$remote_root" \
  '{commands: [
    "$ErrorActionPreference = \"Stop\"",
    "if (Test-Path \"\($root)\") { Remove-Item -Recurse -Force \"\($root)\" }",
    "if (Test-Path \"\($zip)\") { Remove-Item -Force \"\($zip)\" }",
    "& \"$env:ProgramFiles\\Amazon\\AWSCLIV2\\aws.exe\" s3 cp \"s3://\($bucket)/\($key)\" \"\($zip)\" --region us-east-2 --only-show-errors",
    "if ($LASTEXITCODE -ne 0) { throw \"Could not download relay deployment archive\" }",
    "Expand-Archive -Path \"\($zip)\" -DestinationPath \"\($root)\" -Force",
    "& \"\($root)\\scripts\\deploy-relay.ps1\" -PackageRoot \"\($root)\"",
    "if ($LASTEXITCODE -ne 0) { throw \"Relay deployment script failed\" }",
    "Remove-Item -Recurse -Force \"\($root)\"",
    "Remove-Item -Force \"\($zip)\""
  ]}')"

command_id="$(aws ssm send-command \
  --instance-ids "$instance_id" \
  --document-name AWS-RunPowerShellScript \
  --region "$aws_region" \
  --comment "Deploy Figma relay ${deploy_revision}" \
  --parameters "$parameters" \
  --query Command.CommandId \
  --output text)"

if ! aws ssm wait command-executed \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --region "$aws_region"; then
  aws ssm get-command-invocation \
    --command-id "$command_id" \
    --instance-id "$instance_id" \
    --region "$aws_region" \
    --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
    --output json >&2 || true
  exit 1
fi

aws ssm get-command-invocation \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --region "$aws_region" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
  --output json

aws s3 rm "s3://${deploy_bucket}/${artifact_key}" \
  --region "$aws_region" --only-show-errors
