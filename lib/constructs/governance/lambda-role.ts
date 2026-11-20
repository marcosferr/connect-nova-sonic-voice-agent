import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Plain IAM statement object as rendered into an inline policy document. */
export interface StatementJson {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

export interface LambdaRoleProps {
  envName: string;
  projectName: string;
  /** Role name segment, e.g. `validar-cliente` → `pizza-voice-validar-cliente-role-<env>`. */
  roleSlug: string;
  /** Inline policy statements (least privilege). */
  statements: StatementJson[];
}

/**
 * Generic L1 `AWS::IAM::Role` for a Lambda execution role. Trust policy
 * allows `lambda.amazonaws.com`; managed `AWSLambdaBasicExecutionRole` covers
 * CloudWatch Logs; the caller supplies the scoped inline statements.
 *
 * Built with `iam.CfnRole` (not L2 `iam.Role`) per the repo's L1-first
 * doctrine. `PolicyDocument` is a plain object so cfn-lint validates it.
 */
export class LambdaRole extends Construct {
  public readonly role: iam.CfnRole;
  public readonly roleArn: string;
  public readonly roleName: string;

  constructor(scope: Construct, id: string, props: LambdaRoleProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const name = `${projectName}-${props.roleSlug}-role-${envName}`;

    this.role = new iam.CfnRole(this, 'Resource', {
      roleName: name,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
      ],
      policies: [
        {
          policyName: `${props.roleSlug}-inline`,
          policyDocument: {
            Version: '2012-10-17',
            Statement: props.statements,
          },
        },
      ],
    });

    this.roleArn = this.role.attrArn;
    this.roleName = name;
  }
}
