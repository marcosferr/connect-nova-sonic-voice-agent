"""consultar_menu — lee la tabla Menu (pizzas fijas, precios, promos activas).

Input  (MCP tool arguments): { "soloActivas": true }  (todos los campos opcionales)
Output: { "status": "ok", "total": n, "pizzaIdsValidos": [...],
          "pizzas": [ {pizzaId, nombre, descripcion, precio, promo?} ] }

Es la única fuente de verdad del catálogo para el agente: el prompt le prohíbe
recitar el menú de memoria. La respuesta es compacta y ordenada por precio para
que el modelo de voz ofrezca 2-3 opciones sin leer una lista larga, y
`pizzaIdsValidos` le da los ids exactos que `crear_pedido` va a aceptar.
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
    solo_activas = str(args.get("soloActivas", True)).lower() != "false"

    items = _ddb.Table(MENU_TABLE).scan().get("Items", [])
    if solo_activas:
        items = [p for p in items if p.get("activa", True)]

    pizzas = sorted(
        (
            {
                "pizzaId": p["pizzaId"],
                "nombre": p.get("nombre"),
                "descripcion": p.get("descripcion"),
                "precio": _num(p.get("precio", 0)),
                **({"promo": p["promo"]} if p.get("promo") else {}),
            }
            for p in items
        ),
        key=lambda p: p["precio"],
    )
    return {
        "status": "ok",
        "total": len(pizzas),
        "pizzaIdsValidos": [p["pizzaId"] for p in pizzas],
        "pizzas": pizzas,
    }
