---
name: voice-agent-prompting
description: This skill should be used when the user asks to "improve the voice prompt", "audit the prompt against Nova best practices", "make the agent sound more natural", "add a rule to the orchestration prompt", "edit orchestration-sonic-es-v1.yaml", "Nova Sonic prompt", "convert a text agent to voice", "phone agent prompt", or any time the Forno Pizza Q in Connect orchestration prompt (Nova 2 Sonic speech-to-speech, Chilean Spanish, MCP tools validar_cliente / consultar_menu / crear_pedido) is being designed, audited, edited or deployed.
---

# Voice-Agent-Prompting - Nova Sonic / Q in Connect orchestration prompts

## Purpose

Rules and shipping protocol for the voice agent's system prompt. The live
target is [prompts/orchestration-sonic-es-v1.yaml](../../../prompts/orchestration-sonic-es-v1.yaml):
a Q in Connect **ORCHESTRATION** AI prompt (`apiFormat=MESSAGES`, model from
`BEDROCK_PROMPT_MODEL`, default Nova Pro) deployed by CDK
(`lib/constructs/chatbot/qconnect-ai-prompt.ts`) and attached to the
orchestrator AI agent. Speech in and out is Nova 2 Sonic (Lex
`UnifiedSpeechSettings`, locale `es_US`, voice `Lupe`); the agent speaks Chilean
Spanish and calls three MCP tools through the AgentCore Gateway.

A good voice prompt is not the same artifact as a good text prompt. This skill
captures **what to change**, **what never to do**, and **how to ship it safely**.

## Sources

Distilled from public AWS material plus field experience. Load the reference
that matches the question:

1. [references/nova-speech-best-practices.md](references/nova-speech-best-practices.md) - Nova Sonic system-prompt best practices (AWS docs). The richest source.
2. [references/voice-vs-text-migration.md](references/voice-vs-text-migration.md) - migrating a text agent to Nova 2 Sonic (AWS ML blog): tool calls, latency, persona.
3. [references/multi-agent-and-segmentation.md](references/multi-agent-and-segmentation.md) - tools vs sub-agents vs session segmentation (AWS ML blog).
4. [references/operational-gotchas.md](references/operational-gotchas.md) - things that break when you ship: YAML shape, `<message>` wrapping, MCP binding, observability.
5. [references/nova-sonic-agentic-chatbot.md](references/nova-sonic-agentic-chatbot.md) - aws-samples Nova Sonic agentic chatbot: tool architecture, lean results.

## When this skill applies

- Any edit to `prompts/orchestration-sonic-es-v1.yaml` (new rule, regression fix, tone).
- Any change to a tool's contract that the prompt describes (arguments, `status`
  values, `code` / `accionSugerida`) - prompt and Lambda must change together.
- Reviewing a proposed prompt change before deploy.

Not for: Lambda business logic (`src/lambdas/*`), menu content
(`pizza-voice-menu-dev` / `docs/seed/menu.json`), contact-flow routing.

## Workflow

### Step 1. Tie the change to a specific rule

Every edit should map to a rule in
[references/nova-speech-best-practices.md](references/nova-speech-best-practices.md)
or to a reproducible failure (a contact id from
[uat-check](../uat-check/SKILL.md) or a failing case from
[uat-auto](../uat-auto/SKILL.md)). If you cannot name either, the change is not
ready.

| Rule | What it justifies |
|---|---|
| Clarity & precision (one piece at a time) | Splitting "¿qué pizza y cuántas?" into two turns |
| Critical-data verification | Read-back of pizzas, quantities and total before `crear_pedido` |
| Conversational markers | "Perfecto", "Ya", "Un momento" openers |
| Verbal emphasis | "Lo importante es..." instead of bold |
| Signposting + numbering | "Primero... después... y por último... entonces, en resumen" recap |
| Avoid visual formatting | No bullets, asterisks, `1)` lists inside `<message>` |
| External tool integration | A spoken filler in `<message>` before every tool call |
| Speech persona | "cálido, breve, paciente" - not "detallado, exhaustivo" |

### Step 2. Edit additively

Each section of a mature voice prompt usually exists because of a real failure.
**Do not delete rules during a refactor** unless a clean test run proves the
underlying bug is gone.

- Broaden rather than replace (e.g. "confirma cantidades" -> "confirma pizzas,
  cantidades y total, y espera un sí explícito").
- Add new behaviour as a named block (`CUANDO UNA HERRAMIENTA FALLA`, `FUERA DE MENÚ`).
- Anchor hard rules with 1-2 short example exchanges; prose-only rules drift.
- Keep the tool contract in sync with the Lambda: the prompt says "el total que
  dices es SIEMPRE el `total` que devuelve crear_pedido" because the server
  computes it; if the Lambda changes, the prompt changes in the same commit.

### Step 3. Keep the YAML shape valid

The construct enforces it at synth time, and Q in Connect enforces it at deploy:

- Top-level `system: |` **block scalar** (so colons, quotes and `{{...}}` inside
  the text are safe), then `messages:` holding only `- "{{$.conversationHistory}}"`.
- Do not convert `system:` to a plain or quoted scalar: a literal `: ` inside
  it is parsed as a new mapping key and the deploy fails with
  `Prompt is not in expected YAML format`.
- Keep the variables the flow provides: `{{$.Custom.customer_phone}}` (set by
  the session-data Lambda) and `{{$.contactId}}` (idempotency key for
  `crear_pedido`).
- Keep the `<message>...</message>` output contract. Anything outside it is not
  spoken; a turn with no `<message>` is silence on the phone.

Validate locally before deploying:

```bash
python -c "import yaml,sys; d=yaml.safe_load(open('prompts/orchestration-sonic-es-v1.yaml')); assert set(d)=={'system','messages'}; print('ok', len(d['system']), 'chars')"
npm run build && npm test
```

### Step 4. Deploy through CDK

The prompt is infrastructure. There is no hand-run `update-ai-prompt` step and
no snapshot directory: git is the history.

```bash
npm run diff      # expect changes on the AIPrompt + a new AIPromptVersion only
npm run deploy
```

If the diff would recreate the AI agent, gateway or security profile for
a prompt-only change, stop and find out why before deploying.

### Step 5. Verify with calls

Run the synthetic suite ([uat-auto](../uat-auto/SKILL.md)) and a few human
calls, then review with [uat-check](../uat-check/SKILL.md) and
[list-tool-calls](../list-tool-calls/SKILL.md). Listen / look for:

- **Read-back before save**: pizzas, quantities and total read back, explicit
  "sí" received, *then* `crear_pedido` - never the other way round.
- **Spoken total = row total**: the agent says the `total` from the tool result.
- **No silent gaps**: every tool call is preceded by a short spoken filler.
- **No formatting leaks**: no bullets, asterisks, digits-as-list-markers,
  `<thinking>` content or tag names spoken aloud.
- **Off-menu handling**: half-and-half, extra toppings, other sizes are politely
  redirected to the closest menu item.
- **Tool errors**: on `status=error` the agent follows `accionSugerida` and
  re-asks in one simple sentence; on `duplicate` it confirms, never re-orders.
- **Caller ID**: the agent does not ask for the phone number when
  `customer_phone` is present.

### Step 6. Rollback

`git revert` the prompt commit and `npm run deploy`. Each deploy creates a new
immutable `AIPromptVersion`, so the previous text is also recoverable from
`aws qconnect list-ai-prompt-versions` if needed.

## Key Nova rules (cheat sheet)

| # | Rule | One-line essence |
|---|---|---|
| 1 | Clarity & precision | One question at a time; confirm before acting. |
| 2 | Conversational flow | Dialogue rhythm over document structure. |
| 3 | Memory constraints | Listeners can't scroll back - summarize at the end. |
| 4 | Turn-taking | One question per turn. |
| 5 | Conversational markers | Register-appropriate openers ("Perfecto", "Ya", "Un momento"). |
| 6 | Emotional expression | Light, register-gated ("¡Qué rico!" ok for a pizzeria; no sarcasm). |
| 7 | Thoughtful pauses | Ellipses for short pauses; sparingly. |
| 8 | Verbal emphasis | "Lo importante es..." instead of bold. |
| 9 | Verbal organization | "Primero / después / por último"; "en resumen" close. |
| 10 | Signposting | "Te voy a pedir dos datos rápidos." |
| 11 | Critical-data verification | Read back items, quantities, total; wait for an explicit yes. |
| 12 | External tool integration | Spoken acknowledgement before every tool call; assume ASR errors in tool inputs. |
| 13 | Speech persona | Warm, patient, concise. |
| 14 | Avoid visual formatting | No bullets, tables, markdown, stage directions. |

## Anti-patterns

- **Hard-coding the menu or prices in the prompt.** The menu lives in DynamoDB;
  the agent must call `consultar_menu`. Inlined lists go stale and the server
  will reject items that are no longer active.
- **Letting the model compute totals.** The server computes `total`; the prompt
  must say to read it from the tool result.
- **`<placeholder>` syntax in prose.** Speech models may read angle brackets
  and the word inside aloud. Use concrete examples ("dos Napolitanas").
- **A rule with no example.** Prose-only rules drift under real traffic.
- **Digits as list markers.** Say "primero, segundo", never "uno)". Digits
  collide with quantities and prices.
- **Long openers.** Keep turns to one or two short sentences; offer 2-3 options
  and ask, never recite the whole menu.
- **Silent tool calls.** Any call that may take > 1 s needs a filler first.
- **Asking for data the system already has** (caller ID, contactId).
