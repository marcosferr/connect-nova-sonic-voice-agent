---
name: uat-check
description: This skill should be used when the user asks to "check the UAT", "review the test calls", "audit today's calls", "did the order get saved", "any duplicate pedidos", "why was there no pedido for this call", or wants to cross-reference Amazon Connect contacts with Q in Connect transcripts, MCP tool spans and the pizza-voice pedidos DynamoDB table for the Forno Pizza voice agent. Read-only.
---

# UAT-Check - review real or test calls end to end

## Purpose

A repeatable, read-only workflow for reviewing calls to the Forno Pizza voice
agent. A review answers, for a window of calls:

- Did the call produce a row in `<project>-pedidos-<env>` (default
  `pizza-voice-pedidos-dev`)?
- Did the agent read the full order back and get an explicit "sí" **before**
  calling `crear_pedido`?
- Does the saved row (`items`, `total`) match what the caller actually asked
  for in the transcript?
- Was the order forwarded to the store POS (`posStatus`)?
- Any idempotency regression (2+ rows for one `contactId`)?

All IDs are resolved from the `$PROJECT_NAME-$ENV_NAME-conversational-ai` stack
outputs. Set `AWS_PROFILE` / `AWS_REGION` / `PROJECT_NAME` / `ENV_NAME` if they
differ from the defaults (`us-east-1`, `pizza-voice`, `dev`).

## Tools available

| Tool | What it does |
|---|---|
| `scripts/list-recent-contacts.sh` | Joins Connect `search-contacts` with one DynamoDB scan of the pedidos table. Tab-separated: `contactId initiation method pedidoCount total posStatus pedidoIds`. |
| `scripts/pull-session-transcript.sh <contactId>` | Resolves the Q in Connect session, paginates `qconnect list-messages`, prints a chronological BOT / CUSTOMER transcript. |
| `python scripts/list-tool-calls.py --contact <contactId>` | ListSpans view: which MCP tools were called, arguments, OK / ERROR / business error. See [list-tool-calls](../list-tool-calls/SKILL.md). |
| `aws dynamodb get-item --table-name pizza-voice-pedidos-dev --key '{"pedidoId":{"S":"<id>"}}'` | Full pedido row: `contactId`, `telefono`, `clienteId`, `items`, `total`, `posStatus`, `creadoEn`. |
| `aws logs tail /aws/lambda/pizza-voice-crear-pedido-dev --since 2h --filter-pattern '"<contactId>"'` | The tool Lambda's own view of that call (validation errors, POS response). Same pattern for `-validar-cliente-` and `-consultar-menu-`. |

## Workflow

### Step 1. Window the calls

```bash
scripts/list-recent-contacts.sh                              # last 24h, inbound voice
scripts/list-recent-contacts.sh --since 2026-01-15 --count 100
scripts/list-recent-contacts.sh --all                        # include synthetic WEBRTC_API / API contacts
```

Pipe to `column -t -s $'\t'` for a table, or to a file to diff across runs.

### Step 2. Categorize outcomes

Investigate in this priority order:

| `pedidoCount` | `posStatus` | Meaning | Action |
|:--:|:--:|---|---|
| 2+ | any | **Idempotency regression.** `crear_pedido` derives `pedidoId` from `contactId` + lines and uses a conditional put, so a retry should return `duplicate`, not a second row. Two rows usually means the model changed the lines between calls (e.g. added a pizza after the first save) or omitted `contactId`. | Always investigate. Pull spans and compare the `items` of each call. |
| 1 | `error:*` / `pending` | Saved, but the store POS did not accept it. | Tail the crear-pedido Lambda log; check the POS secret / base URL. |
| 0 | - | No pedido. Hang-up, caller declined, the model never called `crear_pedido`, or the call returned `status=error`. | Run `list-tool-calls.py --contact` to tell those apart, then read the transcript. |
| 1 | `ok` / `skipped` | Happy path (`skipped` = no POS configured). | Drill in only if the items or total look wrong. |

### Step 3. Drill into a single contact

```bash
scripts/pull-session-transcript.sh <contactId>              # what was said
python scripts/list-tool-calls.py --contact <contactId>     # what the agent did
aws dynamodb get-item --table-name pizza-voice-pedidos-dev \
  --key '{"pedidoId":{"S":"<pedidoId>"}}'                   # what was persisted
```

### Step 4. Compare transcript vs persisted order

- `items[]` - every `pizzaId` must exist in the menu table
  (`pizza-voice-menu-dev`, seeded from `docs/seed/menu.json`); quantities must
  match what the caller confirmed at the read-back.
- `total` - computed server-side from menu prices; it must equal the total the
  agent spoke at the recap. A mismatch means the agent did arithmetic from
  memory instead of reading the tool result.
- `telefono` - E.164 (`+569...`). It comes from the caller ID injected into the
  session as `{{$.Custom.customer_phone}}`; the agent should never have asked
  for it unless that value was empty.
- `contactId` - must equal the Connect contact id; if missing, idempotency is off
  for that call.
- Off-menu requests (half-and-half, extra toppings, other sizes) must have been
  redirected to the closest menu item, never saved.

### Step 5. Report

1. **Bucket counts** for the window (e.g. "18 calls: 12 normal, 3 no-pedido
   hang-ups, 2 business errors, 1 POS error, 0 duplicates").
2. **Specific `contactId`s** for each non-normal bucket.
3. **One-line "expected vs got" diffs** for each anomaly, sourced from the
   transcript + row + spans.

Keep the summary tight; full transcripts belong in tool output.

## Anti-patterns

- **Do not call `qconnect list-messages` by hand when a `contactId` is known.**
  `pull-session-transcript.sh` resolves the session, paginates and sorts.
- **Do not re-scan DynamoDB once per contact.** `list-recent-contacts.sh` does a
  single windowed scan and joins in memory.
- **Do not assume menu items or prices from memory.** The menu table is the
  source of truth.
- **Do not deploy anything during a review.** This skill is read-only; surface
  findings and let the user decide on a prompt / Lambda / flow change.
- **Do not confuse synthetic and real calls.** Harness calls are
  `WEBRTC_API` and carry contact attributes from `scripts/call-test.py`; the
  default listing hides them.
