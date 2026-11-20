import * as cdk from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../../../config/env-config';

export interface AthenaWorkgroupProps {
  envName: string;
  projectName: string;
  /** Analytics bucket name where query results are written. */
  resultsBucketName: string;
}

/**
 * L1 `AWS::Athena::WorkGroup` for the post-call analytics. Query results land
 * under `s3://<analytics-bucket>/athena-results/` (objects inherit the
 * bucket's SSE-KMS default). RETAIN in prod.
 */
export class AthenaWorkgroup extends Construct {
  public readonly workgroup: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: AthenaWorkgroupProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.workgroup = new athena.CfnWorkGroup(this, 'Resource', {
      name: `${projectName}-analytics-${envName}`,
      description: "Post-call analytics for the Forno Pizza Pedidos POC",
      state: 'ENABLED',
      // Lets `cdk destroy` delete the workgroup even if it has saved queries.
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${props.resultsBucketName}/athena-results/`,
        },
      },
    });
    this.workgroup.applyRemovalPolicy(dataRemovalPolicy());
  }
}
