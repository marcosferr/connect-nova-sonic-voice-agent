#!/usr/bin/env bash
# List recent Amazon Connect voice contacts joined with their pedidos DynamoDB rows.
#
# For each contact this shows:
#   pedidoCount  number of <project>-pedidos-<env> rows whose contactId matches
#                  0  = no order saved (hang-up, caller declined, or crear_pedido never called / failed)
#                  1  = normal
#                  2+ = idempotency regression (crear_pedido is supposed to be idempotent per contactId)
#   total        sum of `total` across those rows
#   posStatus    comma-joined posStatus values (ok / skipped / pending / error:<http>)
#   pedidoIds    comma-joined pedidoId values (use with `aws dynamodb get-item` for detail)
#
# Usage:
#   scripts/list-recent-contacts.sh                        # last 24h, 20 max, inbound voice only
#   scripts/list-recent-contacts.sh --since 2026-01-15 --count 50
#   scripts/list-recent-contacts.sh --all                  # include API / WEBRTC_API / outbound contacts
#
# Environment: AWS_PROFILE (optional), AWS_REGION (default us-east-1),
#              PROJECT_NAME (default pizza-voice), ENV_NAME (default dev).
# IDs are read from the CloudFormation outputs of "$PROJECT_NAME-$ENV_NAME-conversational-ai".
# Output is tab-separated: pipe to `column -t -s $'\t'` for a table. Requires aws CLI v2 + jq. Read-only.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-pizza-voice}"
ENV_NAME="${ENV_NAME:-dev}"
STACK="$PROJECT_NAME-$ENV_NAME-conversational-ai"
DDB_TABLE="$PROJECT_NAME-pedidos-$ENV_NAME"

SINCE=""
COUNT=20
FILTER="inbound-voice"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --count) COUNT="$2"; shift 2 ;;
    --all)   FILTER="all"; shift ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

aws_call() {
  # MSYS_NO_PATHCONV stops git-bash on Windows from rewriting /aws/... style arguments.
  MSYS_NO_PATHCONV=1 aws --region "$AWS_REGION" ${AWS_PROFILE:+--profile "$AWS_PROFILE"} "$@"
}

stack_output() {
  aws_call cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?starts_with(OutputKey, '$1')].OutputValue | [0]" --output text
}

INSTANCE_ID="$(stack_output ConnectInstanceId)"
if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
  echo "Could not resolve ConnectInstanceId from stack $STACK" >&2
  exit 1
fi

if [[ -z "$SINCE" ]]; then
  if date --version >/dev/null 2>&1; then
    SINCE=$(date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%SZ")
  else
    SINCE=$(date -u -v-1d +"%Y-%m-%dT%H:%M:%SZ")
  fi
else
  SINCE="${SINCE}T00:00:00Z"
fi
UNTIL=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# --- 1. Connect contacts in the window ---
contacts_raw=$(aws_call connect search-contacts \
  --instance-id "$INSTANCE_ID" \
  --time-range "{\"Type\":\"INITIATION_TIMESTAMP\",\"StartTime\":\"$SINCE\",\"EndTime\":\"$UNTIL\"}" \
  --max-results "$COUNT" \
  --sort '{"FieldName":"INITIATION_TIMESTAMP","Order":"DESCENDING"}')

jq_filter='.Contacts'
if [[ "$FILTER" == "inbound-voice" ]]; then
  jq_filter='.Contacts | map(select(.InitiationMethod == "INBOUND" and .Channel == "VOICE"))'
fi
contacts=$(echo "$contacts_raw" | jq "$jq_filter")

# --- 2. pedidos rows in the same window (one scan, joined in memory) ---
# `creadoEn` is ISO-8601 UTC, so string comparison is order-preserving.
orders_raw=$(aws_call dynamodb scan \
  --table-name "$DDB_TABLE" \
  --filter-expression "creadoEn >= :since" \
  --expression-attribute-values "{\":since\":{\"S\":\"$SINCE\"}}" \
  --projection-expression "pedidoId, contactId, creadoEn, #t, posStatus" \
  --expression-attribute-names '{"#t":"total"}')

orders_by_contact=$(echo "$orders_raw" | jq '
  [ .Items[]
    | select(.contactId != null)
    | { contactId: .contactId.S,
        pedidoId:  .pedidoId.S,
        total:     ((.total.N // "0") | tonumber),
        pos:       (.posStatus.S // "-") } ]
  | group_by(.contactId)
  | map({ key: .[0].contactId, value: . })
  | from_entries
')

# --- 3. Join + emit ---
printf 'contactId\tinitiation\tmethod\tpedidoCount\ttotal\tposStatus\tpedidoIds\n'
echo "$contacts" | jq -r --argjson m "$orders_by_contact" '
  .[] | . as $c
  | ($m[$c.Id] // []) as $o
  | [
      $c.Id,
      $c.InitiationTimestamp,
      $c.InitiationMethod,
      ($o | length),
      (if ($o | length) == 0 then "-" else ($o | map(.total) | add | tostring) end),
      (if ($o | length) == 0 then "-" else ($o | map(.pos) | join(",")) end),
      ($o | map(.pedidoId) | join(","))
    ] | @tsv
'
