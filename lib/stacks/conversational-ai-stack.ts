import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
  ParamsConfig,
  connectInstanceUrl,
} from '../../config/env-config';
import { ConnectInstance } from '../constructs/chatbot/connect-instance';
import { ConnectPhoneNumber } from '../constructs/chatbot/connect-phone-number';
import { ConnectContactFlow } from '../constructs/chatbot/connect-contact-flow';
import { ConnectIntegrations } from '../constructs/chatbot/connect-integrations';
import { QConnectAssistant } from '../constructs/chatbot/qconnect-assistant';
import { QConnectAIPrompt } from '../constructs/chatbot/qconnect-ai-prompt';
import { OrchestratorAIAgent } from '../constructs/chatbot/orchestrator-ai-agent';
import { LexBot } from '../constructs/chatbot/lex-bot';
import { SessionDataLambda } from '../constructs/chatbot/session-data-lambda';
import {
  AgentCoreGateway,
  AgentCoreToolDefinition,
} from '../constructs/chatbot/agentcore-gateway';
import { AgentCoreGatewayRole } from '../constructs/governance/agentcore-gateway-role';

export interface ConversationalAIStackProps extends cdk.StackProps {
  params: ParamsConfig;
  connectStorageBucketName: string;
  kmsKeyArn: string;
  lexBotRoleArn: string;
  toolLambdas: {
    validateCustomer: lambda.IFunction;
    getMenu: lambda.IFunction;
    createOrder: lambda.IFunction;
  };
}

/**
 * Front-of-house, declared end-to-end in one deploy (all L1 CFN):
 *
 *   Connect instance ─┬─ Q in Connect assistant ── AI Prompt (ORCHESTRATION, YAML)
 *                     │                          └─ AI Agent (ORCHESTRATION) + version
 *                     ├─ Lex bot (Nova 2 Sonic via UnifiedSpeechSettings) + alias
 *                     ├─ AgentCore Gateway (MCP, CUSTOM_JWT iss=Connect)
 *                     │    └─ 3 Lambda GatewayTargets
 *                     ├─ AppIntegrations MCP_SERVER app + APPLICATION association
 *                     ├─ MCP security profile → AI agent
 *                     └─ Contact flow v2 (session → Lex → AI agent) [+ optional DID]
 *
 * The JWT discovery URL / issuer are derived from the deterministic instance
 * alias, so there is no two-phase deploy. RETURN_TO_CONTROL is NOT used.
 *
 * Only two AWS calls have no CloudFormation resource and run as
 * `AwsCustomResource`: AI-agent ↔ security-profile association and
 * phone-number ↔ flow association. Remaining manual steps:
 * docs/manual-steps.md.
 */
export class ConversationalAIStack extends cdk.Stack {
  public readonly connectInstanceArn: string;
  public readonly gatewayUrl?: string;

  constructor(scope: Construct, id: string, props: ConversationalAIStackProps) {
    super(scope, id, props);
    const { params } = props;
    const shared = { envName: params.envName, projectName: params.projectName };

    // ── Connect instance ───────────────────────────────────────────────────
    const connect = new ConnectInstance(this, 'ConnectInstance', {
      ...shared,
      instanceAlias: params.connectInstanceAlias,
      storageBucketName: props.connectStorageBucketName,
      kmsKeyArn: props.kmsKeyArn,
    });
    this.connectInstanceArn = connect.instance.attrArn;

    // ── Q in Connect assistant + Lex (Nova 2 Sonic S2S) ────────────────────
    const assistant = new QConnectAssistant(this, 'QConnectAssistant', shared);

    const lexBot = new LexBot(this, 'LexBot', {
      ...shared,
      roleArn: props.lexBotRoleArn,
      qconnectAssistantArn: assistant.assistant.attrAssistantArn,
      locale: params.locale,
      voiceModelId: params.novaSonicVoiceModel,
      voiceId: params.novaSonicVoiceId,
    });

    // ── AgentCore Gateway (MCP) — 3 Lambda tools, JWT issuer = Connect ─────
    let gateway: AgentCoreGateway | undefined;
    if (params.enableAgentCoreGateway) {
      const tools = buildToolDefinitions(props.toolLambdas);
      const issuer = params.agentcoreJwtIssuer || connectInstanceUrl(params);

      const gatewayRole = new AgentCoreGatewayRole(this, 'GatewayRole', {
        ...shared,
        toolLambdaArns: tools.map((t) => t.lambdaFunction.functionArn),
      });

      gateway = new AgentCoreGateway(this, 'McpGateway', {
        ...shared,
        roleArn: gatewayRole.roleArn,
        jwtDiscoveryUrl:
          params.agentcoreJwtDiscoveryUrl || `${issuer}/.well-known/openid-configuration`,
        jwtIssuer: issuer,
        exceptionLevel: params.agentcoreGatewayExceptionLevel || undefined,
        tools,
      });
      // The OIDC discovery endpoint only exists once the instance does.
      gateway.gateway.addResourceDependency(connect.instance);
      this.gatewayUrl = gateway.gatewayUrl;
    }

    // ── Integrations: assistant, Lex alias, MCP server app ─────────────────
    const integrations = new ConnectIntegrations(this, 'Integrations', {
      ...shared,
      instanceArn: connect.instance.attrArn,
      assistantArn: assistant.assistant.attrAssistantArn,
      lexBotAliasArn: lexBot.botAlias.attrArn,
      mcpGateway: gateway
        ? { gatewayIdentifier: gateway.gatewayIdentifier, gatewayUrl: gateway.gatewayUrl }
        : undefined,
    });
    if (gateway && integrations.mcpApplication) {
      // Register the MCP server only after its tools (targets) exist.
      gateway.targets.forEach((t) => integrations.mcpApplication!.addResourceDependency(t));
    }

    // ── Orchestration AI Prompt + AI Agent ─────────────────────────────────
    const prompt = new QConnectAIPrompt(this, 'OrchestratorPrompt', {
      ...shared,
      assistantId: assistant.assistant.attrAssistantId,
      modelId: params.bedrockPromptModel,
      promptFile: 'prompts/orchestrator-prompt.yaml',
      promptName: 'Orchestrator-Sonic-v1',
    });
    prompt.prompt.addResourceDependency(integrations.assistantAssociation);

    const attachTools = Boolean(gateway && params.enableAgentMcpTools);
    const orchestrator = new OrchestratorAIAgent(this, 'Orchestrator', {
      ...shared,
      assistantId: assistant.assistant.attrAssistantId,
      orchestrationAIPromptId: prompt.prompt.attrAiPromptId,
      connectInstanceArn: connect.instance.attrArn,
      connectInstanceId: connect.instance.attrId,
      locale: params.locale,
      mcpTools:
        attachTools && gateway
          ? { gatewayIdentifier: gateway.gatewayIdentifier, tools: gateway.mcpTools }
          : undefined,
    });
    orchestrator.agent.addResourceDependency(prompt.version);
    orchestrator.agent.addResourceDependency(integrations.assistantAssociation);
    if (attachTools && integrations.mcpAssociation) {
      // Connect only resolves the tool ids once the MCP app is associated.
      orchestrator.agent.addResourceDependency(integrations.mcpAssociation);
      orchestrator.securityProfile?.addResourceDependency(integrations.mcpAssociation);
    }

    // ── Trusted session data (caller ID from the carrier, not the model) ───
    const sessionData = new SessionDataLambda(this, 'SessionData', {
      ...shared,
      instanceArn: connect.instance.attrArn,
      assistantId: assistant.assistant.attrAssistantId,
      warmMode: params.toolWarmMode,
      provisionedConcurrency: params.toolProvisionedConcurrency,
    });

    // ── Contact flow v2: session → session data → Lex (Nova Sonic) → agent ─
    const contactFlow = new ConnectContactFlow(this, 'ContactFlow', {
      ...shared,
      instanceArn: connect.instance.attrArn,
      contactFlowFile: params.contactFlowFile,
      substitutions: {
        WisdomAssistantArn: assistant.assistant.attrAssistantArn,
        LexBotAliasArn: lexBot.botAlias.attrArn,
        AiAgentArn: orchestrator.agent.attrAiAgentArn,
        SessionDataFunctionArn: sessionData.function.functionArn,
      },
    });
    contactFlow.flow.addResourceDependency(sessionData.association);
    contactFlow.flow.addResourceDependency(integrations.lexBotAssociation);
    contactFlow.flow.addResourceDependency(orchestrator.version);

    // ── Optional inbound DID (US fallback; Chile needs a support case) ─────
    if (params.enablePhoneNumber) {
      new ConnectPhoneNumber(this, 'PhoneNumber', {
        ...shared,
        targetArn: connect.instance.attrArn,
        instanceId: connect.instance.attrId,
        countryCode: params.phoneCountryCode,
        phoneType: params.phoneType,
        contactFlowArn: contactFlow.flow.attrContactFlowArn,
      });
    }

    // Outputs consumed by the dev tooling (scripts/stack_env.py) — no IDs in code.
    new cdk.CfnOutput(this, 'ConnectInstanceUrl', { value: connectInstanceUrl(params) });
    new cdk.CfnOutput(this, 'ConnectInstanceId', { value: connect.instance.attrId });
    new cdk.CfnOutput(this, 'AssistantId', { value: assistant.assistant.attrAssistantId });
    new cdk.CfnOutput(this, 'ContactFlowId', {
      value: cdk.Fn.select(3, cdk.Fn.split('/', contactFlow.flow.attrContactFlowArn)),
    });
    new cdk.CfnOutput(this, 'OrchestratorAgentId', { value: orchestrator.agent.attrAiAgentId });
    new cdk.CfnOutput(this, 'OrchestratorAgentArn', { value: orchestrator.agent.attrAiAgentArn });
  }
}


function buildToolDefinitions(
  tools: ConversationalAIStackProps['toolLambdas'],
): AgentCoreToolDefinition[] {
  return [
    {
      name: 'validate_customer',
      targetName: 'validate-customer',
      description:
        'Finds the customer by phone number (caller ID); creates the customer if missing.',
      lambdaFunction: tools.validateCustomer,
      inputSchema: {
        type: 'object',
        required: ['phone'],
        properties: {
          phone: { type: 'string', description: 'Customer phone number (caller ID).' },
          name: { type: 'string', description: 'Customer name (optional).' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          customerId: { type: 'string' },
          phone: { type: 'string' },
          name: { type: 'string' },
          isNew: { type: 'boolean' },
          code: { type: 'string', description: 'Error code when status is "error".' },
          message: { type: 'string' },
          suggestedAction: { type: 'string', description: 'What the agent should do next on error.' },
        },
      },
    },
    {
      name: 'get_menu',
      targetName: 'get-menu',
      description: 'Lists the fixed menu: available pizzas, prices and active promos.',
      lambdaFunction: tools.getMenu,
      inputSchema: {
        type: 'object',
        properties: {
          activeOnly: { type: 'boolean', description: 'Only active pizzas (default true).' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          total: { type: 'integer' },
          validPizzaIds: { type: 'array', items: { type: 'string' } },
          pizzas: { type: 'array', items: { type: 'object' } },
        },
      },
    },
    {
      name: 'create_order',
      targetName: 'create-order',
      description:
        'Places a confirmed order: validates pizzas against the catalog, computes the total server-side, stores it once per call and sends it to the store POS.',
      lambdaFunction: tools.createOrder,
      inputSchema: {
        type: 'object',
        required: ['items'],
        properties: {
          customerId: { type: 'string' },
          phone: { type: 'string' },
          storeId: { type: 'string' },
          contactId: {
            type: 'string',
            description: 'Amazon Connect contactId (para trazabilidad/UAT).',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['pizzaId', 'quantity'],
              properties: {
                pizzaId: { type: 'string' },
                quantity: { type: 'integer' },
              },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          orderId: { type: 'string' },
          total: { type: 'number', description: 'Server-computed total — read this back to the caller.' },
          lines: { type: 'array', items: { type: 'object' } },
          posStatus: { type: 'string' },
          code: { type: 'string', description: 'Error code when status is "error".' },
          message: { type: 'string' },
          suggestedAction: { type: 'string', description: 'What the agent should do next on error.' },
          catalog: { type: 'array', items: { type: 'object' }, description: 'Valid pizzas, returned with PIZZA_NOT_ON_MENU.' },
        },
      },
    },
  ];
}
