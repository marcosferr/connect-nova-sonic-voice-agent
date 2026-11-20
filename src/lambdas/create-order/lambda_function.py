"""create_order — validate the order against the catalog, store it exactly once, send it to the POS.

Input (MCP tool arguments):
  {
    "customerId": "...", "phone": "...", "storeId": "optional",
    "contactId": "Amazon Connect contactId ({{$.contactId}}) — idempotency key",
    "items": [ {"pizzaId": "...", "quantity": 2} ]
  }
Output: { "status": "created|duplicate", "orderId": "...", "total": 12345,
          "lines": [...], "posStatus": "ok|skipped|error:..." }
Error:  { "status": "error", "code": "...", "message": "...", "suggestedAction": "...",
          "catalog"?: [ {pizzaId, name, price} ] }

Validation layers (the voice model proposes, the server decides):
1. Shape: 1..MAX_LINES lines, integer `quantity` 1..MAX_QUANTITY (accepts "2").
2. Catalog: every `pizzaId` must exist and be active. Otherwise the valid
   catalog is returned so the agent offers a real alternative.
3. Price: the total is computed server-side from the Menu table; the model
   never sends prices.
4. Idempotency: with `contactId`, `orderId` is deterministic
   (uuid5(contactId + lines)) and the write is conditional. If the model
   repeats the call, the original order comes back with status "duplicate".
"""
import datetime
import decimal
import json
import os
import urllib.request
import uuid

import boto3
from botocore.exceptions import ClientError

_ddb = boto3.resource("dynamodb")
_secrets = boto3.client("secretsmanager")

ORDERS_TABLE = os.environ["ORDERS_TABLE"]
MENU_TABLE = os.environ["MENU_TABLE"]
STORES_TABLE = os.environ["STORES_TABLE"]
POS_API_BASE_URL = os.environ.get("POS_API_BASE_URL", "")
POS_SECRET_ARN = os.environ.get("POS_SECRET_ARN", "")

MAX_LINES = 10
MAX_QUANTITY = 10
_NS = uuid.UUID("6f1c2a7e-3b9d-4c55-9a0e-2d7f5b8c1e44")  # namespace for idempotent ids

_pos_key = None


def _args(event):
    if isinstance(event, dict):
        for k in ("input", "arguments", "body"):
            if isinstance(event.get(k), dict):
                return event[k]
    return event if isinstance(event, dict) else {}


def _error(code, message, action, **extra):
    return {"status": "error", "code": code, "message": message, "suggestedAction": action, **extra}


def _num(d):
    return int(d) if d % 1 == 0 else float(d)


def _catalog(menu):
    items = menu.scan().get("Items", [])
    active = [p for p in items if p.get("active", True)]
    return sorted(
        ({"pizzaId": p["pizzaId"], "name": p.get("name"), "price": _num(p.get("price", 0))}
         for p in active),
        key=lambda p: p["price"],
    )


def parse_quantity(value):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= MAX_QUANTITY else None


def _pos_api_key():
    global _pos_key
    if _pos_key is None and POS_SECRET_ARN:
        raw = _secrets.get_secret_value(SecretId=POS_SECRET_ARN)["SecretString"]
        _pos_key = json.loads(raw).get("apiKey", "")
    return _pos_key or ""


def _send_to_pos(order):
    """POST the order to the store POS. Best-effort for the demo."""
    if not POS_API_BASE_URL:
        return "skipped"
    try:
        req = urllib.request.Request(
            f"{POS_API_BASE_URL.rstrip('/')}/orders",
            data=json.dumps(order, default=str).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {_pos_api_key()}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return "ok" if 200 <= resp.status < 300 else f"error:{resp.status}"
    except Exception as exc:  # noqa: BLE001 — demo best-effort
        return f"error:{type(exc).__name__}"


def lambda_handler(event, context):
    args = _args(event)
    items = args.get("items")
    menu = _ddb.Table(MENU_TABLE)

    # 1. Shape
    if not isinstance(items, list) or not items:
        return _error("EMPTY_ORDER", "The order has no pizzas.",
                      "Ask the caller which pizzas they want before calling create_order.")
    if len(items) > MAX_LINES:
        return _error("ORDER_TOO_LARGE", f"At most {MAX_LINES} lines per order.",
                      "Offer to split the order or transfer to a human agent.")

    # 2. Catalog + 3. server-side price
    total = decimal.Decimal(0)
    lines = []
    for it in items:
        it = it if isinstance(it, dict) else {}
        pizza_id = str(it.get("pizzaId") or "").strip().lower()
        quantity = parse_quantity(it.get("quantity", 1))
        if quantity is None:
            return _error("INVALID_QUANTITY",
                          f"Invalid quantity for '{pizza_id}': {it.get('quantity')!r}.",
                          f"Confirm with the caller a quantity between 1 and {MAX_QUANTITY}.")
        pizza = menu.get_item(Key={"pizzaId": pizza_id}).get("Item") if pizza_id else None
        if not pizza or not pizza.get("active", True):
            return _error("PIZZA_NOT_ON_MENU",
                          f"'{pizza_id}' is not on the menu.",
                          "Do not invent it or accept it: offer a pizza from 'catalog' "
                          "and confirm the choice before retrying.",
                          catalog=_catalog(menu))
        price = decimal.Decimal(str(pizza.get("price", 0)))
        total += price * quantity
        lines.append({"pizzaId": pizza_id, "name": pizza.get("name"),
                      "quantity": quantity, "price": price})

    # 4. Idempotency
    contact_id = (args.get("contactId") or "").strip()
    signature = json.dumps(sorted((l["pizzaId"], l["quantity"]) for l in lines))
    order_id = str(uuid.uuid5(_NS, f"{contact_id}|{signature}")) if contact_id else str(uuid.uuid4())

    order = {
        "orderId": order_id,
        "customerId": args.get("customerId"),
        "phone": args.get("phone"),
        "storeId": args.get("storeId"),
        "contactId": contact_id or None,
        "items": lines,
        "total": total,
        "status": "CREATED",
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "posStatus": "pending",
    }
    order = {k: v for k, v in order.items() if v is not None}  # DynamoDB rejects nulls
    orders = _ddb.Table(ORDERS_TABLE)
    try:
        orders.put_item(
            Item=order,
            ConditionExpression="attribute_not_exists(orderId)",
            ReturnValuesOnConditionCheckFailure="ALL_OLD",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        prev = exc.response.get("Item") or {}
        return {
            "status": "duplicate",
            "orderId": order_id,
            "total": _num(total),
            "posStatus": (prev.get("posStatus") or {}).get("S", "unknown"),
            "message": "This order was already registered on this call; no new order was created.",
        }

    pos_status = _send_to_pos(order)
    orders.update_item(
        Key={"orderId": order_id},
        UpdateExpression="SET posStatus = :s",
        ExpressionAttributeValues={":s": pos_status},
    )

    return {
        "status": "created",
        "orderId": order_id,
        "total": _num(total),
        "lines": [{"name": l["name"], "quantity": l["quantity"]} for l in lines],
        "posStatus": pos_status,
    }
