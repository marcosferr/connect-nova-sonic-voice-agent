import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../../../config/env-config';

export interface AuditTrailProps {
  envName: string;
  projectName: string;
}

/**
 * L1 `AWS::CloudTrail::Trail` (multi-region, management events) writing to a
 * dedicated, self-contained trail bucket. SSE-S3 on the bucket keeps
 * CloudTrail delivery simple (no extra KMS grants). RETAIN in prod.
 */
export class AuditTrail extends Construct {
  public readonly trail: cloudtrail.CfnTrail;
  public readonly bucket: s3.CfnBucket;

  constructor(scope: Construct, id: string, props: AuditTrailProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const stack = cdk.Stack.of(this);
    const bucketName = `${projectName}-cloudtrail-${envName}`;

    this.bucket = new s3.CfnBucket(this, 'Bucket', {
      bucketName,
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      bucketEncryption: {
        serverSideEncryptionConfiguration: [
          { serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } },
        ],
      },
    });
    this.bucket.applyRemovalPolicy(dataRemovalPolicy());

    const bucketPolicy = new s3.CfnBucketPolicy(this, 'BucketPolicy', {
      bucket: this.bucket.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AWSCloudTrailAclCheck',
            Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' },
            Action: 's3:GetBucketAcl',
            Resource: `arn:aws:s3:::${bucketName}`,
          },
          {
            Sid: 'AWSCloudTrailWrite',
            Effect: 'Allow',
            Principal: { Service: 'cloudtrail.amazonaws.com' },
            Action: 's3:PutObject',
            Resource: `arn:aws:s3:::${bucketName}/AWSLogs/${stack.account}/*`,
            Condition: { StringEquals: { 's3:x-amz-acl': 'bucket-owner-full-control' } },
          },
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

    this.trail = new cloudtrail.CfnTrail(this, 'Resource', {
      trailName: `${projectName}-trail-${envName}`,
      s3BucketName: this.bucket.ref,
      isLogging: true,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableLogFileValidation: true,
    });
    this.trail.addResourceDependency(bucketPolicy);
  }
}
