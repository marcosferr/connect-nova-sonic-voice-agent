import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface LexBotRoleProps {
  envName: string;
  projectName: string;
}

/**
 * L1 `AWS::IAM::Role` assumed by Amazon Lex V2 (`lexv2.amazonaws.com`) to
 * run the conversational bot. Grants polly:SynthesizeSpeech and
 * comprehend:DetectSentiment (the standard Lex runtime set) plus
 * `bedrock:InvokeModel` on the Nova Sonic Speech-to-Speech model, which the
 * locale uses once the `unifiedSpeechSettings` binding is applied by CLI.
 */
export class LexBotRole extends Construct {
  public readonly role: iam.CfnRole;
  public readonly roleArn: string;

  constructor(scope: Construct, id: string, props: LexBotRoleProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.role = new iam.CfnRole(this, 'Resource', {
      roleName: `${projectName}-lex-bot-role-${envName}`,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lexv2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'lex-runtime-inline',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'LexRuntime',
                Effect: 'Allow',
                Action: ['polly:SynthesizeSpeech', 'comprehend:DetectSentiment'],
                Resource: '*',
              },
              {
                Sid: 'InvokeNovaSonic',
                Effect: 'Allow',
                Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithBidirectionalStream'],
                Resource: ['arn:aws:bedrock:*::foundation-model/amazon.nova-2-sonic-v1:0'],
              },
            ],
          },
        },
      ],
    });

    this.roleArn = this.role.attrArn;
  }
}
