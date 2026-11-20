"""validar_cliente — resuelve el caller ID contra la tabla Clientes.

Input  (MCP tool arguments): { "telefono": "+56912345678", "nombre": "opt" }
Output: { "status": "found|created", "clienteId": "...", "telefono": "+569...",
          "nombre": "...", "esNuevo": bool }
Error:  { "status": "error", "code": "...", "message": "...", "accionSugerida": "..." }

Validación (no se confía en lo que el modelo transcribió):
- El teléfono se normaliza a E.164 (acepta "9 1234 5678", "56912345678",
  "+56 9 1234 5678"). Si no es un número válido, NO se crea el cliente.
- El prompt le pasa el caller ID de la red (`{{$.Custom.customer_phone}}`),
  así que en el camino feliz el modelo nunca dicta el número.
"""
import os
import re
import uuid

import boto3
from boto3.dynamodb.conditions import Key

_ddb = boto3.resource("dynamodb")
CLIENTES_TABLE = os.environ["CLIENTES_TABLE"]
TELEFONO_INDEX = os.environ["CLIENTES_TELEFONO_INDEX"]

_E164 = re.compile(r"^\+[1-9]\d{7,14}$")


def _args(event):
    if isinstance(event, dict):
        for k in ("input", "arguments", "body"):
            if isinstance(event.get(k), dict):
                return event[k]
    return event if isinstance(event, dict) else {}


def _error(code, message, accion):
    return {"status": "error", "code": code, "message": message, "accionSugerida": accion}


def normalizar_telefono(raw):
    """Return the E.164 form of `raw`, or None if it is not a plausible number."""
    raw = (raw or "").strip()
    digits = re.sub(r"\D", "", raw)
    if raw.startswith("+"):
        candidate = "+" + digits
    elif len(digits) == 9 and digits.startswith("9"):  # móvil chileno sin prefijo
        candidate = "+56" + digits
    elif len(digits) == 11 and digits.startswith("56"):
        candidate = "+" + digits
    else:
        candidate = "+" + digits
    return candidate if _E164.match(candidate) else None


def lambda_handler(event, context):
    args = _args(event)
    telefono = normalizar_telefono(args.get("telefono"))
    if not telefono:
        return _error(
            "TELEFONO_INVALIDO",
            f"'{args.get('telefono')}' no es un número de teléfono válido.",
            "Pide al cliente su número completo, repítelo dígito a dígito para confirmarlo "
            "y vuelve a llamar a validar_cliente.",
        )

    table = _ddb.Table(CLIENTES_TABLE)
    found = table.query(
        IndexName=TELEFONO_INDEX,
        KeyConditionExpression=Key("telefono").eq(telefono),
        Limit=1,
    ).get("Items", [])

    if found:
        c = found[0]
        return {
            "status": "found",
            "clienteId": c["clienteId"],
            "telefono": c.get("telefono"),
            "nombre": c.get("nombre"),
            "esNuevo": False,
        }

    cliente_id = str(uuid.uuid4())
    item = {"clienteId": cliente_id, "telefono": telefono}
    nombre = (args.get("nombre") or "").strip()
    if nombre:
        item["nombre"] = nombre[:80]
    table.put_item(Item=item)
    return {
        "status": "created",
        "clienteId": cliente_id,
        "telefono": telefono,
        "nombre": item.get("nombre"),
        "esNuevo": True,
    }
