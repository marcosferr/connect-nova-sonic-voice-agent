import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface AgentCoreGatewayRoleProps {
  envName: string;
  projectName: string;
  /** ARNs of the Lambda functions registered as MCP tool targets. */
  toolLambdaArns: string[];
}

/**
 * L1 `AWS::IAM::Role` assumed by Amazon Bedrock AgentCore Gateway
 * (`bedrock-agentcore.amazonaws.com`) to invoke the 3 MCP tool Lambdas.
 * Outbound auth (Gateway → Lambda) uses the `GATEWAY_IAM_ROLE` credential
 * provider on each target, so this role is the InvokedBy principal.
 */
export class AgentCoreGatewayRole extends Construct {
  public readonly role: iam.CfnRole;
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreGatewayRoleProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.role = new iam.CfnRole(this, 'Resource', {
      roleName: `${projectName}-agentcore-gateway-role-${envName}`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'invoke-mcp-tools',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'InvokeMcpToolLambdas',
                Effect: 'Allow',
                Action: ['lambda:InvokeFunction'],
                Resource: props.toolLambdaArns,
              },
            ],
          },
        },
      ],
    });

    this.roleArn = this.role.attrArn;
  }
}
