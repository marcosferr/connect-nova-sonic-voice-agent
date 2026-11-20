import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import { Construct } from 'constructs';

export interface QConnectAssistantProps {
  envName: string;
  projectName: string;
}

/**
 * L1 `AWS::Wisdom::Assistant` (type AGENT). The Lex
 * `QInConnectIntentConfiguration` points at this assistant's ARN; the AI
 * Prompt and the ORCHESTRATION AI Agent attach to it.
 */
export class QConnectAssistant extends Construct {
  public readonly assistant: wisdom.CfnAssistant;

  constructor(scope: Construct, id: string, props: QConnectAssistantProps) {
    super(scope, id);
    const { envName, projectName } = props;

    this.assistant = new wisdom.CfnAssistant(this, 'Resource', {
      name: `${projectName}-assistant-${envName}`,
      type: 'AGENT',
      description: "Q in Connect Assistant for the Forno Pizza pizza-ordering voice bot",
      tags: [
        { key: 'AmazonConnectEnabled', value: 'True' },
        { key: 'Environment', value: envName },
      ],
    });
  }
}
