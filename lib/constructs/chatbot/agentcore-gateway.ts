import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/** JSON Schema fragment accepted as an MCP tool schema. */
export type SchemaDef = {
  type: 'string' | 'number' | 'object' | 'array' | 'boolean' | 'integer';
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaDef>;
  items?: SchemaDef;
};

export interface AgentCoreToolDefinition {
  /** Tool name surfaced to the orchestrator (snake_case). */
  name: string;
  /** Gateway target name (kebab-case). The MCP tool id becomes `<targetName>___<name>`. */
  targetName: string;
  description: string;
  inputSchema: SchemaDef;
  outputSchema?: SchemaDef;
  lambdaFunction: lambda.IFunction;
}

export interface AgentCoreGatewayProps {
  envName: string;
  projectName: string;
  /** ARN of the L1 outbound role the Gateway assumes to invoke the tools. */
  roleArn: string;
  /**
   * OIDC discovery URL the inbound JWT authorizer validates against. The IdP
   * is Amazon Connect — the instance's `/.well-known/openid-configuration`.
   */
  jwtDiscoveryUrl: string;
  /**
   * Expected `iss` claim (the Connect instance URL). Connect's JWT carries no
   * `aud` = gateway-id, so the authorizer matches `iss` via `CustomClaims`.
   */
  jwtIssuer: string;
  /** `DEBUG` returns the exact JWT rejection reason. Omit in prod. */
  exceptionLevel?: string;
  /** The MCP tools to register as Lambda targets. */
  tools: AgentCoreToolDefinition[];
  name?: string;
}

/**
 * `pizza-voice-mcp-gateway-<env>` — AgentCore Gateway (MCP) with one Lambda
 * target per tool, all L1 (`aws_bedrockagentcore`).
 *
 * Inbound auth: `CUSTOM_JWT`, issuer = Amazon Connect. The only claim
 * constraint is `iss` (via `CustomClaims`): Connect does not mint
 * `aud = <gateway-id>`, and an `AllowedAudience` constraint makes the MCP
 * integration enumerate 0 tools (verified 2026-06-04).
 *
 * Outbound auth: `GATEWAY_IAM_ROLE` — the gateway role invokes each Lambda,
 * and each Lambda's resource policy allows `bedrock-agentcore.amazonaws.com`
 * scoped to this gateway ARN.
 */
export class AgentCoreGateway extends Construct {
  public readonly gateway: agentcore.CfnGateway;
  public readonly targets: agentcore.CfnGatewayTarget[];
  public readonly gatewayUrl: string;
  public readonly gatewayIdentifier: string;
  public readonly gatewayArn: string;
  /**
   * Per-tool ids as Connect registers them once the gateway is associated as
   * an MCP_SERVER app: `permission` = `<target>___<tool>` (security-profile
   * application permission) and `toolId` = `gateway_<gatewayId>__<permission>`
   * (AI Agent `ToolConfigurations[].ToolId`). Same convention as the AWS
   * sample `aws-samples/sample-agentic-connect-experience`.
   */
  public readonly mcpTools: { toolName: string; permission: string; toolId: string }[];

  constructor(scope: Construct, id: string, props: AgentCoreGatewayProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const name = props.name ?? `${projectName}-mcp-gateway-${envName}`;

    this.gateway = new agentcore.CfnGateway(this, 'Resource', {
      name,
      description: "Forno Pizza MCP gateway exposing the 3 pizza-ordering voice-bot tools",
      protocolType: 'MCP',
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: props.jwtDiscoveryUrl,
          customClaims: [
            {
              inboundTokenClaimName: 'iss',
              inboundTokenClaimValueType: 'STRING',
              authorizingClaimMatchValue: {
                claimMatchOperator: 'EQUALS',
                claimMatchValue: { matchValueString: props.jwtIssuer },
              },
            },
          ],
        },
      },
      roleArn: props.roleArn,
      ...(props.exceptionLevel ? { exceptionLevel: props.exceptionLevel } : {}),
      tags: { Project: projectName, Environment: envName },
    });

    this.gatewayIdentifier = this.gateway.attrGatewayIdentifier;
    this.gatewayArn = this.gateway.attrGatewayArn;
    this.gatewayUrl = this.gateway.attrGatewayUrl;

    this.targets = props.tools.map((tool) => {
      const toolId = toPascal(tool.targetName);

      new lambda.CfnPermission(this, `Invoke${toolId}`, {
        action: 'lambda:InvokeFunction',
        functionName: tool.lambdaFunction.functionArn,
        principal: 'bedrock-agentcore.amazonaws.com',
        sourceArn: this.gatewayArn,
      });

      const target = new agentcore.CfnGatewayTarget(this, `Target${toolId}`, {
        gatewayIdentifier: this.gatewayIdentifier,
        name: tool.targetName,
        description: tool.description,
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: tool.lambdaFunction.functionArn,
              toolSchema: {
                inlinePayload: [
                  {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
                  },
                ],
              },
            },
          },
        },
      });
      return target;
    });

    this.mcpTools = props.tools.map((t) => {
      const permission = `${t.targetName}___${t.name}`;
      return {
        toolName: t.name,
        permission,
        toolId: `gateway_${this.gatewayIdentifier}__${permission}`,
      };
    });

    new cdk.CfnOutput(this, 'GatewayUrl', {
      value: this.gatewayUrl,
      exportName: `${projectName}-mcp-gateway-url-${envName}`,
      description: 'AgentCore Gateway MCP endpoint (registered in Connect as an MCP_SERVER app).',
    });
  }
}

function toPascal(s: string): string {
  return s
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}
