import * as crypto from 'crypto';
import * as cdk from 'aws-cdk-lib';
import * as lex from 'aws-cdk-lib/aws-lex';
import { Construct } from 'constructs';

export interface LexBotProps {
  envName: string;
  projectName: string;
  /** ARN of the L1 Lex bot role. */
  roleArn: string;
  /** ARN of the Q in Connect assistant the QInConnectIntent delegates to. */
  qconnectAssistantArn: string;
  /** Locale id. Nova Sonic S2S is only supported on `es_US` (not `es_419`). */
  locale: string;
  /** Nova Sonic foundation model id, e.g. `amazon.nova-2-sonic-v1:0`. */
  voiceModelId: string;
  /** Nova Sonic voice, e.g. `Lupe` (Spanish, es-US). */
  voiceId: string;
}

/**
 * L1 Lex V2 bot `pizza-voice-conversational-ai-<env>` + version + `demo`
 * alias. The single locale carries one intent (`AMAZON.QInConnectIntent`)
 * that delegates the whole conversation to Q in Connect — no Lambda code hook.
 *
 * Speech-to-Speech: the locale binds Amazon Nova 2 Sonic through
 * `UnifiedSpeechSettings` (now in the CFN schema). Lex rejects
 * `VoiceSettings` and `UnifiedSpeechSettings` together, so there is no Polly
 * voice here.
 *
 * `CfnBotVersion` snapshots DRAFT only when it is created; its description
 * carries a hash of the locale config so a config change mints a new version
 * and repoints the `demo` alias.
 */
export class LexBot extends Construct {
  public readonly bot: lex.CfnBot;
  public readonly botVersion: lex.CfnBotVersion;
  public readonly botAlias: lex.CfnBotAlias;

  constructor(scope: Construct, id: string, props: LexBotProps) {
    super(scope, id);
    const { envName, projectName, locale } = props;
    const stack = cdk.Stack.of(this);
    const speechModelArn = `arn:${stack.partition}:bedrock:${stack.region}::foundation-model/${props.voiceModelId}`;
    const localeFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ locale, model: props.voiceModelId, voice: props.voiceId, v: 2 }))
      .digest('hex')
      .slice(0, 12);

    this.bot = new lex.CfnBot(this, 'Resource', {
      name: `${projectName}-conversational-ai-${envName}`,
      roleArn: props.roleArn,
      idleSessionTtlInSeconds: 300,
      dataPrivacy: { ChildDirected: false },
      autoBuildBotLocales: true,
      botLocales: [
        {
          localeId: locale,
          description: `Locale ${locale} wired to Q in Connect (Pedidos), Nova Sonic S2S`,
          nluConfidenceThreshold: 0.4,
          unifiedSpeechSettings: {
            speechFoundationModel: { modelArn: speechModelArn, voiceId: props.voiceId },
          },
          intents: [
            {
              name: 'AmazonQinConnect',
              description: 'Delegates the entire conversation to Amazon Q in Connect',
              parentIntentSignature: 'AMAZON.QInConnectIntent',
              fulfillmentCodeHook: {
                enabled: false,
                isActive: true,
                postFulfillmentStatusSpecification: {
                  successResponse: {
                    messageGroupsList: [
                      {
                        message: {
                          plainTextMessage: {
                            value: '((x-amz-lex:q-in-connect-response))',
                          },
                        },
                      },
                    ],
                    allowInterrupt: true,
                  },
                  successNextStep: { dialogAction: { type: 'EndConversation' } },
                  failureNextStep: { dialogAction: { type: 'EndConversation' } },
                  timeoutNextStep: { dialogAction: { type: 'EndConversation' } },
                },
              },
              qInConnectIntentConfiguration: {
                qInConnectAssistantConfiguration: {
                  assistantArn: props.qconnectAssistantArn,
                },
              },
            },
            {
              name: 'FallbackIntent',
              description: 'Default fallback',
              parentIntentSignature: 'AMAZON.FallbackIntent',
            },
          ],
        },
      ],
    });

    this.botVersion = new lex.CfnBotVersion(this, 'Version', {
      botId: this.bot.attrId,
      description: `locale-config ${localeFingerprint}`,
      botVersionLocaleSpecification: [
        {
          localeId: locale,
          botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' },
        },
      ],
    });

    this.botAlias = new lex.CfnBotAlias(this, 'DemoAlias', {
      botId: this.bot.attrId,
      botAliasName: 'demo',
      botVersion: this.botVersion.attrBotVersion,
      sentimentAnalysisSettings: { DetectSentiment: false },
      botAliasLocaleSettings: [
        {
          localeId: locale,
          botAliasLocaleSetting: { enabled: true },
        },
      ],
    });
  }
}
