---
name: uat-excel-creation
description: This skill should be used when the user asks to "create an excel of the test calls", "generate a UAT spreadsheet", "make an xlsx of the last N calls", "export the calls to excel", or wants the last N Forno Pizza voice-agent calls written to a styled .xlsx with transcript / order / successful columns. Builds on the read-only uat-check workflow and scripts/build_uat_excel.py.
---

# UAT-Excel-Creation - call review as a spreadsheet

## Purpose

Produce a styled Excel workbook for a window of calls to the Forno Pizza voice
agent. One row per inbound voice call:

- **Transcript** - the full chronological BOT / CUSTOMER conversation.
- **Order (as confirmed)** - the pizzas, quantities and total the caller
  confirmed at the read-back (e.g. `2x Napolitana, 1x Pepperoni - total 27970`).
- **Successful** - YES / NO / PARTIAL (green / red / amber).

Plus **Contact ID**, **Call date** and **Notes** for traceability. The skill is
**read-only against AWS**: it reads contacts, transcripts, spans and DynamoDB
rows, then writes a local `.xlsx`. It never deploys anything.

This is the "hand someone a deliverable" companion to
[uat-check](../uat-check/SKILL.md): use uat-check to investigate, this to share.

## Inputs the user usually gives

- A **window**: "last 20 calls", "calls since 2026-01-15". Default to the 20
  most recent inbound voice calls.
- Optionally an output name. Otherwise use
  `docs/test-call-review-last-N-YYYY-MM-DD.xlsx`.

## Workflow

### Step 1 - list the window

```bash
scripts/list-recent-contacts.sh --since YYYY-MM-DD --count 30 | column -t -s $'\t'
```

Columns: `contactId initiation method orderCount total posStatus orderIds`.
Take the N most recent rows; ask for `--count` slightly above N. Add `--all` if
the user wants the synthetic test calls (`WEBRTC_API`) too.

> `search-contacts` is eventually consistent - a call that ended seconds ago
> may take 1-5 minutes to appear. If the user "just hung up", wait and re-list.

### Step 2 - pull every transcript into ONE repo-relative directory

```bash
WORK="test-calls/transcripts-$(date +%Y-%m-%d)"   # bash and Python resolve it identically
mkdir -p "$WORK"
while read -r cid; do
  scripts/pull-session-transcript.sh "$cid" > "$WORK/$cid.txt" 2>/dev/null && echo "ok $cid"
done < contacts.txt
```

Windows gotcha: git-bash `/tmp` and Python's `/tmp` are different folders. If
you pull into `/tmp` with bash and read with Python, every transcript cell comes
out `(transcript not found)`. A repo-relative directory avoids it. Keep that
directory out of git (transcripts contain caller audio-derived text).

### Step 3 - classify each call

Use the transcript, the Step 1 columns and, when in doubt,
`python scripts/list-tool-calls.py --contact <id>`.

| Condition | Successful |
|---|---|
| `orderCount=1`, read-back confirmed, row items/total match the transcript | **YES** |
| `orderCount=1` but items or total differ from what was confirmed | **PARTIAL** - note the diff |
| `orderCount=1` but `posStatus` is `error:*` | **PARTIAL** - saved, not forwarded |
| `orderCount>=2` | **PARTIAL** - idempotency regression, note which row is right |
| `orderCount=0` and the caller wanted to order (hang-up mid-order, tool error, escalation) | **NO** |
| `orderCount=0` and the caller only asked about the menu / declined | **YES** if handled correctly - say so in Notes |

**Order (as confirmed)** comes from the agent's read-back in the transcript or
the row's `items` + `total`. Use `(none)` when the call never reached a
read-back. Never invent it.

Verify a suspicious row:

```bash
aws dynamodb get-item --table-name pizza-voice-orders-dev \
  --key '{"orderId":{"S":"<orderId>"}}' \
  --query 'Item.{items:items,total:total.N,pos:posStatus.S,contact:contactId.S}'
```

### Step 4 - write rows.json and build the workbook

```json
[
  {"contactId": "<contactId>", "call_date": "2026-01-15",
   "order": "2x Napolitana, 1x Pepperoni - total 27970",
   "successful": "YES",
   "note": "Caller ID recognized; read-back confirmed; posStatus ok."}
]
```

```bash
python scripts/build_uat_excel.py \
  --rows rows.json \
  --transcripts-dir "$WORK" \
  --out docs/test-call-review-last-20-$(date +%Y-%m-%d).xlsx \
  --title "Test calls last 20"
```

### Step 5 - verify before handing it over

The builder prints `transcript cells missing: N` and exits non-zero if N > 0.
**It must be 0.** Optionally spot-check:

```bash
python -c "from openpyxl import load_workbook; ws=load_workbook('docs/test-call-review-last-20-....xlsx').active; print('rows', ws.max_row-1); print((ws.cell(2,3).value or '')[:120])"
```

Report the tally ("20 calls: 15 successful, 3 not, 2 partial") and call out
anomalies, with the same discipline as uat-check.

## Output contract

- One sheet: `Contact ID | Call date | Transcript | Order (as confirmed) | Successful | Notes`.
- `Successful` color-coded (YES green, NO red, PARTIAL amber); header row frozen.

## Anti-patterns

- Reading bash-written `/tmp` files from Python on Windows.
- Marking YES just because a row exists - compare items and total with the
  confirmed read-back.
- Inventing the order column when the call never reached a read-back.
- Deploying or modifying any AWS resource.
- Scanning DynamoDB once per contact.
- Committing the workbook or transcripts to a public repo - they contain caller
  phone numbers. Share them out of band.

## Requirements

`openpyxl` (`pip install openpyxl`); the builder uses only openpyxl + stdlib.
