import * as cdk from 'aws-cdk-lib';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Single-environment POC. `dev` is the only env and it operates as prod
 * (`isProd=true`) — retention/protection on stateful resources is ON.
 */
export type EnvName = 'dev';

export interface EnvironmentConfig {
  account?: string;
  region?: string;
}

export interface ParamsConfig {
  envName: EnvName;
  projectName: string;
  isProd: boolean;
  awsAccount: string;
  awsRegion: string;

  /** Text orchestration model for the Q in Connect AI Prompt (Nova Pro). */
  bedrockPromptModel: string;
  /** Speech-to-Speech foundation model (Nova 2 Sonic), bound to the Lex
   *  locale via `UnifiedSpeechSettings` (CFN). */
  novaSonicVoiceModel: string;
  /** Nova Sonic voice. `Lupe` = Spanish (es_US), Generative. */
  novaSonicVoiceId: string;

  // ── Connect / IVR ──────────────────────────────────────────────────────────
  /** Short alias; the real instance alias is `<project>-<alias>-<env>`. */
  connectInstanceAlias: string;
  /** Claim a DID through CFN (`AWS::Connect::PhoneNumber`). Off by default:
   *  Chile (+56) is not self-service and needs an AWS support case. */
  enablePhoneNumber: boolean;
  phoneCountryCode: string;
  phoneType: string;
  contactFlowFile: string;
  /** Lex + orchestrator locale. Nova Sonic S2S only supports `es_US`. */
  locale: string;

  /** Base URL of the Forno Pizza POS REST API (the crearPedido Lambda posts here). */
  posApiBaseUrl: string;

  // ── Feature flags ──────────────────────────────────────────────────────────
  enableConversationalAI: boolean;
  enableObservability: boolean;
  enableQuickSight: boolean;
  /** Fixed menu lives in DynamoDB (read by consultarMenu), so no Wisdom KB by default. */
  enableKnowledgeBase: boolean;

  // ── AgentCore Gateway (MCP) — tools are exposed over MCP, JWT IdP = Connect ──
  enableAgentCoreGateway: boolean;
  /** OIDC discovery URL of the Amazon Connect instance, ending in
   *  `/.well-known/openid-configuration`. Connect is the JWT issuer.
   *  Empty = derived from the instance alias (`https://<alias>.my.connect.aws/...`). */
  agentcoreJwtDiscoveryUrl: string;
  /** Expected `iss` claim of the Connect-minted JWT (validated via
   *  `CustomClaims`). Empty = derived from the instance alias. */
  agentcoreJwtIssuer: string;
  /** `DEBUG` makes the gateway return the exact JWT rejection reason. Leave
   *  empty in prod. */
  agentcoreGatewayExceptionLevel: string;
  /**
   * Attach the 3 MCP tools to the ORCHESTRATION AI Agent (`ToolConfigurations`
   * + MCP security profile). Requires the gateway's MCP_SERVER app association
   * to exist first (the stack orders it). Set `false` to deploy the agent
   * without tools (e.g. to debug the gateway JWT first).
   */
  enableAgentMcpTools: boolean;
}

export interface AppConfig {
  env: EnvironmentConfig;
  params: ParamsConfig;
}

function isEnvName(value: string | undefined): value is EnvName {
  return value === 'dev';
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true';
}

function buildParams(envName: EnvName): ParamsConfig {
  return {
    envName,
    projectName: process.env.PROJECT_NAME ?? 'pizza-voice',
    isProd: true, // single env operates as prod
    awsAccount: process.env.AWS_ACCOUNT_ID ?? '',
    awsRegion: process.env.AWS_REGION ?? 'us-east-1',

    bedrockPromptModel: process.env.BEDROCK_PROMPT_MODEL ?? 'us.amazon.nova-pro-v1:0',
    novaSonicVoiceModel: process.env.NOVA_SONIC_VOICE_MODEL ?? 'amazon.nova-2-sonic-v1:0',
    novaSonicVoiceId: process.env.NOVA_SONIC_VOICE_ID ?? 'Lupe',

    connectInstanceAlias: process.env.CONNECT_INSTANCE_ALIAS ?? 'pedidos',
    enablePhoneNumber: bool(process.env.ENABLE_PHONE_NUMBER, false),
    phoneCountryCode: process.env.PHONE_COUNTRY_CODE ?? 'US',
    phoneType: process.env.PHONE_TYPE ?? 'DID',
    contactFlowFile: process.env.CONTACT_FLOW_FILE ?? 'pedidos-flow-v2.json',
    locale: process.env.LOCALE ?? 'es_US',

    posApiBaseUrl: process.env.POS_API_BASE_URL ?? 'https://pos.example.com/api',

    enableConversationalAI: bool(process.env.ENABLE_CONVERSATIONAL_AI, true),
    enableObservability: bool(process.env.ENABLE_OBSERVABILITY, true),
    enableQuickSight: bool(process.env.ENABLE_QUICKSIGHT, false),
    enableKnowledgeBase: bool(process.env.ENABLE_KNOWLEDGE_BASE, false),

    enableAgentCoreGateway: bool(process.env.ENABLE_AGENTCORE_GATEWAY, true),
    agentcoreJwtDiscoveryUrl: process.env.AGENTCORE_JWT_DISCOVERY_URL ?? '',
    agentcoreJwtIssuer: process.env.AGENTCORE_JWT_ISSUER ?? '',
    agentcoreGatewayExceptionLevel: process.env.AGENTCORE_GATEWAY_EXCEPTION_LEVEL ?? '',
    enableAgentMcpTools: bool(process.env.ENABLE_AGENT_MCP_TOOLS, true),
  };
}

/**
 * Removal policy for stateful resources (tables, buckets, Athena workgroup).
 * `RETAIN_DATA=true` keeps them after `cdk destroy` (production); the default
 * DESTROY makes `scripts/teardown.sh` leave nothing behind (demo/sandbox).
 */
export function dataRemovalPolicy(): cdk.RemovalPolicy {
  return (process.env.RETAIN_DATA ?? 'false').toLowerCase() === 'true'
    ? cdk.RemovalPolicy.RETAIN
    : cdk.RemovalPolicy.DESTROY;
}

/** Full Connect instance alias, e.g. `pizza-voice-pedidos-dev`. */
export function connectInstanceFullAlias(p: ParamsConfig): string {
  return `${p.projectName}-${p.connectInstanceAlias}-${p.envName}`;
}

/** Base URL of the Connect instance — also the `iss` of the JWTs it mints. */
export function connectInstanceUrl(p: ParamsConfig): string {
  return `https://${connectInstanceFullAlias(p)}.my.connect.aws`;
}

export function loadEnvironment(): AppConfig {
  if (!isEnvName(process.env.ENV_NAME)) {
    throw new Error('ENV_NAME must be "dev" (single-environment POC)');
  }
  const params = buildParams(process.env.ENV_NAME);
  return { env: { account: params.awsAccount, region: params.awsRegion }, params };
}

export function getConfigFor(envName: EnvName): AppConfig {
  dotenv.config();
  const params = buildParams(envName);
  return { env: { account: params.awsAccount, region: params.awsRegion }, params };
}
