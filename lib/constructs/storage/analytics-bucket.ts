import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../../../config/env-config';
import { enforceTls } from './connect-storage-bucket';

export interface AnalyticsBucketProps {
  envName: string;
  projectName: string;
  /** ARN of the CMK that encrypts the bucket (SSE-KMS). */
  kmsKeyArn: string;
}

/**
 * `pizza-voice-analytics-<env>` — parquet + Athena query results for the
 * daily post-call analytics (QuickSight reads from here). L1
 * `AWS::S3::Bucket`: SSE-KMS, public access blocked, objects transitioned to
 * STANDARD_IA after 30 days. RETAIN in prod.
 */
export class AnalyticsBucket extends Construct {
  public readonly bucket: s3.CfnBucket;

  constructor(scope: Construct, id: string, props: AnalyticsBucketProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const bucketName = `${projectName}-analytics-${envName}`;

    this.bucket = new s3.CfnBucket(this, 'Resource', {
      bucketName,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          {
            bucketKeyEnabled: true,
            serverSideEncryptionByDefault: {
              sseAlgorithm: 'aws:kms',
              kmsMasterKeyId: props.kmsKeyArn,
            },
          },
        ],
      },
      lifecycleConfiguration: {
        rules: [
          {
            id: 'transition-to-ia',
            prefix: 'parquet/',
            status: 'Enabled',
            transitions: [{ storageClass: 'STANDARD_IA', transitionInDays: 30 }],
          },
          {
            id: 'expire-athena-results',
            prefix: 'athena-results/',
            status: 'Enabled',
            expirationInDays: 30,
          },
        ],
      },
    });
    this.bucket.applyRemovalPolicy(dataRemovalPolicy());

    enforceTls(this, this.bucket, bucketName);
  }
}
