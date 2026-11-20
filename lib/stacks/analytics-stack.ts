import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { AthenaWorkgroup } from '../constructs/analytics/athena-workgroup';

export interface AnalyticsStackProps extends cdk.StackProps {
  params: ParamsConfig;
  analyticsBucketName: string;
}

/**
 * Athena workgroup over the analytics bucket (parquet). QuickSight is NOT
 * modelled in IaC: the L1 QuickSight resources need an existing QuickSight
 * subscription and principal ARNs at synth time, so the daily dashboard is
 * created manually in H3 — see docs/manual-steps.md (gated by
 * `enableQuickSight`).
 */
export class AnalyticsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AnalyticsStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    new AthenaWorkgroup(this, 'AthenaWorkgroup', {
      ...shared,
      resultsBucketName: props.analyticsBucketName,
    });

    if (props.params.enableQuickSight) {
      throw new Error(
        'enableQuickSight=true: QuickSight is provisioned manually (needs an active ' +
          'subscription + principal ARN). See docs/manual-steps.md. Set ENABLE_QUICKSIGHT=false.',
      );
    }
  }
}
