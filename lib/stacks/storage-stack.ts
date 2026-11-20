import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { ConnectStorageBucket } from '../constructs/storage/connect-storage-bucket';
import { AnalyticsBucket } from '../constructs/storage/analytics-bucket';

export interface StorageStackProps extends cdk.StackProps {
  params: ParamsConfig;
  kmsKeyArn: string;
}

/**
 * Stateful S3 storage:
 *   - `pizza-voice-connect-storage-<env>` (Connect recordings + transcripts)
 *   - `pizza-voice-analytics-<env>`       (parquet + Athena results)
 *
 * Both RETAIN in prod (enforced in the constructs).
 */
export class StorageStack extends cdk.Stack {
  public readonly connectStorageBucketName: string;
  public readonly connectStorageBucketArn: string;
  public readonly analyticsBucketName: string;
  public readonly analyticsBucketArn: string;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    const connect = new ConnectStorageBucket(this, 'ConnectStorage', {
      ...shared,
      kmsKeyArn: props.kmsKeyArn,
    });
    const analytics = new AnalyticsBucket(this, 'Analytics', {
      ...shared,
      kmsKeyArn: props.kmsKeyArn,
    });

    this.connectStorageBucketName = connect.bucket.ref;
    this.connectStorageBucketArn = connect.bucket.attrArn;
    this.analyticsBucketName = analytics.bucket.ref;
    this.analyticsBucketArn = analytics.bucket.attrArn;
  }
}
