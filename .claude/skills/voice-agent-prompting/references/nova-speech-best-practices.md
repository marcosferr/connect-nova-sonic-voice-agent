# Nova Sonic - system-prompt best practices

**Source:** [Best practices for the Amazon Nova Sonic system prompt](https://docs.aws.amazon.com/nova/latest/userguide/prompting-speech-best-practices.html) and its subpages (`prompting-speech-bp-speech`, `prompting-speech-bp-sysrole`, `prompting-speech-bp-tools`, `prompting-speech-bp-avoid`, `prompting-speech-bp-reasoning`, `prompting-speech-voice-language`).

**Note:** that page covers Nova Sonic v1. Nova 2 Speech-to-Speech has its own guide at `https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-system-prompts.html`. The rules transfer almost verbatim; only the tool-call schema differs.

Every rule in [../SKILL.md](../SKILL.md) maps to one of these. The "For this project" notes apply them to the Forno Pizza order-taking agent.

---

## Why speech prompts differ from text prompts

> "While many [prompting best practices for Amazon Nova understanding models](https://docs.aws.amazon.com/nova/latest/userguide/prompting.html) apply to Amazon Nova Sonic, they must be adapted for the unique dynamics of spoken conversation. For instance, a user's typed response is a reliable source of input. However, a corresponding speech interaction may be limited in context and require a back-and-forth interaction to ask for more information before moving the conversation forward. Additionally, prompts that cater to long form outputs might result in a bad experience for users due to time spent listening to find the correct answer."

Three first-order consequences:
1. **Inputs are unreliable** (ASR errors, mid-sentence pauses, partial utterances) - design for verification, not extraction.
2. **Outputs are time-constrained** - every second of speech is a second the caller waits.
3. **Listeners can't scroll back** - recap verbally what a text agent would let the user re-read.

---

## Rule 1 - Clarity and precision

Ask for one piece of information at a time; confirm before any tool call.

| | |
|---|---|
| Traditional prompt | `Verify the user's identity by requesting their username, email address, and reservation number. Validate that the reservation number follows the format XXX-YYYYY.` |
| Speech-optimized | `When asking for verification, request one piece of information at a time. First ask for their name, then wait for their response and confirm it. Next, ask for their email and repeat it back for verification. Finally, ask for their booking code, listening for the three parts separated by dashes (XXX-YYYYY). After collecting the booking code, read it back character by character to confirm accuracy before proceeding.` |

> *"After collecting the booking code, read it back character by character to confirm accuracy before proceeding."*

**For this project:** ask "¿Qué pizza te gustaría?" and, separately, "¿Cuántas?". If the caller ID is missing and the agent must ask for a phone number, read it back digit by digit ("nueve, uno, dos, tres...") before calling `validar_cliente`.

---

## Rule 2 - Conversational flow over instructional structure

| | |
|---|---|
| Traditional | `Provide step-by-step instructions for troubleshooting Wi-Fi connectivity issues. Include diagnostic steps, common error codes, and resolutions for each potential problem.` |
| Speech-optimized | `Guide the customer through Wi-Fi troubleshooting as a conversation. Start by asking what they've already tried, then suggest one simple step at a time. After each step, pause to check if it is clear before moving on to the next solution. Use everyday language instead of technical terms.` |

---

## Rule 3 - Memory constraints (no scroll-back)

| | |
|---|---|
| Traditional | `Reference sections 1.3, 2.7, and 4.2 from the attached document when answering the user's questions about regulatory compliance. Include specific paragraph numbers in your citations.` |
| Speech-optimized | `When explaining our return policy, focus on one key point at a time. First cover the 30-day window, then shipping requirements, and finally condition standards. Summarize all three points together at the end to reinforce the main requirements without overwhelming the customer.` |

**For this project:** the read-back is the summary: "Entonces, en resumen: dos Napolitanas y una Pepperoni. ¿Está correcto?" Offer two or three menu options at a time, never the whole menu.

---

## Rule 4 - Conversation turn-taking

> *"You and the user will engage in a spoken dialog exchanging the transcripts of a natural real-time conversation. As the agent, you'll be part of a spoken conversation with the user, following a sequence of user, agent, user, agent turns."*

Never bundle questions ("¿Qué pizza quieres y para qué dirección?"). The model will say both; the caller answers one and the other is lost.

---

## Rule 5 - Conversational markers

> *"Include natural speech elements like 'Well,' 'You know,' 'Actually,' 'I mean,' or 'By the way' at appropriate moments to create an authentic, casual conversation flow."*

**Register matters.** A pizzeria line can be warm and informal, but keep markers short and natural for the locale: `Perfecto`, `Ya`, `Dale`, `Claro`, `Un momento`, `Déjame revisar`. Avoid long fillers that delay the actual question.

---

## Rule 6 - Emotional expression

> *"Express emotions verbally through phrases like 'Haha,' 'Wow,' 'Hmm,' 'Oh!' or 'That's amazing!' when appropriate to the conversation context."*

Gate by register. A short "¡Buena elección!" fits ordering food; laughter, sarcasm or exaggerated enthusiasm do not.

---

## Rule 7 - Thoughtful pauses

> *"Incorporate natural speech pauses using ellipses (...) when you're thinking or transitioning between topics."*

Use sparingly; overuse sounds hesitant.

---

## Rule 8 - Verbal emphasis

> *"Instead of using bold or italics, emphasize important information by using phrases like 'The key thing to remember is,' 'What's really important here is,' or 'I want to highlight that.' This ensures crucial points stand out in spoken form."*

**For this project:** "Lo importante es que el total queda en...", "Solo para confirmar...".

---

## Rule 9 - Verbal organization (numbering & transitions)

> *"When sharing multiple points, use phrases like 'first,' 'second,' and 'finally' to help the listener track the information. End complex explanations with 'So in summary…' to reinforce key takeaways."*

Hard rule: never `1)`, `2)` aloud - always "primero", "después", "por último". Spoken digits used as list markers collide with quantities and prices ("dos" the marker vs "dos" pizzas).

---

## Rule 10 - Signposting

> *"Before sharing multiple ideas, give a preview like 'I'm thinking of three reasons why...' and after completing a topic, use phrases like 'That covers what I wanted to share about...' to signal topic transitions."*

**For this project:** "Hoy tenemos tres pizzas en promoción..." before listing; "Te leo el pedido completo" before the read-back.

---

## Rule 11 - Identity / critical-data verification

Rules 1 + 3 applied to anything irreversible. Before `crear_pedido`, the agent must read back:

- each pizza by its menu name,
- each quantity (watch confusable numbers such as "dos" / "doce", "seis" / "dieciséis"),
- the total, if already known from the menu,

and wait for an explicit yes ("sí", "correcto", "ya", "dale", "eso"). If the caller corrects something, re-read the corrected order the same way.

---

## Rule 12 - External tool integration

> *"Design tool invocations to handle potential automatic speech recognition errors in user input."*
> *"Account for the fact that users can't see the tools being used."*
> *"Provide verbal confirmation when tools are being consulted."*

Operative consequences:

1. **Every tool call is preceded by a spoken filler** in `<message>` ("Déjame revisar el menú, un momento"). No filler = silence on the phone.
2. **Echo what was heard** when the tool input comes from the caller ("Reviso la Napolitana..."); the caller can correct a mishear before the result arrives.
3. **Let the server validate.** Tool inputs carry ASR errors; the tool Lambdas validate against the catalog and return `code` + `accionSugerida` that the prompt tells the agent to follow.

---

## Rule 13 - System role adaptation (speech persona)

> *"Define roles that sound natural when speaking (such as, 'friendly advisor' rather than 'information retrieval system'). Use role descriptions that emphasize conversational attributes (warm, patient, concise) rather than text-oriented attributes (detailed, comprehensive, systematic)."*

---

## Rule 14 - Prompt techniques to avoid

> Avoid:
> - *"Visual formatting like bullet points, tables, or code blocks."*
> - *"Voice characteristic modifications like accent, age, or singing."*
> - *"Sound effects or extensive onomatopoeia."*
> - *"Content that relies on being seen rather than being heard."*

Inside `<message>`: no bullets, no `*` or `-` lists, no numbered lists, no tables, no markdown, no stage directions (`*suspira*`). Accent and voice belong to the voice selection (`Lupe`, locale `es_US`), not to the prompt.

---

## Rule 15 - Voice & language selection

From `prompting-speech-voice-language`. Nova Sonic voices are per language (e.g. English `tiffany`, `matthew`, `amy`, `olivia`; Spanish `lupe`, `carlos`). On Amazon Connect the voice is chosen in the contact flow / bot speech settings, not in the prompt. Speech-to-speech availability depends on locale: this project uses `es_US` because S2S is not offered on every Spanish locale.

---

## Rule 16 - Chain-of-thought for speech

From `prompting-speech-bp-reasoning`:

- Do **not** ask the model to "think step by step out loud" - the caller hears the reasoning and the answer is delayed.
- For an orchestration prompt with a `<message>` contract, reasoning goes in `<thinking>` (never spoken) and must never leak into `<message>`.
- A short "Mmm, déjame ver..." buys a second while a tool runs; a chain of spoken intermediate steps does not.
