import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export type ToolWarmMode = 'none' | 'snapstart' | 'provisioned';

export interface ToolLambdaProps {
  envName: string;
  projectName: string;
  /** Slug used for the function name and source dir, e.g. `validate-customer`. */
  toolSlug: string;
  /** ARN of the L1 execution role (imported read-only — policies live on the role). */
  roleArn: string;
  description: string;
  environment: Record<string, string>;
  /** Default 512 MB: more CPU shortens the cold-start init; tools run in ms. */
  memorySize?: number;
  /**
   * Cold-start strategy (voice turns are latency-sensitive):
   * - `none` (default): plain function, ~0.45–0.65 s extra on a cold call.
   * - `snapstart`: Lambda SnapStart on published versions (Python 3.12+).
   * - `provisioned`: provisioned concurrency on the `live` alias (no cold start, billed hourly).
   * Callers always invoke the `live` alias (`target`): gateway target,
   * permissions and the contact flow.
   */
  warmMode?: ToolWarmMode;
  /** Instances kept warm when `warmMode=provisioned`. Default 1. */
  provisionedConcurrency?: number;
  timeout?: cdk.Duration;
}

/**
 * One of the 3 MCP tool Lambdas (`validate-customer`, `get-menu`,
 * `create-order`). Python 3.12, no external deps (boto3 ships with the
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
  /** What callers must invoke: the `live` alias. */
  public readonly target: lambda.IFunction;
  public readonly functionName: string;

  constructor(scope: Construct, id: string, props: ToolLambdaProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const fnName = `${projectName}-${props.toolSlug}-${envName}`;
    const warmMode = props.warmMode ?? 'none';

    const logGroup = new logs.CfnLogGroup(this, 'Logs', {
      logGroupName: `/aws/lambda/${fnName}`,
      retentionInDays: 30,
    });

    this.function = new lambda.Function(this, 'Resource', {
      functionName: fnName,
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'lambda_function.lambda_handler',
      memorySize: props.memorySize ?? 512,
      ...(warmMode === 'snapstart' ? { snapStart: lambda.SnapStartConf.ON_PUBLISHED_VERSIONS } : {}),
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

    // Always invoke through a `live` alias so switching TOOL_WARM_MODE never
    // changes the ARN other stacks import (CloudFormation refuses to update an
    // export that is in use). In `none` mode the alias costs nothing.
    this.target = new lambda.Alias(this, 'Live', {
      aliasName: 'live',
      version: this.function.currentVersion,
      ...(warmMode === 'provisioned'
        ? { provisionedConcurrentExecutions: props.provisionedConcurrency ?? 1 }
        : {}),
    });
  }
}
