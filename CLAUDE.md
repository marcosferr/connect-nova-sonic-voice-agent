# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

AWS CDK (TypeScript, `aws-cdk-lib@2.277.0`) app for an Amazon Connect voice agent that takes
pizza orders by phone in Chilean Spanish (fictional brand "Forno Pizza"). One environment
(`ENV_NAME=dev`), region `us-east-1`. README.md is the user-facing doc; docs/ holds design notes.

## Commands

```bash
npm ci && npm run build          # tsc — run before synth/deploy when types changed
npm test                         # jest: synth + L1 resource assertions (offline)
python -m unittest discover -s tests/unit -v   # tool validation tests (offline)
npx cdk synth --quiet && cfn-lint --regions us-east-1 -- cdk.out/assembly-Dev/*.template.json
npx cdk deploy "Dev/*"
python scripts/seed.py           # menu + stores
python scripts/call-test.py      # synthetic WebRTC call(s) + verification
scripts/teardown.sh              # destroy everything
```

Single jest test: `npx jest -t "Gateway"`. Dev scripts resolve every ID from stack outputs via
`scripts/stack_env.py` (env: `AWS_PROFILE`, `AWS_REGION`, `PROJECT_NAME`, `ENV_NAME`) — never
hard-code account, instance, assistant, flow or agent IDs.

## Architecture

### L1-first doctrine (read before adding any construct)
Everything is L1 (`Cfn*`), including AgentCore (`aws_bedrockagentcore.CfnGateway`/`CfnGatewayTarget`). Exceptions:
- The tool Lambdas (and `session-data`) use L2 `lambda.Function` because `CfnFunction` cannot
  bundle assets. Their roles stay L1 (`iam.CfnRole`), imported read-only via
  `iam.Role.fromRoleArn(..., { mutable: false })`; policies live on the role, never inlined.
- Two API calls with no CloudFormation resource use `custom_resources.AwsCustomResource`:
  security profile ↔ AI agent (`AssociateSecurityProfiles`, `EntityType=AI_AGENT`) and phone
  number ↔ contact flow. Check `aws cloudformation describe-type` before adding another — the
  Connect/Wisdom/Lex/AgentCore schemas move fast.

### Composition
- `bin/app.ts` → one `VoiceAgentStage` (`lib/stages/voice-agent-stage.ts`) with 8 stacks wired by
  `addStackDependency`: Security → Storage → Data → Governance → Compute → ConversationalAI →
  Observability → Analytics. Stacks are thin; resources live in `lib/constructs/<domain>/`.
- Cross-stack values are plain `public readonly` strings passed through the stage props.

### Conversational core (lib/stacks/conversational-ai-stack.ts has the diagram)
- Contact flow `infrastructure/contact-flow/pedidos-flow-v2.json` uses `${Placeholders}` resolved
  by `Fn::Sub`: CreateWisdomSession → UpdateContactData → InvokeLambdaFunction `session-data`
  (caller ID + contactId → `{{$.Custom.*}}`) → ConnectParticipantWithLexBot with
  `x-amz-lex:q-in-connect:ai-agent-arn`.
- Lex locale **`es_US`** with Nova 2 Sonic via `UnifiedSpeechSettings` (voice `Lupe`). S2S is not
  supported on es_419; never set `VoiceSettings` alongside it.
- ORCHESTRATION AI agent (Nova Pro), prompt `prompts/orchestration-sonic-es-v1.yaml` (MESSAGES
  YAML; customer-facing text inside `<message>` tags).
- Tools over MCP via AgentCore Gateway, one Lambda target per tool. Inbound `CUSTOM_JWT`, issuer =
  the Connect instance URL (derived from the deterministic alias); validate **only `iss`** via
  `CustomClaims` — `AllowedAudience=<gateway-id>` makes Connect list 0 tools.
- Gateway registered as `AWS::AppIntegrations::Application` `MCP_SERVER` + `APPLICATION`
  association; agent `ToolId = gateway_<gatewayId>__<target>___<tool>`; security profile grants
  `<target>___<tool>`. The agent must depend on the MCP association.

### Tools (src/lambdas, Python 3.12, no deps)
`validar-cliente`, `consultar-menu`, `crear-pedido`: validate everything server-side and return
`{"status":"error","code","message","accionSugerida"}` on failure. `crear-pedido` computes the
total from DynamoDB prices and is idempotent per `contactId` (uuid5 + conditional put →
`status: duplicate`). Keep that contract when adding tools; add a unit test in `tests/unit/`.

## Configuration
`config/env-config.ts` reads `.env` (copy `.env.example`). Only `AWS_ACCOUNT_ID` is required.
Flags: `ENABLE_CONVERSATIONAL_AI`, `ENABLE_AGENTCORE_GATEWAY`, `ENABLE_AGENT_MCP_TOOLS`,
`ENABLE_PHONE_NUMBER` (off: claimed-number quota), `ENABLE_OBSERVABILITY`, `ENABLE_QUICKSIGHT`,
`RETAIN_DATA` (default false → full cleanup; true → tables/buckets retained + deletion protection).

## Dev tooling
`.claude/skills/`: `uat-auto` (synthetic calls), `uat-check` (audit recent calls),
`list-tool-calls` (what the agent really called, via ListSpans), `uat-excel-creation`,
`voice-agent-prompting` (Nova Sonic prompt engineering). Scripts in `scripts/`:
`list-tool-calls.py`, `list-recent-contacts.sh`, `pull-session-transcript.sh`,
`build_uat_excel.py`, `call-test.py`, `synthesize-audio.py`, `seed.py`, `teardown.sh`.
Test calls write real rows (contact attribute `test_call=true`).
