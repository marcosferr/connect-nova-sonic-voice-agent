"""validate_customer — resolve the caller's phone number against the Customers table.

Input  (MCP tool arguments): { "phone": "+56912345678", "name": "optional" }
Output: { "status": "found|created", "customerId": "...", "phone": "+569...",
          "name": "...", "isNew": bool }
Error:  { "status": "error", "code": "...", "message": "...", "suggestedAction": "..." }

Validation (never trust what the speech model transcribed):
- The phone is normalized to E.164 (accepts "9 1234 5678", "56912345678",
  "+56 9 1234 5678"). If it is not a valid number, no customer is created.
- On the happy path the prompt passes the carrier caller ID
  (`{{$.Custom.customer_phone}}`), so the model never dictates the number.
"""
import os
import re
import uuid

import boto3
from boto3.dynamodb.conditions import Key

_ddb = boto3.resource("dynamodb")
CUSTOMERS_TABLE = os.environ["CUSTOMERS_TABLE"]
PHONE_INDEX = os.environ["CUSTOMERS_PHONE_INDEX"]

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


def _args(event):
    if isinstance(event, dict):
        for k in ("input", "arguments", "body"):
            if isinstance(event.get(k), dict):
                return event[k]
    return event if isinstance(event, dict) else {}


def _error(code, message, action):
    return {"status": "error", "code": code, "message": message, "suggestedAction": action}


def normalize_phone(raw):
    """Return the E.164 form of `raw`, or None if it is not a plausible number."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        candidate = "+" + digits
    elif len(digits) == 9 and digits.startswith("9"):  # Chilean mobile without country code
        candidate = "+56" + digits
    elif len(digits) == 11 and digits.startswith("56"):
        candidate = "+" + digits
    else:
        candidate = "+" + digits
    return candidate if _E164.match(candidate) else None


def lambda_handler(event, context):
    args = _args(event)
    phone = normalize_phone(args.get("phone"))
    if not phone:
        return _error(
            "INVALID_PHONE",
            f"'{args.get('phone')}' is not a valid phone number.",
            "Ask the caller for the full number, read it back digit by digit to confirm, "
            "then call validate_customer again.",
        )

    table = _ddb.Table(CUSTOMERS_TABLE)
    found = table.query(
        IndexName=PHONE_INDEX,
        KeyConditionExpression=Key("phone").eq(phone),
        Limit=1,
    ).get("Items", [])

    if found:
        c = found[0]
        return {
            "status": "found",
            "customerId": c["customerId"],
            "phone": c.get("phone"),
            "name": c.get("name"),
            "isNew": False,
        }

    customer_id = str(uuid.uuid4())
    item = {"customerId": customer_id, "phone": phone}
    name = (args.get("name") or "").strip()
    if name:
        item["name"] = name[:80]
    table.put_item(Item=item)
    return {
        "status": "created",
        "customerId": customer_id,
        "phone": phone,
        "name": item.get("name"),
        "isNew": True,
    }
