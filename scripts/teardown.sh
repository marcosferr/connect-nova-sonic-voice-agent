#!/usr/bin/env bash
# Remove EVERYTHING this project deployed: `cdk destroy` + the data stores.
# With RETAIN_DATA=false (default) tables/workgroup are deleted by CloudFormation,
# but S3 buckets must be empty first — this script empties them.
# With RETAIN_DATA=true it also deletes the retained tables/buckets/workgroup.
# Usage: scripts/teardown.sh [--yes]
set -euo pipefail
PROJECT_NAME="${PROJECT_NAME:-pizza-voice}"; ENV_NAME="${ENV_NAME:-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Destroy ALL '$PROJECT_NAME-$ENV_NAME' resources in $AWS_REGION? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
fi

empty_bucket() {
  python3 - "$1" <<'PY'
import os, sys, boto3
s = boto3.Session(profile_name=os.environ.get("AWS_PROFILE") or None, region_name=os.environ["AWS_REGION"])
b = s.resource("s3").Bucket(sys.argv[1])
b.object_versions.delete(); b.objects.delete()
print("emptied", sys.argv[1])
PY
}

buckets=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, '$PROJECT_NAME-')].Name" --output text)
for b in $buckets; do [[ "$b" == *"-$ENV_NAME"* ]] && empty_bucket "$b"; done

npx cdk destroy "Dev/*" --force

# Leftovers when RETAIN_DATA=true (no-ops otherwise).
for t in menu pedidos clientes tiendas; do
  aws dynamodb delete-table --table-name "$PROJECT_NAME-$t-$ENV_NAME" >/dev/null 2>&1 && echo "deleted table $t" || true
done
for b in $buckets; do
  [[ "$b" == *"-$ENV_NAME"* ]] || continue
  empty_bucket "$b" 2>/dev/null && aws s3api delete-bucket --bucket "$b" 2>/dev/null && echo "deleted bucket $b" || true
done
aws athena delete-work-group --work-group "$PROJECT_NAME-analytics-$ENV_NAME" --recursive-delete-option >/dev/null 2>&1 && echo "deleted workgroup" || true
# Log groups auto-created by CDK custom-resource Lambdas (not managed by CloudFormation).
for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/$PROJECT_NAME-$ENV_NAME-" --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name "$lg" && echo "deleted log group $lg"
done
echo "teardown complete"
