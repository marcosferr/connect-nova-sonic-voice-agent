# Nova Sonic agentic chatbot - tool architecture sample

**Source:** [aws-samples/sample-nova-sonic-agentic-chatbot](https://github.com/aws-samples/sample-nova-sonic-agentic-chatbot) on GitHub.

A reference implementation of tools and session state for a self-hosted Nova Sonic agent. Useful when adding a tool, or if this project ever adds a web/app channel next to the phone line.

**Status for this project:** the orchestrator is the managed Q in Connect AI agent and tools are Lambdas behind an AgentCore Gateway (MCP), so there is no custom runtime. The *design* patterns still apply.

---

## Tool architecture - dual-result pattern

> *"Inherits from `BaseTool` base class, defines its own configuration schema, implements async execution logic."*

Each tool returns two results:

| Field | Consumer | Purpose |
|---|---|---|
| `model_result` | Nova Sonic | Sent back to the model. Must be **lean and speakable**. |
| `ui_result` | Frontend | Rich content for a UI, with a `type` (`card`, `text`, `image`, `video`, `pdf`). |

```python
ui_result = {"type": "card|text|image|video|pdf", "content": {...}}
```

**Why it matters for prompt design:** what the model receives is what it will try to say. Keep it short and decision-focused. On a phone-only channel there is no `ui_result`, so the MCP tool's JSON *is* the `model_result` - keep `get_menu` and `create_order` responses compact.

---

## Tool registration - dynamic registry

The sample auto-discovers tools at startup (`backend/tools/tool_manager.py`); adding a tool means dropping a file, not editing the orchestrator.

**Equivalent here:** adding a tool means a new Lambda under `src/lambdas/<slug>/`, a new gateway target, and a matching entry in the agent's tool list and security profile - all in CDK, deployed together. Update the prompt's tool description in the same change.

---

## Session & state

> *"Frontend initiates connection via Power button. Backend maintains async WebSocket sessions. Audio and tool results flow bidirectionally."*

One stateful session per call; audio, tool calls and tool results interleaved as events; history accumulates in the model context. On Amazon Connect, telephony replaces the WebSocket, and the conversation is retrievable afterwards with `qconnect list-messages` (see `scripts/pull-session-transcript.sh`) and the tool trace with `qconnect list-spans` (see `scripts/list-tool-calls.py`).

---

## Barge-in

> *"Barge-in Support: For natural voice interactions"*

When the user starts speaking the model emits an interruption and the client stops playback. On Connect this is handled by the platform; the prompt needs no rule for it.

---

## Long tool calls - async/await

> *"Architecture uses async/await patterns via FastAPI for non-blocking execution, preventing blocking during extended operations."*

Async transport without a spoken filler is still silence to the caller. If a tool can take > 1 s (e.g. `create_order` forwarding to a store POS), the prompt must have the agent announce it first.

---

## Reusable patterns

| Pattern | Reusable when |
|---|---|
| Dual `model_result` / `ui_result` | A visual channel is added next to voice. |
| Tool registry / one-file-per-tool | Always - here, one Lambda directory + one gateway target per tool. |
| Async tool execution | Orchestrator layer; pair with spoken fillers at the prompt layer. |
| WebSocket client | Building a non-Connect surface (web, mobile, kiosk). |

## What the sample does not show

Production error handling (retries, circuit breakers), authentication, observability, multi-language support. Treat it as a reference for tool plumbing, not a production template.
