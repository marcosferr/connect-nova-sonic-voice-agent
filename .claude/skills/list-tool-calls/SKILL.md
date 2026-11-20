---
name: list-tool-calls
description: This skill should be used when the user asks to "list the tool calls", "which tools did the agent call", "did the bot call create_order / validate_customer / get_menu", "are the MCP tools firing", "trace the agent's tool use", "check tool calls for a contact/session", "why did the bot escalate", or "why wasn't the order saved" - i.e. to see which MCP tools the Forno Pizza orchestrator AI agent (Q in Connect + AgentCore Gateway) actually invoked on a call, with what arguments, and whether each one succeeded.
---

# List-Tool-Calls - what the orchestrator actually invoked

## Purpose

Answer, for one call or a window of calls: **which tools did the orchestrator AI
agent call, with what arguments, and did each one succeed?** This is the only way
to tell apart the failure modes that all *sound* the same to a caller ("the bot
couldn't take my order"):

1. **Model never called the tool** - no `execute_tool` span. Prompt problem
   (see the [voice-agent-prompting](../voice-agent-prompting/SKILL.md) skill).
2. **Model called it, execution failed** - `execute_tool` span with
   `status=ERROR` and a `statusDescription` (e.g. `Target entity not found`).
   Binding / auth / config problem: the call died inside Connect or the gateway,
   often before any Lambda ran.
3. **Model called it, the tool ran and returned a business error** -
   `status=OK` but the JSON result is `{"status": "error", "code": ...}`,
   e.g. `create_order` -> `PIZZA_NOT_ON_MENU` or `INVALID_QUANTITY`.
   Data / argument problem; the result's `suggestedAction` tells the agent what to
   do next, so check the transcript to see whether it followed it.

Gateway and Lambda logs alone **cannot** distinguish #1 from #2 (both show zero
`tools/call`). The Q in Connect **ListSpans** API can, because it records the
model's `toolUse` *and* the execution result. This skill is built on it.

Read-only. IDs are resolved at runtime from the
`$PROJECT_NAME-$ENV_NAME-conversational-ai` stack outputs via
[scripts/stack_env.py](../../../scripts/stack_env.py) - set `AWS_PROFILE`,
`AWS_REGION` (default `us-east-1`), `PROJECT_NAME` (default `pizza-voice`) and
`ENV_NAME` (default `dev`) if yours differ.

## The one command

```bash
# every voice contact in the last 90 min, plus independent corroboration
python scripts/list-tool-calls.py --since 90 --corroborate

# one Connect contact id (from uat-check / list-recent-contacts.sh)
python scripts/list-tool-calls.py --contact <contactId>

# one Q in Connect session id directly, machine-readable
python scripts/list-tool-calls.py --session <sessionId> --json
```

Illustrative output:

```
* session 1f0c...  (contact 9a2e...)  -- 3 tool call(s): 2 ok / 0 exec-error / 1 business-error
    [OK ] 18:02:11  gateway_<id>__validate-customer___validate_customer  args={"phone": "+56912345678"}
           -> status=found
    [OK ] 18:02:30  gateway_<id>__get-menu___get_menu  args={"activeOnly": true}
           -> status=ok
    [BIZ] 18:03:05  gateway_<id>__create-order___create_order  args={"items": [{"pizzaId": "hawaiian", "quantity": 1}], ...}
           -> status=error code=PIZZA_NOT_ON_MENU
= 1 session(s): 3 tool call(s), 0 exec-failed, 1 business-error, 0 escalated =
-- corroboration (last 90m) --
  CW metric AWS/Bedrock-AgentCore Invocations Method=tools/call = 3
  lambda pizza-voice-validate-customer-dev: 1 invocation(s)
  lambda pizza-voice-get-menu-dev: 1 invocation(s)
  lambda pizza-voice-create-order-dev: 1 invocation(s)
```

Read it as: the prompt and the MCP binding are fine (all three tools reached
their Lambdas); the model sent a `pizzaId` that is not on the fixed menu. Check
the transcript: did the agent offer a real alternative from the returned
`catalog`, or did it hallucinate an item from memory instead of using
`get_menu`?

## How it works (so you can do it by hand)

[scripts/list-tool-calls.py](../../../scripts/list-tool-calls.py):

1. **Find the session(s).** The Connect `contactId` is **not** the Q in Connect
   `sessionId`. `connect describe-contact` returns
   `Contact.WisdomInfo.SessionArn` (`...:session/<assistantId>/<sessionId>`);
   the tail is the session id. For `--since` the script first runs
   `connect search-contacts` over the window.
2. **Pull the trace.** `qconnect list-spans --assistant-id <A> --session-id <S>`
   returns spans: `inference`, `invoke_agent`, `execute_tool`,
   `escalate_agent`, `barge_in`. `execute_tool` spans carry, in `attributes`,
   `inputMessages[].values[].toolUse {name, arguments}` and
   `outputMessages[].values[].toolResult`; `status` + `statusDescription` give
   the execution result.
3. **Corroborate (`--corroborate`).** Independent counters for the window: the
   `AWS/Bedrock-AgentCore` `Invocations` metric with `Method=tools/call`, and
   `REPORT` lines in `/aws/lambda/<project>-<tool-slug>-<env>` for
   `validate-customer`, `get-menu`, `create-order`. If you enabled gateway
   log delivery, pass `--gateway-log-group <name>` to also count
   `tools/call` vs `tools/list` lines.

### Four ways to detect "was a tool used", strongest first

| Signal | Tells you | Limit |
|---|---|---|
| **ListSpans** `execute_tool` | model's `toolUse` + per-call OK/ERROR + reason + result | session expires - run soon after the call |
| Gateway log `tools/call` | a call that *reached* the gateway | needs gateway logging; silent on calls that fail before it |
| CW metric `AWS/Bedrock-AgentCore Invocations Method=tools/call` | gateway-side call count | aggregate only |
| Tool Lambda `REPORT` lines / `Invocations` metric | the backend actually ran | no model context |

## Interpreting tool names and results

- Span tool names look like `gateway_<gatewayId>__<target>___<tool>`; the
  security-profile permission and the gateway's own id are `<target>___<tool>`,
  e.g. `create-order___create_order`. The script prints the full name; compare
  on the part after `___`.
- `Target entity not found` -> the tool id configured on the AI agent does not
  match a tool exposed by the registered MCP application. Usual causes: the
  gateway was recreated (new id) but the agent still references the old one, a
  target was renamed, or the gateway lists zero tools because the JWT authorizer
  rejects Connect's token (never add an `AllowedAudience` that Connect does not
  mint). Redeploy the ConversationalAI stack so the agent, security profile and
  MCP application are regenerated together.
- `create_order` results: `created` (new row), `duplicate` (same `contactId`
  + lines already saved - idempotency working as designed, not an error),
  `error` with `code` + `suggestedAction`.
- No `execute_tool` spans at all -> the model never called a tool. Look at the
  prompt's tool rules in `prompts/orchestrator-prompt.yaml`.

## Gotchas

- **Run soon after the call.** Q in Connect sessions expire; `list-spans` then
  returns `ResourceNotFoundException` (printed as `EXPIRED / no trace`).
  ListSpans needs no pre-enabled logging.
- Synthetic test calls (`scripts/call-test.py`) start with
  `InitiationMethod=WEBRTC_API`; they are included here (unlike
  `list-recent-contacts.sh`, which shows only `INBOUND` by default).
- **Windows git-bash:** if you run raw `aws logs ...` yourself,
  `export MSYS_NO_PATHCONV=1` first or `/aws/...` gets rewritten to a Windows
  path. The Python script is unaffected.

Related: [uat-check](../uat-check/SKILL.md) (was the order saved?) and
[uat-auto](../uat-auto/SKILL.md) (synthetic calls that assert on these spans).
