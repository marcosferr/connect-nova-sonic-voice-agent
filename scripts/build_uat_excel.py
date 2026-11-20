#!/usr/bin/env python3
"""Build a test-call review Excel workbook from a rows spec + pulled transcripts.

The engine behind the `uat-excel-creation` skill. It does NOT talk to AWS: it
only assembles an .xlsx from (a) a JSON list of per-call rows you classified,
and (b) a directory of transcript .txt files produced by
scripts/pull-session-transcript.sh (one <contactId>.txt per call).

Rows JSON shape (a list of objects):
  [
    {"contactId": "...", "call_date": "2026-01-15",
     "order": "2x Napolitana, 1x Pepperoni - total 27970",
     "successful": "YES",
     "note": "short explanation"},
    ...
  ]
  successful must be one of: YES | NO | PARTIAL

Usage:
  python scripts/build_uat_excel.py --rows rows.json \\
      --transcripts-dir test-calls/transcripts-2026-01-15 \\
      --out docs/test-call-review-last-20-2026-01-15.xlsx \\
      [--title "Test calls last 20"]

Output columns: Contact ID | Call date | Transcript | Order (as confirmed) | Successful | Notes

Defensive notes:
- Always pass an explicit --transcripts-dir. On Windows, git-bash `/tmp` and
  Python's `/tmp` are different folders, so prefer a repo-relative directory.
- Transcripts are read with errors="replace" so stray non-UTF-8 bytes from a
  shell redirect never abort the build.

Requires: openpyxl (pip install openpyxl).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

HEADER_FILL = PatternFill("solid", fgColor="305496")
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
FILLS = {
    "YES": PatternFill("solid", fgColor="C6EFCE"),
    "NO": PatternFill("solid", fgColor="FFC7CE"),
    "PARTIAL": PatternFill("solid", fgColor="FFEB9C"),
}
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
NOT_FOUND = "(transcript not found)"

COLUMNS = [
    ("Contact ID", 38),
    ("Call date", 12),
    ("Transcript", 90),
    ("Order (as confirmed)", 32),
    ("Successful", 12),
    ("Notes", 60),
]


def transcript_text(trans_dir: Path, cid: str) -> str:
    p = trans_dir / f"{cid}.txt"
    if not p.exists():
        return NOT_FOUND
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    out, capture = [], False
    for ln in lines:
        if ln.startswith("=== Transcript"):
            capture = True
            continue
        if capture and ln.strip():
            out.append(ln.rstrip())
    if not out:  # no header: keep BOT / CUSTOMER lines only
        out = [ln.rstrip() for ln in lines if "BOT:" in ln or "CUSTOMER:" in ln]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a styled test-call review .xlsx.")
    ap.add_argument("--rows", required=True, help="JSON file: list of row objects")
    ap.add_argument("--transcripts-dir", required=True, help="directory of <contactId>.txt files")
    ap.add_argument("--out", required=True, help="output .xlsx path")
    ap.add_argument("--title", default="Test call review", help="worksheet title (max 31 chars)")
    args = ap.parse_args()

    rows = json.loads(Path(args.rows).read_text(encoding="utf-8"))
    trans_dir = Path(args.transcripts_dir)
    out = Path(args.out)

    wb = Workbook()
    ws = wb.active
    ws.title = args.title[:31]

    for i, (name, width) in enumerate(COLUMNS, start=1):
        c = ws.cell(row=1, column=i, value=name)
        c.fill = HEADER_FILL
        c.font = HEADER_FONT
        c.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
        c.border = BORDER
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.row_dimensions[1].height = 30
    ws.freeze_panes = "A2"

    missing = 0
    for r, row in enumerate(rows, start=2):
        cid = row["contactId"]
        ok = (row.get("successful") or "").upper()
        tx = transcript_text(trans_dir, cid)
        if tx == NOT_FOUND:
            missing += 1
        values = [cid, row.get("call_date", ""), tx, row.get("order", ""), ok, row.get("note", "")]
        for col, val in enumerate(values, start=1):
            cell = ws.cell(row=r, column=col, value=val)
            cell.alignment = Alignment(vertical="top", wrap_text=True)
            cell.border = BORDER
        sc = ws.cell(row=r, column=5)
        sc.fill = FILLS.get(ok, FILLS["PARTIAL"])
        sc.font = Font(bold=True)
        sc.alignment = Alignment(horizontal="center", vertical="top")

    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)

    ny = sum(1 for x in rows if (x.get("successful") or "").upper() == "YES")
    nn = sum(1 for x in rows if (x.get("successful") or "").upper() == "NO")
    print(f"Wrote {out}")
    print(f"{len(rows)} calls: {ny} successful, {nn} not successful, {len(rows) - ny - nn} partial "
          f"| transcript cells missing: {missing}")
    if missing:
        print("WARNING: some transcripts not found - check --transcripts-dir.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
