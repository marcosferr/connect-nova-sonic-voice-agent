# Migrating a text agent to Nova 2 Sonic - voice-agent patterns

**Source:** [Migrating a text agent to a voice assistant with Amazon Nova 2 Sonic](https://aws.amazon.com/blogs/machine-learning/migrating-a-text-agent-to-a-voice-assistant-with-amazon-nova-2-sonic/) - AWS Machine Learning Blog.

What changes (and what stays the same) when a text chatbot becomes a Nova 2 Sonic speech-to-speech agent. This project already runs Nova 2 Sonic through Amazon Connect + Lex, so the notes below explain *why* the prompt and tools look the way they do.

---

## What stays the same

> *"No code changes needed for tool definitions — business logic layer reuses existing tools with prompt/configuration tuning only."*

The three MCP tools (`validate_customer`, `get_menu`, `create_order`) are plain Lambdas behind an AgentCore Gateway; they would work unchanged for a chat channel. Voice-specific behaviour lives in the prompt and the transport.

---

## What changes - orchestrator architecture

**Text:** stateless request/response. **Voice:** bidirectional streaming.

> *"Amazon Nova 2 Sonic can accept both text and audio inputs in the same model interface,"*

The classic ASR -> LLM -> TTS pipeline collapses into one speech model. On Amazon Connect this is configured on the Lex bot locale (`UnifiedSpeechSettings` / speech model) and the contact flow, not in application code. The Q in Connect orchestration prompt still drives the reasoning and tool calls.

---

## What changes - client architecture

> *"Users interrupt (barge-in), pause mid-sentence, and expect the agent to handle overlapping speech naturally."*

A self-hosted Nova Sonic client needs WebSocket/WebRTC transport, audio encoding and noise handling, VAD/turn detection and barge-in (stop playback when the user speaks). On Amazon Connect, telephony, VAD and barge-in are handled by Connect + Lex; the prompt does not need "stop talking if interrupted" rules.

---

## What changes - prompts

| Text-agent prompt | Voice-agent prompt |
|---|---|
| Verbose explanations | *"Use short, clear responses."* |
| Information dump | *"Acknowledge when retrieving data."* |
| Detailed lists | Smaller sequential steps |
| Single-shot Q&A | Confirmation loops (bot says "¿Sigo?") |
| Formal documentation style | Conversational, warm, patient |

Two operational rules the blog stresses:

1. **Filler messages during tool execution are not optional in voice.**
2. **Independent tool calls should run in parallel** - *"each sequential call adds noticeable silence in voice context"*.

---

## Tool calls - async and lean

> *"Amazon Nova 2 Sonic supports asynchronous tool calling, so the conversation continues naturally while tools run in the background."*

- Parallelize independent calls; chain only when an input depends on a previous result (here `create_order` needs `customerId` from `validate_customer`, but `get_menu` does not).
- **Return lean, speakable payloads.** The model reads the result to decide what to say; large raw JSON slows it down and invites it to recite fields. `get_menu` returning name + price + short description per active pizza is about the right size.
- **Return decisions, not just data, on errors.** A `code` plus a `suggestedAction` ("offer a pizza from the catalog") lets the voice model recover in one turn instead of improvising.

---

## Sub-agent optimization

- Use smaller, faster models for sub-agents (Nova 2 Lite / Micro).
- Keep sub-agent answers to 1-2 sentences.
- Avoid visible "thinking" modes on any path the caller is waiting on.

---

## Latency budget

> *"Silence in a voice conversation feels like the line went dead."*

The blog gives no thresholds. Rules of thumb from field testing of phone agents:

- **< ~800 ms** from end of caller speech to start of agent speech feels natural.
- **~0.8-2 s** is acceptable if the agent has already said a filler.
- **> ~2 s** of silence makes callers say "¿Aló? ¿Está ahí?" and talk over the agent.

The fix is **always a filler first**, then optimize the tool. A 1.5 s lookup behind "Déjame revisar, un momento" beats a 1 s lookup in silence.

---

## Persona / voice configuration

Self-hosted Nova Sonic sets the voice in code:

```python
provider_config = {"audio": {"voice": "lupe", "input_sample_rate": 16000, "output_sample_rate": 16000}}
```

On Amazon Connect the voice is set in the contact flow (`UpdateContactTextToSpeechVoice`, here `Lupe`) and must be valid for the bot locale.

---

## Migration checklist (text agent -> voice on Connect)

1. Confirm the speech-to-speech model is available for your Lex locale in your region.
2. Pick a Nova Sonic voice valid for that locale and set it in the flow.
3. Audit the prompt: one question per turn, read-back before irreversible actions, filler before tools, no visual formatting, `<message>` output contract.
4. Make tool results lean and give errors a suggested action.
5. Test with synthetic calls *and* real human calls (synthetic audio is too clean to exercise ASR).
