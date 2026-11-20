import * as path from 'path';
import * as fs from 'fs';
import * as wisdom from 'aws-cdk-lib/aws-wisdom';
import { Construct } from 'constructs';

export interface QConnectAIPromptProps {
  envName: string;
  projectName: string;
  assistantId: string;
  /** Text model, e.g. `us.amazon.nova-pro-v1:0`. */
  modelId: string;
  /** Path relative to the `iac/` root, e.g. `prompts/orchestrator-prompt.yaml`. */
  promptFile: string;
  promptName: string;
  /** Q in Connect AI prompt type. Default `ORCHESTRATION`. */
  promptType?: string;
}

/**
 * L1 `AWS::Wisdom::AIPrompt` (+ immutable `AIPromptVersion`) of type
 * ORCHESTRATION, API format MESSAGES.
 *
 * The body is the repo-committed **YAML** prompt (not JSON/plain text — CFN
 * rejects that with "Prompt is not in expected YAML format"). Shape rules:
 * a `system:` block, then a `messages:` list whose only element is the
 * literal `"{{$.conversationHistory}}"`. Customer-facing output must be
 * wrapped in `<message>…</message>` or the voice agent stays silent.
 */
export class QConnectAIPrompt extends Construct {
  public readonly prompt: wisdom.CfnAIPrompt;
  public readonly version: wisdom.CfnAIPromptVersion;

  constructor(scope: Construct, id: string, props: QConnectAIPromptProps) {
    super(scope, id);
    const { envName, projectName } = props;

    const filePath = path.join(__dirname, '..', '..', '..', props.promptFile);
    if (!fs.existsSync(filePath)) {
      throw new Error(`QConnectAIPrompt expected a YAML prompt at ${filePath}.`);
    }
    const promptText = fs.readFileSync(filePath, 'utf-8');
    if (!/^system:/m.test(promptText) || !promptText.includes('{{$.conversationHistory}}')) {
      throw new Error(
        `${props.promptFile} must be MESSAGES YAML: a "system:" block and a "messages:" list ` +
          'holding only "{{$.conversationHistory}}".',
      );
    }

    this.prompt = new wisdom.CfnAIPrompt(this, 'Resource', {
      assistantId: props.assistantId,
      name: `${props.promptName}-${envName}`,
      apiFormat: 'MESSAGES',
      modelId: props.modelId,
      templateType: 'TEXT',
      type: props.promptType ?? 'ORCHESTRATION',
      description: `Orchestrator system prompt for ${projectName} (env=${envName})`,
      templateConfiguration: {
        textFullAiPromptEditTemplateConfiguration: { text: promptText },
      },
    });

    this.version = new wisdom.CfnAIPromptVersion(this, 'Version', {
      assistantId: props.assistantId,
      aiPromptId: this.prompt.attrAiPromptId,
    });
  }
}
