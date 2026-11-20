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
for var in ("CUSTOMERS_TABLE", "CUSTOMERS_PHONE_INDEX", "ORDERS_TABLE", "MENU_TABLE", "STORES_TABLE"):
    os.environ.setdefault(var, "unit-test")

LAMBDAS = Path(__file__).resolve().parents[2] / "src" / "lambdas"


def load(slug):
    spec = importlib.util.spec_from_file_location(slug.replace("-", "_"), LAMBDAS / slug / "lambda_function.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


validate_customer = load("validate-customer")
create_order = load("create-order")


class PhoneNormalization(unittest.TestCase):
    def test_accepts_common_spoken_and_written_forms(self):
        for raw in ("+56 9 1234 5678", "912345678", "56912345678", "+56912345678"):
            self.assertEqual(validate_customer.normalize_phone(raw), "+56912345678", raw)

    def test_keeps_other_countries_in_e164(self):
        self.assertEqual(validate_customer.normalize_phone("+1 (555) 010-2030"), "+15550102030")

    def test_rejects_non_numbers(self):
        for raw in ("nueve ocho", "123", "", None):
            self.assertIsNone(validate_customer.normalize_phone(raw), raw)

    def test_invalid_phone_returns_structured_error(self):
        out = validate_customer.lambda_handler({"input": {"phone": "no idea"}}, None)
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["code"], "INVALID_PHONE")
        self.assertIn("suggestedAction", out)


class OrderShape(unittest.TestCase):
    def test_quantity_parsing(self):
        cases = {"2": 2, 2: 2, " 3 ": 3, "dos": None, 0: None, -1: None, 11: None, "1.5": None}
        for raw, want in cases.items():
            self.assertEqual(create_order.parse_quantity(raw), want, raw)

    def test_empty_order(self):
        self.assertEqual(create_order.lambda_handler({"input": {"items": []}}, None)["code"], "EMPTY_ORDER")

    def test_too_many_lines(self):
        items = [{"pizzaId": "napolitana", "quantity": 1}] * (create_order.MAX_LINES + 1)
        self.assertEqual(create_order.lambda_handler({"input": {"items": items}}, None)["code"],
                         "ORDER_TOO_LARGE")

    def test_spoken_quantity_is_rejected_before_any_write(self):
        out = create_order.lambda_handler({"input": {"items": [{"pizzaId": "napolitana", "quantity": "dos"}]}}, None)
        self.assertEqual(out["code"], "INVALID_QUANTITY")


if __name__ == "__main__":
    unittest.main()
