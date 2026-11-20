import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { ToolLambda, ToolWarmMode } from '../compute/tool-lambda';
import { LambdaRole } from '../governance/lambda-role';

export interface SessionDataLambdaProps {
  envName: string;
  projectName: string;
  /** Connect instance ARN (DescribeContact scope + LAMBDA_FUNCTION association). */
  instanceArn: string;
  /** Q in Connect assistant ID (UpdateSessionData scope). */
  assistantId: string;
  warmMode?: ToolWarmMode;
  provisionedConcurrency?: number;
}

/**
 * `pizza-voice-session-data-<env>` — invoked by the contact flow (not an MCP
 * tool) to copy trusted contact facts (caller ID from the carrier, contactId)
 * into the Q in Connect session as `{{$.Custom.<key>}}` prompt variables.
 *
 * Reliability rationale: identity must not come from what the speech model
 * heard. Same L1 role + L2-function-for-bundling pattern as the tool Lambdas.
 */
export class SessionDataLambda extends Construct {
  /** What the contact flow invokes (the `live` alias when warmed). */
  public readonly function: lambda.IFunction;
  public readonly association: connect.CfnIntegrationAssociation;

  constructor(scope: Construct, id: string, props: SessionDataLambdaProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const stack = cdk.Stack.of(this);

    const role = new LambdaRole(this, 'Role', {
      envName,
      projectName,
      roleSlug: 'session-data',
      statements: [
        {
          Sid: 'DescribeContact',
          Effect: 'Allow',
          Action: ['connect:DescribeContact'],
          Resource: [`${props.instanceArn}/contact/*`],
        },
        {
          Sid: 'UpdateQConnectSession',
          Effect: 'Allow',
          Action: ['wisdom:UpdateSessionData'],
          Resource: [
            `arn:${stack.partition}:wisdom:${stack.region}:${stack.account}:session/${props.assistantId}/*`,
            `arn:${stack.partition}:wisdom:${stack.region}:${stack.account}:assistant/${props.assistantId}`,
          ],
        },
      ],
    });

    const fn = new ToolLambda(this, 'Function', {
      envName,
      projectName,
      toolSlug: 'session-data',
      roleArn: role.roleArn,
      description: 'Contact flow → Q in Connect session data (caller ID, contactId)',
      environment: { LOG_LEVEL: 'INFO' },
      timeout: cdk.Duration.seconds(8),
      warmMode: props.warmMode,
      provisionedConcurrency: props.provisionedConcurrency,
    });
    fn.function.node.addDependency(role.role);
    this.function = fn.target;

    new lambda.CfnPermission(this, 'ConnectInvoke', {
      action: 'lambda:InvokeFunction',
      functionName: this.function.functionArn,
      principal: 'connect.amazonaws.com',
      sourceArn: props.instanceArn,
    });

    this.association = new connect.CfnIntegrationAssociation(this, 'Association', {
      instanceId: props.instanceArn,
      integrationType: 'LAMBDA_FUNCTION',
      integrationArn: this.function.functionArn,
    });
  }
}
