import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { KmsKey } from '../constructs/security/kms-key';
import { AppSecrets } from '../constructs/security/app-secrets';

export interface SecurityStackProps extends cdk.StackProps {
  params: ParamsConfig;
}

/**
 * Foundational encryption + credentials: one KMS CMK and the two Secrets
 * Manager secrets (POS API key, JWT). Has no dependencies; everything else
 * references its CMK by ARN.
 */
export class SecurityStack extends cdk.Stack {
  public readonly kmsKeyArn: string;
  public readonly posSecretArn: string;
  public readonly jwtSecretArn: string;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    const kms = new KmsKey(this, 'Cmk', shared);

    const secrets = new AppSecrets(this, 'Secrets', {
      ...shared,
      kmsKeyArn: kms.key.attrArn,
    });

    this.kmsKeyArn = kms.key.attrArn;
    this.posSecretArn = secrets.posSecret.ref;
    this.jwtSecretArn = secrets.jwtSecret.ref;
  }
}
