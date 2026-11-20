# Multi-agent design and session segmentation

**Source:** [Scalable voice agent design with Amazon Nova Sonic — multi-agent, tools, and session segmentation](https://aws.amazon.com/blogs/machine-learning/scalable-voice-agent-design-with-amazon-nova-sonic-multi-agent-tools-and-session-segmentation/) - AWS Machine Learning Blog.

**Status for this project:** single agent, single session. Documented so the patterns are at hand if the line grows beyond order taking.

---

## The three routing patterns

They differ in **what reasons**, **what context loads**, and **how much latency each adds**.

### Pattern 1 - Tool (e.g. via AgentCore Gateway)

> *"Nova Sonic selects which tool to invoke, passes parameters, gets a result, and speaks it back. There's no intermediate reasoning layer."*

- Lowest latency; all tools loaded at session start; the voice model does all the reasoning.
- **This project's pattern**: three MCP tools behind one gateway.

### Pattern 2 - Sub-agent

> *"Each sub-agent call adds latency: the sub-agent's own model inference plus its tool calls. In a voice conversation, this means longer silence."*

- In-process (agent-as-tool) or remote via Agent-to-Agent (A2A).
- Own model, prompt and tools; the voice orchestrator still decides when to call it.
- Use when a subtask needs reasoning the voice model shouldn't carry inline (a constraint solver, a multi-step lookup plan, a domain rules engine).

### Pattern 3 - Session segmentation

Close one session and open another with a different prompt and tool set on the same connection:

> *"Purpose-built for voice scenarios where latency is the overriding concern."*

- Each phase gets *"a focused system prompt"* and *"only the relevant tools."*
- The model no longer spends *"reasoning cycles choosing between 15 tools when it only needs 3."*

---

## Trade-offs

| Factor | Tool | Sub-agent | Session segmentation |
|---|---|---|---|
| Latency | Low | Higher | Lowest with phase hand-offs |
| Tool set per turn | All loaded | Sub-agent's tools | Phase-relevant only |
| Reasoning model | Voice | Voice + sub-agent | Voice (per phase) |

---

## When one agent stops being enough

The article gives no hard line. Split when:

- a clear **phase boundary** exists where the tool set changes (identify -> act -> wrap up);
- a subtask needs **reasoning** the voice model shouldn't do while the caller waits;
- the system prompt is documenting **disjoint behaviours** (ordering *and* order status *and* complaints *and* store hours...).

## Applied to this project

Today one prompt works because there is one task (take an order from a fixed menu), a small tool set (3 tools) and no authentication phase (caller ID identifies the customer).

Triggers that would justify splitting:

1. **Order status / cancellation on the same number** -> greeting + intent classification, then segment into an ordering session or a status session with its own tools.
2. **Customizable pizzas** (half-and-half, toppings, sizes) -> the combinatorics may justify a sub-agent or a dedicated "build your pizza" phase with its own validation tool.
3. **Delivery address capture and coverage checks** -> a separate phase with an address-validation tool, so the ordering prompt stays short.

---

## Sub-agent model selection

> *"Start with Amazon Nova 2 Lite or Nova 2 Micro. They're fast, cost optimized, and handle most specialized tasks well."*

The article cites no latency or cost numbers; measure.

---

## Operational notes

- Each segmented session is a fresh model context. **Carry forward the slots** the previous phase captured (customer id, items so far) in the next phase's prompt or session data; nothing is inherited automatically.
- A2A sub-agents must be deployed and discoverable; that is new infrastructure, not just a prompt change.
- Any of these changes goes through the same edit -> CDK deploy -> test-call loop described in [../SKILL.md](../SKILL.md).
