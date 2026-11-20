---
name: uat-auto
description: This skill should be used when the user asks to "run the automated test calls", "run the call-test suite", "smoke-test the bot after deploy", "synthetic calls", "regression-test the voice agent", "run the WebRTC caller", or wants the Forno Pizza voice agent exercised end to end with synthetic callers (scripts/call-test.py + tools/webrtc-caller) and verified against DynamoDB pedidos and MCP tool spans. Places real WebRTC contacts on the live flow; happy-path cases create REAL pedido rows.
---

# Run + verify the synthetic test-call suite

## How it works

The harness places **real voice contacts** on the deployed contact flow, so it
tests the whole stack (flow -> session-data Lambda -> Lex + Nova 2 Sonic ->
orchestrator AI agent -> AgentCore Gateway -> tool Lambdas -> DynamoDB):

- **Transport**: `scripts/call-test.py` calls `connect:StartWebRTCContact` on the
  pedidos contact flow, then drives a headless browser client
  (`tools/webrtc-caller/`, Node + Puppeteer + Amazon Chime SDK) that joins the
  contact's media session.
- **Caller voice**: pre-synthesized Spanish Polly clips in
  `tests/calls/audio/` (regenerate with `scripts/synthesize-audio.py` after
  editing a case's utterances). Polly audio is clean, so it tests the dialogue
  logic, not ASR robustness against real phone noise.
- **Turn-taking brain**: the runner polls the live Q in Connect transcript
  (`qconnect list-messages`) and, when the bot finishes a turn, plays the clip
  whose matcher fits the bot's last utterance.
- **Verdict**: assertions live in the runner's `verify` stage, never in the
  dialogue: the DynamoDB pedido row for that `contactId` (items, total,
  `posStatus`), and the tool spans (`qconnect list-spans`, settle-polled for
  ~2 min, compared on the tool name after `___`, e.g. `crear_pedido`).

Cases are JSON files in `tests/calls/cases/*.json` (one per scenario: happy
path, off-menu request, quantity change before confirmation, caller declines,
asks for a human, silence). Read an existing case before writing a new one.

## Workflow

1. **One-time setup**: `cd tools/webrtc-caller && npm ci && npm run build`.
   Python needs only `boto3`.
2. **Audio** (only if utterances changed): `python scripts/synthesize-audio.py`.
3. **Run**:
   ```bash
   python scripts/call-test.py --list        # available cases
   python scripts/call-test.py               # every case
   python scripts/call-test.py happy-path    # one case, by file stem
   ```
   Artifacts (per-case call log with every bot turn and the clip played,
   transcript, verdict) land in `tests/calls/runs/<YYYYmmdd-HHMMSS>/`.
   Each case's `verify` block can assert `orders` (exact row count for the
   contact), `total`, `items` (`pizzaId -> cantidad`), `tools_called` and
   `max_tool_errors`.
4. **Interpret**: the `verify` failures are the verdict; "the conversation
   flowed" only proves the transport works.
5. **Drill failures**:
   - the per-case call log shows which bot turn got which reply;
   - `python scripts/list-tool-calls.py --contact <contactId>` for the tool view;
   - `scripts/pull-session-transcript.sh <contactId>` for the full transcript;
   - [uat-check](../uat-check/SKILL.md) for the DynamoDB side.

## Writing good cases

- **Put confirmation matchers before slot matchers.** The read-back
  ("¿Te confirmo...?", "¿Está correcto?") often repeats slot keywords such as
  pizza names or quantities; if a slot matcher is checked first the runner
  answers the read-back with an item instead of "sí", and the call loops.
- **Assert on data, not phrasing.** LLM wording drifts call to call. Assert
  that a row exists with the expected `items` and `total`, that
  `crear_pedido` was called exactly once (or not at all for decline cases), and
  that `validar_cliente` received the caller-ID phone in E.164.
- **Use the menu ids in `docs/seed/menu.json`** for expected items; the server
  computes `total` from menu prices, so expected totals must come from there.
- **Keep a silence / no-input case** - it exercises the flow's timeout and
  escalation branches, which normal cases never reach.
- **One behavior per case.** A failing case should point at one rule in the
  prompt.

## Anti-patterns

- Running many cases in parallel. Each one is a real Nova Sonic session and a
  real concurrent contact; keep concurrency low (1-2) to avoid throttling and
  instance concurrency limits.
- Mocking the Lex bot or tool Lambdas. The point is to test the live brain.
- Leaving test rows unmarked. Harness contacts are `InitiationMethod=WEBRTC_API`
  and carry contact attributes `test_call=true` and `test_case=<name>`; use
  those (or the run's contact ids) to find and clean up rows created by
  happy-path cases.
  `scripts/list-recent-contacts.sh` hides them unless `--all` is passed.
- Treating a green run as ASR coverage. Synthetic Polly audio never mumbles;
  keep a few human test calls in every release check.
- Using a real person's phone number as the WebRTC caller ID. Use a
  placeholder such as `+56 9 1234 5678`.
