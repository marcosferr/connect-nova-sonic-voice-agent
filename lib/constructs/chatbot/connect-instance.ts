import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export interface ConnectInstanceProps {
  envName: string;
  projectName: string;
  /** Friendly alias used as the path segment under `connect/<alias>/...`. */
  instanceAlias: string;
  /** Name of the S3 bucket that receives recordings + transcripts. */
  storageBucketName: string;
  /** CMK ARN used to encrypt the Connect storage in S3. */
  kmsKeyArn: string;
}

/**
 * L1 `AWS::Connect::Instance` + two `InstanceStorageConfig` associations
 * (call recordings + chat transcripts → S3, SSE-KMS). Connect-managed
 * identity; no AD/Federation.
 *
 * `OutboundCalls` is on (CCP-v2). Queues, routing profiles and hours of
 * operation use the instance defaults — see docs/manual-steps.md.
 */
export class ConnectInstance extends Construct {
  public readonly instance: connect.CfnInstance;
  public readonly callRecordingsStorageConfig: connect.CfnInstanceStorageConfig;
  public readonly chatTranscriptsStorageConfig: connect.CfnInstanceStorageConfig;

  constructor(scope: Construct, id: string, props: ConnectInstanceProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.instance = new connect.CfnInstance(this, 'Resource', {
      identityManagementType: 'CONNECT_MANAGED',
      instanceAlias: `${projectName}-${props.instanceAlias}-${envName}`,
      attributes: {
        inboundCalls: true,
        // Needed for CCP-v2 outbound (previously a post-deploy CLI step).
        outboundCalls: true,
        contactflowLogs: true,
        autoResolveBestVoices: true,
        useCustomTtsVoices: false,
        earlyMedia: true,
      },
    });

    const encryptionConfig = {
      encryptionType: 'KMS',
      keyId: props.kmsKeyArn,
    };

    this.callRecordingsStorageConfig = new connect.CfnInstanceStorageConfig(
      this,
      'CallRecordingsStorage',
      {
        instanceArn: this.instance.attrArn,
        resourceType: 'CALL_RECORDINGS',
        storageType: 'S3',
        s3Config: {
          bucketName: props.storageBucketName,
          bucketPrefix: `connect/${props.instanceAlias}/CallRecordings`,
          encryptionConfig,
        },
      },
    );

    this.chatTranscriptsStorageConfig = new connect.CfnInstanceStorageConfig(
      this,
      'ChatTranscriptsStorage',
      {
        instanceArn: this.instance.attrArn,
        resourceType: 'CHAT_TRANSCRIPTS',
        storageType: 'S3',
        s3Config: {
          bucketName: props.storageBucketName,
          bucketPrefix: `connect/${props.instanceAlias}/ChatTranscripts`,
          encryptionConfig,
        },
      },
    );
  }
}
