import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../../../config/env-config';

export interface ConnectStorageBucketProps {
  envName: string;
  projectName: string;
  /** ARN of the CMK that encrypts the bucket (SSE-KMS). */
  kmsKeyArn: string;
}

/**
 * `pizza-voice-connect-storage-<env>` — receives Amazon Connect call
 * recordings and chat transcripts via `CfnInstanceStorageConfig`
 * (wired in `chatbot/connect-instance.ts`).
 *
 * L1 `AWS::S3::Bucket`: SSE-KMS, public access fully blocked, TLS enforced
 * via bucket policy, recordings expired after 365 days. RETAIN in prod.
 */
export class ConnectStorageBucket extends Construct {
  public readonly bucket: s3.CfnBucket;
  public readonly bucketPolicy: s3.CfnBucketPolicy;

  constructor(scope: Construct, id: string, props: ConnectStorageBucketProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const bucketName = `${projectName}-connect-storage-${envName}`;

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
            id: 'expire-old-call-recordings',
            prefix: 'connect/',
            status: 'Enabled',
            expirationInDays: 365,
          },
        ],
      },
    });
    this.bucket.applyRemovalPolicy(dataRemovalPolicy());

    this.bucketPolicy = enforceTls(this, this.bucket, bucketName);
  }
}

/** Adds a deny-non-TLS bucket policy (L1 `AWS::S3::BucketPolicy`). */
export function enforceTls(
  scope: Construct,
  bucket: s3.CfnBucket,
  bucketName: string,
): s3.CfnBucketPolicy {
  return new s3.CfnBucketPolicy(scope, 'TlsPolicy', {
    bucket: bucket.ref,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'DenyInsecureTransport',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:*',
          Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    },
  });
}
