"""Offline tests for the MCP tools' validation layer (no AWS calls).

The voice model proposes; these checks decide. They run before any DynamoDB
access, so they can be exercised with dummy table names.
Run: python -m unittest discover -s tests/unit -v
"""
import importlib.util
import os
import unittest
from pathlib import Path

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
for var in ("CLIENTES_TABLE", "CLIENTES_TELEFONO_INDEX", "PEDIDOS_TABLE", "MENU_TABLE", "TIENDAS_TABLE"):
    os.environ.setdefault(var, "unit-test")

LAMBDAS = Path(__file__).resolve().parents[2] / "src" / "lambdas"


def load(slug):
    spec = importlib.util.spec_from_file_location(slug.replace("-", "_"), LAMBDAS / slug / "lambda_function.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


validar = load("validar-cliente")
crear = load("crear-pedido")


class PhoneNormalization(unittest.TestCase):
    def test_accepts_common_spoken_and_written_forms(self):
        for raw in ("+56 9 1234 5678", "912345678", "56912345678", "+56912345678"):
            self.assertEqual(validar.normalizar_telefono(raw), "+56912345678", raw)

    def test_keeps_other_countries_in_e164(self):
        self.assertEqual(validar.normalizar_telefono("+1 (555) 010-2030"), "+15550102030")

    def test_rejects_non_numbers(self):
        for raw in ("nueve ocho", "123", "", None):
            self.assertIsNone(validar.normalizar_telefono(raw), raw)

    def test_invalid_phone_returns_structured_error(self):
        out = validar.lambda_handler({"input": {"telefono": "no sé"}}, None)
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["code"], "TELEFONO_INVALIDO")
        self.assertIn("accionSugerida", out)


class OrderShape(unittest.TestCase):
    def test_quantity_parsing(self):
        cases = {"2": 2, 2: 2, " 3 ": 3, "dos": None, 0: None, -1: None, 11: None, "1.5": None}
        for raw, want in cases.items():
            self.assertEqual(crear._cantidad(raw), want, raw)

    def test_empty_order(self):
        self.assertEqual(crear.lambda_handler({"input": {"items": []}}, None)["code"], "PEDIDO_VACIO")

    def test_too_many_lines(self):
        items = [{"pizzaId": "napolitana", "cantidad": 1}] * (crear.MAX_LINEAS + 1)
        self.assertEqual(crear.lambda_handler({"input": {"items": items}}, None)["code"],
                         "PEDIDO_DEMASIADO_GRANDE")

    def test_spoken_quantity_is_rejected_before_any_write(self):
        out = crear.lambda_handler({"input": {"items": [{"pizzaId": "napolitana", "cantidad": "dos"}]}}, None)
        self.assertEqual(out["code"], "CANTIDAD_INVALIDA")


if __name__ == "__main__":
    unittest.main()
