# Operational gotchas - Connect + Lex + Q in Connect + Nova Sonic + AgentCore

**Sources:**
- [Building phone-call agents on AWS](https://buildwithaws.substack.com/p/building-phone-call-agents-on-aws) - buildwithaws.substack.com.
- Field experience building Connect voice agents with Q in Connect orchestration and MCP tools.

Read before deploying a prompt, flow or tool change.

---

## Gotcha 1 - The prompt must be YAML in a specific shape

**Symptom:** deploy fails with `Prompt is not in expected YAML format`.

**Cause:** Q in Connect parses MESSAGES-format prompts as YAML. Two common ways to break it:

- `system:` written as a plain or quoted scalar containing a literal `: ` (colon + space), which the parser reads as a new mapping key. Example of a line that breaks a plain scalar: `... (dicho en voz alta): 'Déjame revisar' ...`.
- Extra top-level keys, or a `messages:` list that holds anything other than `"{{$.conversationHistory}}"`.

**Rule:** keep `system: |` as a block scalar (colons are then safe) and validate with a YAML parser before deploying. The CDK construct checks the shape at synth time; Q in Connect checks it again at deploy.

---

## Gotcha 2 - No `<message>` = silence

For ORCHESTRATION prompts on a voice channel, only text inside `<message>...</message>` is spoken. A turn where the model only calls a tool, or only writes `<thinking>`, produces dead air. The prompt must say: always open with a `<message>`, even when calling a tool.

---

## Gotcha 3 - "Enable AI agent" / Q in Connect wiring in the flow

**Symptom:** the call drops or goes silent right after the greeting; no Q in Connect transcript.

> *"If the call drops after the greeting, double-check that 'Enable AI Agent' is toggled on in the 'Get customer input' block. This was the gotcha that caught me."*

On a flow defined as JSON (as here), the equivalent checks are: a `CreateWisdomSession` block before the bot, and the `x-amz-lex:q-in-connect:ai-agent-arn` session attribute on the Lex block. Review the flow diff whenever these change.

---

## Gotcha 4 - Every flow branch must terminate

> *"An unconnected output prevents the flow from saving."*

Every output of `Get customer input` (intents, error, timeout) must end in a disconnect, a transfer or a loop. With flows-as-code, a missing branch fails at deploy, not at synth.

---

## Gotcha 5 - Speech-to-speech is per locale

Nova 2 Sonic S2S is enabled on the Lex bot locale and is not offered for every locale. The voice in the flow must be valid for that locale. This project uses `es_US` with `Lupe` for Chilean Spanish callers because S2S is not supported on `es_419`. If you change locale or voice, verify S2S support first, then re-test with real calls (accent handling differs).

---

## Gotcha 6 - Model and `apiFormat` must match

ORCHESTRATION prompts use `apiFormat=MESSAGES` with a Bedrock model id (default here `us.amazon.nova-pro-v1:0`, overridable via `BEDROCK_PROMPT_MODEL`). Changing the model family can require a different API format; check the Q in Connect docs before swapping. Use cross-region inference profile ids (`us.` prefix) where required.

---

## Gotcha 7 - Prompt versions are immutable

Each deploy creates a new `AIPromptVersion`; the agent points at a version. Old versions remain listed. Because the prompt is in git and deployed by CDK, git is the source of truth and rollback is `git revert` + deploy. Never hand-edit the prompt in the console: the next `cdk deploy` overwrites it, and the console shows no diff.

---

## Gotcha 8 - MCP tool binding: "Target entity not found"

**Symptom:** `list-tool-calls.py` shows `execute_tool` spans with `status=ERROR` and `Target entity not found`; tool Lambdas show zero invocations.

**Cause:** the tool id on the AI agent (`gateway_<gatewayId>__<target>___<tool>`) does not match what the registered MCP application exposes. Typical triggers: the gateway was replaced (new id) without updating the agent, a target or tool was renamed, or the gateway lists 0 tools because its JWT authorizer rejects Connect's token.

**Rules:**
- Change gateway, targets, agent tool list and security profile together in one CDK deploy.
- The gateway authorizer here validates only the `iss` claim (Connect is the issuer). Adding an `AllowedAudience` that Connect does not mint makes tool discovery return nothing.

---

## Gotcha 9 - Caller data must come from the platform, not the caller

The caller's phone and the `contactId` reach the prompt as session variables (`{{$.Custom.customer_phone}}`, written by the session-data Lambda, and `{{$.contactId}}`). Prompts that ask the caller to dictate data the platform already has add turns, add ASR errors and break idempotency (`crear_pedido` keys on `contactId`).

---

## Gotcha 10 - Observability is limited, use spans

> No detailed observability recommendations are provided in the public material.

What works:
- `qconnect list-messages` - the transcript (`scripts/pull-session-transcript.sh`).
- `qconnect list-spans` - every model inference and tool call with arguments, status and result (`scripts/list-tool-calls.py`). Needs no pre-enabled logging, but sessions expire, so pull it soon after the call.
- Tool Lambda logs (`/aws/lambda/<project>-<tool-slug>-<env>`) and the DynamoDB row - the persisted view.
- Contact flow logs (flow logging is enabled at the start of the flow).

What does not: there is no "show me why the model said that" log beyond spans and `<thinking>` content in inference spans.
