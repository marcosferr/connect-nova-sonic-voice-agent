"""crear_pedido — valida el pedido contra el catálogo, lo guarda una sola vez y lo envía al POS.

Input (MCP tool arguments):
  {
    "clienteId": "...", "telefono": "...", "tiendaId": "opt",
    "contactId": "Amazon Connect contactId ({{$.contactId}}) — clave de idempotencia",
    "items": [ {"pizzaId": "...", "cantidad": 2} ]
  }
Output: { "status": "created|duplicate", "pedidoId": "...", "total": 12345,
          "lineas": [...], "posStatus": "ok|skipped|error:..." }
Error:  { "status": "error", "code": "...", "message": "...", "accionSugerida": "...",
          "catalogo"?: [ {pizzaId, nombre, precio} ] }

Capas de validación (el modelo de voz propone, el servidor decide):
1. Forma: 1..MAX_LINEAS líneas, `cantidad` entera 1..MAX_CANTIDAD (acepta "2").
2. Catálogo: cada `pizzaId` debe existir y estar activo. Si no, se devuelve el
   catálogo válido para que el agente ofrezca una alternativa real.
3. Precio: el total lo calcula el servidor con el precio de la tabla Menu;
   el modelo nunca envía precios.
4. Idempotencia: con `contactId`, el `pedidoId` es determinístico
   (uuid5(contactId + líneas)) y el put es condicional. Si el modelo repite
   la llamada, se devuelve el pedido original con status "duplicate".
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

PEDIDOS_TABLE = os.environ["PEDIDOS_TABLE"]
MENU_TABLE = os.environ["MENU_TABLE"]
TIENDAS_TABLE = os.environ["TIENDAS_TABLE"]
POS_API_BASE_URL = os.environ.get("POS_API_BASE_URL", "")
POS_SECRET_ARN = os.environ.get("POS_SECRET_ARN", "")

MAX_LINEAS = 10
MAX_CANTIDAD = 10
_NS = uuid.UUID("6f1c2a7e-3b9d-4c55-9a0e-2d7f5b8c1e44")  # namespace for idempotent ids

_pos_key = None


def _args(event):
    if isinstance(event, dict):
        for k in ("input", "arguments", "body"):
            if isinstance(event.get(k), dict):
                return event[k]
    return event if isinstance(event, dict) else {}


def _error(code, message, accion, **extra):
    return {"status": "error", "code": code, "message": message, "accionSugerida": accion, **extra}


def _num(d):
    return int(d) if d % 1 == 0 else float(d)


def _catalogo(menu):
    items = menu.scan().get("Items", [])
    activos = [p for p in items if p.get("activa", True)]
    return sorted(
        ({"pizzaId": p["pizzaId"], "nombre": p.get("nombre"), "precio": _num(p.get("precio", 0))}
         for p in activos),
        key=lambda p: p["precio"],
    )


def _cantidad(value):
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= MAX_CANTIDAD else None


def _pos_api_key():
    global _pos_key
    if _pos_key is None and POS_SECRET_ARN:
        raw = _secrets.get_secret_value(SecretId=POS_SECRET_ARN)["SecretString"]
        _pos_key = json.loads(raw).get("apiKey", "")
    return _pos_key or ""


def _send_to_pos(pedido):
    """POST the order to the store POS. Best-effort for the POC."""
    if not POS_API_BASE_URL:
        return "skipped"
    try:
        req = urllib.request.Request(
            f"{POS_API_BASE_URL.rstrip('/')}/pedidos",
            data=json.dumps(pedido, default=str).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {_pos_api_key()}"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return "ok" if 200 <= resp.status < 300 else f"error:{resp.status}"
    except Exception as exc:  # noqa: BLE001 — POC best-effort
        return f"error:{type(exc).__name__}"


def lambda_handler(event, context):
    args = _args(event)
    items = args.get("items")
    menu = _ddb.Table(MENU_TABLE)

    # 1. Forma
    if not isinstance(items, list) or not items:
        return _error("PEDIDO_VACIO", "El pedido no tiene pizzas.",
                      "Pregunta al cliente qué pizzas quiere antes de llamar a crear_pedido.")
    if len(items) > MAX_LINEAS:
        return _error("PEDIDO_DEMASIADO_GRANDE", f"Máximo {MAX_LINEAS} líneas por pedido.",
                      "Ofrece dividir el pedido o transferir a un agente.")

    # 2. Catálogo + 3. precio calculado en el servidor
    total = decimal.Decimal(0)
    lineas = []
    for it in items:
        it = it if isinstance(it, dict) else {}
        pizza_id = str(it.get("pizzaId") or "").strip().lower()
        cantidad = _cantidad(it.get("cantidad", 1))
        if cantidad is None:
            return _error("CANTIDAD_INVALIDA",
                          f"Cantidad inválida para '{pizza_id}': {it.get('cantidad')!r}.",
                          f"Confirma con el cliente una cantidad entre 1 y {MAX_CANTIDAD}.")
        pizza = menu.get_item(Key={"pizzaId": pizza_id}).get("Item") if pizza_id else None
        if not pizza or not pizza.get("activa", True):
            return _error("PIZZA_FUERA_DE_CATALOGO",
                          f"'{pizza_id}' no está en el menú.",
                          "No la inventes ni la aceptes: ofrece una pizza de 'catalogo' "
                          "y confirma la elección antes de reintentar.",
                          catalogo=_catalogo(menu))
        precio = decimal.Decimal(str(pizza.get("precio", 0)))
        total += precio * cantidad
        lineas.append({"pizzaId": pizza_id, "nombre": pizza.get("nombre"),
                       "cantidad": cantidad, "precio": precio})

    # 4. Idempotencia
    contact_id = (args.get("contactId") or "").strip()
    firma = json.dumps(sorted((l["pizzaId"], l["cantidad"]) for l in lineas))
    pedido_id = str(uuid.uuid5(_NS, f"{contact_id}|{firma}")) if contact_id else str(uuid.uuid4())

    pedido = {
        "pedidoId": pedido_id,
        "clienteId": args.get("clienteId"),
        "telefono": args.get("telefono"),
        "tiendaId": args.get("tiendaId"),
        "contactId": contact_id or None,
        "items": lineas,
        "total": total,
        "estado": "CREADO",
        "creadoEn": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "posStatus": "pending",
    }
    pedido = {k: v for k, v in pedido.items() if v is not None}  # DynamoDB rejects nulls
    pedidos = _ddb.Table(PEDIDOS_TABLE)
    try:
        pedidos.put_item(
            Item=pedido,
            ConditionExpression="attribute_not_exists(pedidoId)",
            ReturnValuesOnConditionCheckFailure="ALL_OLD",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        prev = exc.response.get("Item") or {}
        return {
            "status": "duplicate",
            "pedidoId": pedido_id,
            "total": _num(total),
            "posStatus": (prev.get("posStatus") or {}).get("S", "unknown"),
            "message": "Este pedido ya estaba registrado en esta llamada; no se creó otro.",
        }

    pos_status = _send_to_pos(pedido)
    pedidos.update_item(
        Key={"pedidoId": pedido_id},
        UpdateExpression="SET posStatus = :s",
        ExpressionAttributeValues={":s": pos_status},
    )

    return {
        "status": "created",
        "pedidoId": pedido_id,
        "total": _num(total),
        "lineas": [{"nombre": l["nombre"], "cantidad": l["cantidad"]} for l in lineas],
        "posStatus": pos_status,
    }
