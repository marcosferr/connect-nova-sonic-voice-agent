#!/usr/bin/env bash
# Pull the Q in Connect conversation transcript for an Amazon Connect contactId.
#
# Resolves the contact's Q in Connect session (DescribeContact -> WisdomInfo.SessionArn),
# paginates `qconnect list-messages`, and prints a chronological BOT / CUSTOMER
# transcript suitable for diffing against an expected test-call script.
#
# Usage:
#   scripts/pull-session-transcript.sh <contactId>
#   scripts/pull-session-transcript.sh <contactId> > transcripts/<contactId>.txt
#
# Environment: AWS_PROFILE (optional), AWS_REGION (default us-east-1),
#              PROJECT_NAME (default pizza-voice), ENV_NAME (default dev).
# Requires aws CLI v2 + jq. Read-only.
#
# Exit codes:
#   0  transcript printed
#   1  bad usage / stack outputs not found
#   2  contact has no associated Q in Connect session (e.g. hang-up before the bot)

set -euo pipefail

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,20p' "$0"
  exit 1
fi

CONTACT_ID="$1"
AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-pizza-voice}"
ENV_NAME="${ENV_NAME:-dev}"
STACK="$PROJECT_NAME-$ENV_NAME-conversational-ai"

aws_call() {
  MSYS_NO_PATHCONV=1 aws --region "$AWS_REGION" ${AWS_PROFILE:+--profile "$AWS_PROFILE"} "$@"
}

stack_output() {
  aws_call cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, '$1')].OutputValue | [0]" --output text
}

INSTANCE_ID="$(stack_output ConnectInstanceId)"
ASSISTANT_ID="$(stack_output AssistantId)"
for v in INSTANCE_ID ASSISTANT_ID; do
  if [[ -z "${!v}" || "${!v}" == "None" ]]; then
    echo "Could not resolve $v from stack $STACK outputs" >&2
    exit 1
  fi
done

contact_json=$(aws_call connect describe-contact \
  --instance-id "$INSTANCE_ID" --contact-id "$CONTACT_ID")

session_arn=$(echo "$contact_json" | jq -r '.Contact.WisdomInfo.SessionArn // empty')
if [[ -z "$session_arn" ]]; then
  echo "No Q in Connect session associated with contact $CONTACT_ID" >&2
  echo "$contact_json" | jq '.Contact | {Id, Channel, InitiationMethod, InitiationTimestamp, DisconnectReason}' >&2
  exit 2
fi
session_id="${session_arn##*/}"

echo "=== Contact ==="
echo "$contact_json" | jq -r '.Contact | "id:        \(.Id)\nchannel:   \(.Channel)\nmethod:    \(.InitiationMethod)\nstart:     \(.InitiationTimestamp)\nend:       \(.DisconnectTimestamp)\nendReason: \(.DisconnectReason)\nsessionId: \(.WisdomInfo.SessionArn | split("/") | last)"'
echo

all_messages='[]'
next_token=""
while :; do
  if [[ -n "$next_token" ]]; then
    page=$(aws_call qconnect list-messages \
      --assistant-id "$ASSISTANT_ID" --session-id "$session_id" \
      --next-token "$next_token")
  else
    page=$(aws_call qconnect list-messages \
      --assistant-id "$ASSISTANT_ID" --session-id "$session_id")
  fi
  all_messages=$(jq -n --argjson a "$all_messages" --argjson b "$(echo "$page" | jq '.messages')" '$a + $b')
  next_token=$(echo "$page" | jq -r '.nextToken // empty')
  [[ -z "$next_token" ]] && break
done

echo "=== Transcript (chronological) ==="
echo "$all_messages" | jq -r 'sort_by(.timestamp) | .[] | "\(.timestamp)  \(.participant): \(.value.text.value)"'
