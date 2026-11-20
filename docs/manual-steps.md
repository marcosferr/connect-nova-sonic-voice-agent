# What is (and isn't) automated

Everything in the conversational front deploys with one `cdk deploy "Dev/*"`. This page records
what used to need the CLI or the console, and the few steps that still do.

## Moved from CLI/console to CloudFormation

| Previously a manual step | Now |
|---|---|
| Create 3 Lambda `GatewayTarget`s + `lambda add-permission` | `AWS::BedrockAgentCore::GatewayTarget` (`Mcp.Lambda`) + `AWS::Lambda::Permission` |
| Fix the gateway authorizer to validate `iss` (drifted from IaC) | `CustomJWTAuthorizer.CustomClaims` |
| Paste the Connect OIDC discovery URL after the instance exists (2-phase deploy) | Derived from the deterministic instance alias |
| `update-bot-locale --unified-speech-settings` for Nova Sonic | `BotLocale.UnifiedSpeechSettings` |
| `create-ai-prompt` / `create-ai-agent` / `create-ai-agent-version` | `AWS::Wisdom::AIPrompt` (YAML) / `AIAgent` / `AIAgentVersion` |
| `create-integration-association WISDOM_ASSISTANT` | `AWS::Connect::IntegrationAssociation` |
| Console: Integrations → Add integration → MCP server | `AWS::AppIntegrations::Application` (`MCP_SERVER`) + `APPLICATION` association |
| Console: AI agent designer → add tools; security profile | `ToolConfigurations` (`MODEL_CONTEXT_PROTOCOL`) + `AWS::Connect::SecurityProfile` + custom resource |
| Hand-built flow (session → Lex → agent) | `pedidos-flow-v2.json` with `Fn::Sub` placeholders |
| `update-instance-attribute OUTBOUND_CALLS` | `Attributes.OutboundCalls: true` |
| Claim DID + associate it with the flow | `AWS::Connect::PhoneNumber` + custom resource (`ENABLE_PHONE_NUMBER=true`) |

## Still manual

1. **Seed data** — `python scripts/seed.py` (menu + stores).
2. **Secrets** — replace the `REPLACE_ME` placeholders if you integrate a real POS:
   `aws secretsmanager put-secret-value --secret-id pizza-voice/pos-api-key-dev --secret-string '{"apiKey":"..."}'`.
3. **Phone number** — optional; the synthetic WebRTC caller needs none. If the claim fails with
   *"allowed limit for claimed phone numbers has been exceeded"*, request a quota increase. Some
   countries require regulatory documents via AWS Support.
4. **An agent user for CCP outbound calls** — create a user with a softphone routing profile and
   set the outbound caller ID on its queue.
5. **QuickSight** dashboards over the Athena workgroup (needs a QuickSight subscription).

## Design notes worth keeping

- Connect mints the tool-call JWT with `iss = https://<alias>.my.connect.aws` and **no**
  `aud = <gateway-id>`. With `AllowedAudience=<gateway-id>` the MCP server registers but lists
  **0 tools**. Validate `iss` only. Use `AGENTCORE_GATEWAY_EXCEPTION_LEVEL=DEBUG` temporarily to
  see the exact rejection reason.
- Tool ids: security-profile permission `<target>___<tool>`; agent `ToolId`
  `gateway_<gatewayId>__<target>___<tool>`.
- Prompt body is MESSAGES YAML (`system:` + `messages: ["{{$.conversationHistory}}"]`).
- Nova Sonic S2S only on `es_US` (voice `Lupe`); no `VoiceSettings` alongside it.
- `RETAIN_DATA=true` turns on DynamoDB deletion protection and RETAIN policies;
  `scripts/teardown.sh` handles both modes.
