import * as appintegrations from 'aws-cdk-lib/aws-appintegrations';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export interface ConnectIntegrationsProps {
  envName: string;
  projectName: string;
  /** Connect instance ARN. */
  instanceArn: string;
  /** Q in Connect assistant ARN (WISDOM_ASSISTANT association). */
  assistantArn: string;
  /** Lex V2 bot alias ARN (LEX_BOT association). */
  lexBotAliasArn: string;
  /** Optional AgentCore MCP gateway to register as an MCP_SERVER app. */
  mcpGateway?: { gatewayIdentifier: string; gatewayUrl: string };
}

/**
 * Everything that links services *to* the Connect instance, all L1:
 *
 * - `WISDOM_ASSISTANT` — the Q in Connect assistant (required before an AI
 *   Prompt / AI Agent can bind to the instance).
 * - `LEX_BOT` — the Nova Sonic Lex alias used by the contact flow.
 * - `AWS::AppIntegrations::Application` (`ApplicationType: MCP_SERVER`,
 *   `Namespace` = gateway id) + `APPLICATION` association — this is what the
 *   console's "Integrations → Add integration → MCP server" does. Once it
 *   exists, Connect lists the gateway's tools in its "MCP tools" registry
 *   and the AI Agent can reference them by id.
 */
export class ConnectIntegrations extends Construct {
  public readonly assistantAssociation: connect.CfnIntegrationAssociation;
  public readonly lexBotAssociation: connect.CfnIntegrationAssociation;
  public readonly mcpApplication?: appintegrations.CfnApplication;
  public readonly mcpAssociation?: connect.CfnIntegrationAssociation;

  constructor(scope: Construct, id: string, props: ConnectIntegrationsProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.assistantAssociation = new connect.CfnIntegrationAssociation(this, 'Assistant', {
      instanceId: props.instanceArn,
      integrationType: 'WISDOM_ASSISTANT',
      integrationArn: props.assistantArn,
    });

    this.lexBotAssociation = new connect.CfnIntegrationAssociation(this, 'LexBot', {
      instanceId: props.instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: props.lexBotAliasArn,
    });

    if (props.mcpGateway) {
      this.mcpApplication = new appintegrations.CfnApplication(this, 'McpServer', {
        name: `${projectName}-mcp-${envName}`,
        description: "Forno Pizza ordering tools (AgentCore Gateway, MCP)",
        namespace: props.mcpGateway.gatewayIdentifier,
        applicationType: 'MCP_SERVER',
        isService: false,
        applicationSourceConfig: {
          externalUrlConfig: {
            accessUrl: props.mcpGateway.gatewayUrl,
            approvedOrigins: [],
          },
        },
        tags: [{ key: 'AmazonConnectEnabled', value: 'true' }],
      });

      this.mcpAssociation = new connect.CfnIntegrationAssociation(this, 'McpServerAssociation', {
        instanceId: props.instanceArn,
        integrationType: 'APPLICATION',
        integrationArn: this.mcpApplication.attrApplicationArn,
      });
    }
  }
}
