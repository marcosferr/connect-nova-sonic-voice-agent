"""get_menu — read the fixed menu from DynamoDB (pizzas, prices, active promos).

Input  (MCP tool arguments): { "activeOnly": true }  (all fields optional)
Output: { "status": "ok", "total": n, "validPizzaIds": [...],
          "pizzas": [ {pizzaId, name, description, price, promo?} ] }

This is the agent's only source of truth for the catalog: the prompt forbids
reciting the menu from memory. The response is compact and sorted by price so
the voice model offers 2-3 options instead of reading a long list, and
`validPizzaIds` gives it the exact ids `create_order` will accept.
"""
import decimal
import os

import boto3

_ddb = boto3.resource("dynamodb")
MENU_TABLE = os.environ["MENU_TABLE"]


def _args(event):
    if isinstance(event, dict):
        for k in ("input", "arguments", "body"):
            if isinstance(event.get(k), dict):
                return event[k]
    return event if isinstance(event, dict) else {}


def _num(v):
    d = decimal.Decimal(str(v))
    return int(d) if d % 1 == 0 else float(d)


def lambda_handler(event, context):
    args = _args(event)
    active_only = str(args.get("activeOnly", True)).lower() != "false"

    items = _ddb.Table(MENU_TABLE).scan().get("Items", [])
    if active_only:
        items = [p for p in items if p.get("active", True)]

    pizzas = sorted(
        (
            {
                "pizzaId": p["pizzaId"],
                "name": p.get("name"),
                "description": p.get("description"),
                "price": _num(p.get("price", 0)),
                **({"promo": p["promo"]} if p.get("promo") else {}),
            }
            for p in items
        ),
        key=lambda p: p["price"],
    )
    return {
        "status": "ok",
        "total": len(pizzas),
        "validPizzaIds": [p["pizzaId"] for p in pizzas],
        "pizzas": pizzas,
    }
