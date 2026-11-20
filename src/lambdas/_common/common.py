"""Shared helpers for the Forno Pizza POC tool Lambdas.

Kept dependency-free (boto3 ships with the Lambda runtime). Copied into each
tool's asset dir at deploy time is NOT needed — each handler imports the
pieces it uses inline; this module documents the conventions and offers the
small reusable bits.
"""
import decimal
import json
from typing import Any

import boto3

_dynamodb = None


def table(name: str):
    """Return a cached DynamoDB Table resource."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(name)


class _DecimalEncoder(json.JSONEncoder):
    def default(self, o: Any) -> Any:
        if isinstance(o, decimal.Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def to_jsonable(obj: Any) -> Any:
    """Round-trip through JSON to drop DynamoDB Decimals for the MCP response."""
    return json.loads(json.dumps(obj, cls=_DecimalEncoder))


def tool_input(event: dict) -> dict:
    """Normalize the event into the tool input dict.

    AgentCore Gateway (MCP) passes the tool arguments as the event body. We
    accept either the raw arg dict or a wrapper with an `input`/`arguments`
    key so the same handler works from `aws lambda invoke` test payloads too.
    """
    if not isinstance(event, dict):
        return {}
    for key in ("input", "arguments", "body"):
        if key in event and isinstance(event[key], dict):
            return event[key]
    return event
