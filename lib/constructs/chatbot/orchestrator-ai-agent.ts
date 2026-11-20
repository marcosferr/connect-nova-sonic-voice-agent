import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface OrchestratorMcpTool {
  /** MCP tool name, e.g. `validate_customer`. */
  toolName: string;
  /** `<target>___<tool>` — security-profile application permission. */
  permission: string;
  /** `gateway_<gatewayId>__<target>___<tool>` — Connect "MCP tools" id. */
  toolId: string;
}

export interface OrchestratorAIAgentProps {
  envName: string;
  projectName: string;
  /** Wisdom assistant ID that owns this AI Agent. */
  assistantId: string;
  /** AI Prompt ID for the orchestrator system prompt. `:$LATEST` is appended. */
  orchestrationAIPromptId: string;
  /** Amazon Connect instance this agent binds to. */
  connectInstanceArn: string;
  connectInstanceId: string;
  /** Locale for the orchestrator. Must match the Lex locale (`es_US`). */
  locale: string;
  /**
   * MCP tools exposed by the AgentCore Gateway. Requires the gateway to be
   * associated with the instance as an MCP_SERVER app first (add that
   * association as a dependency of `agent`).
   */
  mcpTools?: { gatewayIdentifier: string; tools: OrchestratorMcpTool[] };
  name?: string;
}

/**
 * Q in Connect AI Agent of type ORCHESTRATION (L1, typed config) + its
 * immutable version. Drives the Nova 2 Sonic speech-to-speech conversation
 * and calls the 3 tools over MCP through the AgentCore Gateway.
 *
 * Tool access is two-sided: the agent lists the tools (`ToolConfigurations`)
 * **and** an L1 `AWS::Connect::SecurityProfile` grants the MCP application
 * permissions, associated to the AI agent entity. That association
 * (`connect:AssociateSecurityProfiles`, `EntityType=AI_AGENT`) has no
 * CloudFormation resource, so it is the one `AwsCustomResource` here.
 */
export class OrchestratorAIAgent extends Construct {
  public readonly agent: wisdom.CfnAIAgent;
  public readonly version: wisdom.CfnAIAgentVersion;
  public readonly securityProfile?: connect.CfnSecurityProfile;

  constructor(scope: Construct, id: string, props: OrchestratorAIAgentProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const name = props.name ?? `${projectName}-orchestrator-sonic-${envName}`;
    const tools = props.mcpTools?.tools ?? [];

    this.agent = new wisdom.CfnAIAgent(this, 'Resource', {
      assistantId: props.assistantId,
      name,
      type: 'ORCHESTRATION',
      description: "Nova Sonic orchestrator for the Forno Pizza pizza-ordering voice bot",
      configuration: {
        orchestrationAiAgentConfiguration: {
          connectInstanceArn: props.connectInstanceArn,
          orchestrationAiPromptId: `${props.orchestrationAIPromptId}:$LATEST`,
          locale: props.locale,
          ...(tools.length > 0
            ? {
                toolConfigurations: tools.map((t) => ({
                  toolName: t.toolName,
                  toolType: 'MODEL_CONTEXT_PROTOCOL',
                  toolId: t.toolId,
                })),
              }
            : {}),
        },
      },
    });

    this.version = new wisdom.CfnAIAgentVersion(this, 'Version', {
      assistantId: props.assistantId,
      aiAgentId: this.agent.attrAiAgentId,
    });

    if (props.mcpTools && tools.length > 0) {
      this.securityProfile = new connect.CfnSecurityProfile(this, 'ToolsSecurityProfile', {
        instanceArn: props.connectInstanceArn,
        securityProfileName: `${projectName}-orchestrator-tools-${envName}`,
        description: 'MCP tool access for the ordering orchestrator AI agent',
        permissions: ['Wisdom.View'],
        applications: [
          {
            type: 'MCP',
            namespace: props.mcpTools.gatewayIdentifier,
            applicationPermissions: tools.map((t) => t.permission),
          },
        ],
      });

      const securityProfileId = cdk.Fn.select(
        3,
        cdk.Fn.split('/', this.securityProfile.attrSecurityProfileArn),
      );
      const associate = (action: string): cr.AwsSdkCall => ({
        service: 'Connect',
        action,
        parameters: {
          InstanceId: props.connectInstanceId,
          EntityType: 'AI_AGENT',
          EntityArn: this.agent.attrAiAgentArn,
          SecurityProfiles: [{ Id: securityProfileId }],
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${name}-security-profile`),
      });

      const association = new cr.AwsCustomResource(this, 'SecurityProfileAssociation', {
        onCreate: associate('associateSecurityProfiles'),
        onUpdate: associate('associateSecurityProfiles'),
        onDelete: associate('disassociateSecurityProfiles'),
        // `EntityType: AI_AGENT` is newer than the SDK bundled in the Lambda runtime.
        installLatestAwsSdk: true,
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'connect:AssociateSecurityProfiles',
              'connect:DisassociateSecurityProfiles',
              'wisdom:GetAIAgent',
            ],
            resources: ['*'],
          }),
        ]),
      });
    }
  }
}
