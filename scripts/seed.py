#!/usr/bin/env python3
"""Load the fixed menu + stores into DynamoDB (docs/seed/*.json).

Table names are resolved from PROJECT_NAME / ENV_NAME, so the seed files work
for any deployment. Idempotent (PutItem overwrites).
Usage: python scripts/seed.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stack_env import StackEnv  # noqa: E402
import os  # noqa: E402

SEED = Path(__file__).resolve().parent.parent / "docs" / "seed"


def main():
    env = StackEnv(os.environ.get("PROJECT_NAME", "pizza-voice"), os.environ.get("ENV_NAME", "dev"),
                   os.environ.get("AWS_REGION", "us-east-1"), os.environ.get("AWS_PROFILE") or None)
    ddb = env.session().client("dynamodb")
    for name in ("menu", "stores"):
        doc = json.loads((SEED / f"{name}.json").read_text(encoding="utf-8"))
        requests = next(iter(doc.values()))  # file key is just a template name
        ddb.batch_write_item(RequestItems={env.table(name): requests})
        print(f"seeded {len(requests)} item(s) into {env.table(name)}")


if __name__ == "__main__":
    main()
