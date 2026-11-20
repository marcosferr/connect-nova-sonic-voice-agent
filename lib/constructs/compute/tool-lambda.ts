import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ToolLambdaProps {
  envName: string;
  projectName: string;
  /** Slug used for the function name and source dir, e.g. `validar-cliente`. */
  toolSlug: string;
  /** ARN of the L1 execution role (imported read-only — policies live on the role). */
  roleArn: string;
  description: string;
  environment: Record<string, string>;
  memorySize?: number;
  timeout?: cdk.Duration;
}

/**
 * One of the 3 MCP tool Lambdas (`validar-cliente`, `consultar-menu`,
 * `crear-pedido`). Python 3.12, no external deps (boto3 ships with the
 * runtime). Source under `src/lambdas/<toolSlug>/lambda_function.py`.
 *
 * L2 `lambda.Function` is the ONE justified exception to the L1-first rule —
 * `CfnFunction` cannot use `Code.fromAsset` bundling. The execution role
 * stays L1 (`iam.CfnRole`), imported here read-only via `fromRoleArn`, and an
 * explicit L1 `logs.CfnLogGroup` avoids the deprecated logRetention custom
 * resource.
 */
export class ToolLambda extends Construct {
  public readonly function: lambda.Function;
  public readonly functionName: string;

  constructor(scope: Construct, id: string, props: ToolLambdaProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const fnName = `${projectName}-${props.toolSlug}-${envName}`;

    const logGroup = new logs.CfnLogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/${fnName}`,
      retentionInDays: 30,
    });

    this.function = new lambda.Function(this, 'Resource', {
      functionName: fnName,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: 'lambda_function.lambda_handler',
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? cdk.Duration.seconds(30),
      role: iam.Role.fromRoleArn(this, 'Role', props.roleArn, { mutable: false }),
      description: props.description,
      code: lambda.Code.fromAsset(
        path.join(__dirname, '..', '..', '..', 'src', 'lambdas', props.toolSlug),
        { exclude: ['deployment.zip', 'package', '__pycache__', '*.pyc', 'README.md'] },
      ),
      environment: props.environment,
      logGroup: logs.LogGroup.fromLogGroupArn(this, 'LogsRef', logGroup.attrArn),
    });
    this.function.node.addDependency(logGroup);

    this.functionName = fnName;
  }
}
