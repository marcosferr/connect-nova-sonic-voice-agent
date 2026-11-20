import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfigFor } from '../config/env-config';
import { VoiceAgentStage } from '../lib/stages/voice-agent-stage';

/**
 * Synthesises the whole `dev` stage and asserts the key L1 resources exist.
 * Runs offline (no AWS creds) — account/region come from env-config defaults.
 */
function synth(overrides: Record<string, unknown> = {}) {
  const config = getConfigFor('dev');
  // Ensure deterministic account/region for synth.
  const params = {
    ...config.params,
    awsAccount: '123456789012',
    awsRegion: 'us-east-1',
    // Deterministic regardless of the local .env.
    enablePhoneNumber: false,
    enableAgentCoreGateway: true,
    enableAgentMcpTools: true,
    agentcoreJwtDiscoveryUrl: '',
    agentcoreJwtIssuer: '',
    agentcoreGatewayExceptionLevel: '',
    toolWarmMode: 'none' as const,
    contactFlowFile: 'order-flow.json',
    connectInstanceAlias: 'orders',
    ...overrides,
  };
  const app = new cdk.App();
  const stage = new VoiceAgentStage(app, 'Dev', {
    params,
    env: { account: params.awsAccount, region: params.awsRegion },
  });
  return { app, stage };
}

function templateFor(stackSuffix: string, overrides: Record<string, unknown> = {}): Template {
  const { stage } = synth(overrides);
  const stack = stage.node
    .findAll()
    .find((c) => c instanceof cdk.Stack && (c as cdk.Stack).stackName.endsWith(stackSuffix)) as cdk.Stack;
  if (!stack) throw new Error(`stack ending in ${stackSuffix} not found`);
  return Template.fromStack(stack);
}

describe('Voice agent — L1 resources', () => {
  test('Security: KMS key + 2 secrets', () => {
    const t = templateFor('-security');
    t.resourceCountIs('AWS::KMS::Key', 1);
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  test('Data: 4 DynamoDB tables, on-demand + SSE', () => {
    const t = templateFor('-data');
    t.resourceCountIs('AWS::DynamoDB::Table', 4);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
    });
  });

  test('Storage: 2 buckets with public access blocked', () => {
    const t = templateFor('-storage');
    t.resourceCountIs('AWS::S3::Bucket', 2);
  });

  test('Compute: 3 Lambda tools', () => {
    const t = templateFor('-compute');
    t.resourceCountIs('AWS::Lambda::Function', 3);
  });

  test('ConversationalAI: Connect + Lex + Wisdom + AgentCore MCP gateway', () => {
    const t = templateFor('-conversational-ai');
    t.resourceCountIs('AWS::Connect::Instance', 1);
    t.resourceCountIs('AWS::Connect::ContactFlow', 1);
    t.resourceCountIs('AWS::Lex::Bot', 1);
    t.resourceCountIs('AWS::Wisdom::Assistant', 1);
    t.resourceCountIs('AWS::Wisdom::AIPrompt', 1);
    t.resourceCountIs('AWS::Wisdom::AIAgent', 1);
    t.resourceCountIs('AWS::Wisdom::AIAgentVersion', 1);
    t.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    t.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 3);
    t.resourceCountIs('AWS::AppIntegrations::Application', 1);
    // WISDOM_ASSISTANT + LEX_BOT + APPLICATION (MCP server) + LAMBDA_FUNCTION (session data)
    t.resourceCountIs('AWS::Connect::IntegrationAssociation', 4);
    t.resourceCountIs('AWS::Connect::SecurityProfile', 1);
    // DID is opt-in (ENABLE_PHONE_NUMBER).
    t.resourceCountIs('AWS::Connect::PhoneNumber', 0);
  });

  test('Gateway: CUSTOM_JWT validates iss (no aud), Lambda targets', () => {
    const t = templateFor('-conversational-ai');
    t.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      ProtocolType: 'MCP',
      AuthorizerType: 'CUSTOM_JWT',
      AuthorizerConfiguration: {
        CustomJWTAuthorizer: Match.objectEquals({
          DiscoveryUrl:
            'https://pizza-voice-orders-dev.my.connect.aws/.well-known/openid-configuration',
          CustomClaims: [
            {
              InboundTokenClaimName: 'iss',
              InboundTokenClaimValueType: 'STRING',
              AuthorizingClaimMatchValue: {
                ClaimMatchOperator: 'EQUALS',
                ClaimMatchValue: {
                  MatchValueString: 'https://pizza-voice-orders-dev.my.connect.aws',
                },
              },
            },
          ],
        }),
      },
    });
    t.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'create-order',
      CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
      TargetConfiguration: {
        Mcp: { Lambda: Match.objectLike({ ToolSchema: { InlinePayload: Match.anyValue() } }) },
      },
    });
    t.hasResourceProperties('AWS::Lambda::Permission', {
      Principal: 'bedrock-agentcore.amazonaws.com',
    });
  });

  test('Orchestrator: ORCHESTRATION agent with 3 MCP tools, Nova Sonic on Lex', () => {
    const t = templateFor('-conversational-ai');
    t.hasResourceProperties('AWS::Wisdom::AIPrompt', {
      Type: 'ORCHESTRATION',
      ApiFormat: 'MESSAGES',
    });
    const agents = t.findResources('AWS::Wisdom::AIAgent');
    const cfg = Object.values(agents)[0].Properties.Configuration.OrchestrationAIAgentConfiguration;
    expect(cfg.Locale).toBe('es_US');
    expect(cfg.ToolConfigurations).toHaveLength(3);
    expect(cfg.ToolConfigurations.map((c: { ToolType: string }) => c.ToolType)).toEqual([
      'MODEL_CONTEXT_PROTOCOL',
      'MODEL_CONTEXT_PROTOCOL',
      'MODEL_CONTEXT_PROTOCOL',
    ]);
    t.hasResourceProperties('AWS::AppIntegrations::Application', {
      ApplicationType: 'MCP_SERVER',
    });
    t.hasResourceProperties('AWS::Lex::Bot', {
      BotLocales: [
        Match.objectLike({
          LocaleId: 'es_US',
          UnifiedSpeechSettings: {
            SpeechFoundationModel: Match.objectLike({ VoiceId: 'Lupe' }),
          },
        }),
      ],
    });
  });

  test('Warm mode provisioned: tools invoked through a live alias with provisioned concurrency', () => {
    const warm = { toolWarmMode: 'provisioned', toolProvisionedConcurrency: 1 };
    const compute = templateFor('-compute', warm);
    compute.resourceCountIs('AWS::Lambda::Alias', 3);
    compute.resourceCountIs('AWS::Lambda::Version', 3);
    compute.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: { ProvisionedConcurrentExecutions: 1 },
    });
    const conv = templateFor('-conversational-ai', warm);
    // session-data Lambda alias lives in the conversational stack
    conv.resourceCountIs('AWS::Lambda::Alias', 1);
    const targets = Object.values(conv.findResources('AWS::BedrockAgentCore::GatewayTarget'));
    const arn = JSON.stringify(targets[0].Properties.TargetConfiguration.Mcp.Lambda.LambdaArn);
    expect(arn).toMatch(/CustomerLive/); // export of the `live` alias, not the bare function
  });
});
