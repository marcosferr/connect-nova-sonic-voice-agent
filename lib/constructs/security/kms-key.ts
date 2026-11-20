import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export interface KmsKeyProps {
  envName: string;
  projectName: string;
}

/**
 * L1 `AWS::KMS::Key` (CMK) used to encrypt the DynamoDB tables, S3 buckets,
 * Secrets and CloudTrail of the POC. Key rotation is on.
 *
 * The key policy grants the account root full control; individual services
 * use the key through their IAM roles (the standard "delegate to IAM"
 * pattern). A `CfnAlias` gives it a stable, human-readable name.
 */
export class KmsKey extends Construct {
  public readonly key: kms.CfnKey;
  public readonly alias: kms.CfnAlias;

  constructor(scope: Construct, id: string, props: KmsKeyProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const stack = cdk.Stack.of(this);

    this.key = new kms.CfnKey(this, 'Resource', {
      description: `CMK for the ${projectName} contact-center POC (${envName})`,
      enableKeyRotation: true,
      keyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'EnableRootAccountAdmin',
            Effect: 'Allow',
            Principal: { AWS: `arn:aws:iam::${stack.account}:root` },
            Action: 'kms:*',
            Resource: '*',
          },
          {
            Sid: 'AllowAwsServicesViaAccount',
            Effect: 'Allow',
            Principal: {
              Service: [
                'connect.amazonaws.com',
                'logs.amazonaws.com',
                'cloudtrail.amazonaws.com',
                'delivery.logs.amazonaws.com',
              ],
            },
            Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
            Resource: '*',
          },
        ],
      },
    });

    this.alias = new kms.CfnAlias(this, 'Alias', {
      aliasName: `alias/${projectName}-${envName}`,
      targetKeyId: this.key.attrKeyId,
    });
  }
}
