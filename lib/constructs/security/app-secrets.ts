import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface AppSecretsProps {
  envName: string;
  projectName: string;
  /** ARN of the CMK used to encrypt the secrets. */
  kmsKeyArn: string;
}

/**
 * L1 `AWS::SecretsManager::Secret` ×2 for the ordering IVR:
 *   - `<project>/pos-api-key-<env>` — credential for the Forno Pizza POS REST API
 *     (used by the createOrder Lambda).
 *   - `<project>/jwt-secret-<env>`  — shared JWT secret for the contact-center
 *     integration.
 *
 * Values are placeholders (`REPLACE_ME`); the operator sets the real values
 * post-deploy with `aws secretsmanager put-secret-value` (see
 * docs/manual-steps.md). Never commit real credentials.
 */
export class AppSecrets extends Construct {
  public readonly posSecret: secretsmanager.CfnSecret;
  public readonly jwtSecret: secretsmanager.CfnSecret;

  constructor(scope: Construct, id: string, props: AppSecretsProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.posSecret = new secretsmanager.CfnSecret(this, 'PosApiKey', {
      name: `${projectName}/pos-api-key-${envName}`,
      description: "Forno Pizza POS REST API credential (set the real value post-deploy)",
      kmsKeyId: props.kmsKeyArn,
      secretString: JSON.stringify({ apiKey: 'REPLACE_ME' }),
    });

    this.jwtSecret = new secretsmanager.CfnSecret(this, 'JwtSecret', {
      name: `${projectName}/jwt-secret-${envName}`,
      description: 'Shared JWT secret for the contact-center integration',
      kmsKeyId: props.kmsKeyArn,
      secretString: JSON.stringify({ secret: 'REPLACE_ME' }),
    });
  }
}
