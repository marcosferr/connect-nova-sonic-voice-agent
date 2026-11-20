import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { AuditTrail } from '../constructs/observability/cloudtrail';
import { LambdaErrorAlarms } from '../constructs/observability/alarms';

export interface ObservabilityStackProps extends cdk.StackProps {
  params: ParamsConfig;
  lambdaFunctionNames: string[];
}

/**
 * CloudTrail (management events, own bucket) + one error alarm per tool
 * Lambda. Per-Lambda log groups are created alongside their functions in the
 * compute layer.
 */
export class ObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    new AuditTrail(this, 'AuditTrail', shared);

    new LambdaErrorAlarms(this, 'LambdaErrorAlarms', {
      ...shared,
      lambdaFunctionNames: props.lambdaFunctionNames,
    });
  }
}
