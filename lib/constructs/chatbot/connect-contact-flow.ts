import * as path from 'path';
import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import { Construct } from 'constructs';

export interface ConnectContactFlowProps {
  envName: string;
  projectName: string;
  instanceArn: string;
  /** Filename under `infrastructure/contact-flow/`. */
  contactFlowFile: string;
  /**
   * Values for the `${Name}` placeholders in the flow JSON, resolved by
   * `Fn::Sub` at deploy time (e.g. `WisdomAssistantArn`, `LexBotAliasArn`,
   * `AiAgentArn`). Flow-language paths like `$.Wisdom.SessionArn` have no
   * braces, so `Fn::Sub` leaves them alone.
   */
  substitutions?: Record<string, string>;
}

/**
 * L1 `AWS::Connect::ContactFlow` for the single ordering IVR. `content` is the
 * Amazon Connect Flow Language JSON loaded from
 * `infrastructure/contact-flow/<file>` (parsed at synth as a sanity check).
 *
 * v2 flow: greeting → `CreateWisdomSession` (Q in Connect assistant) →
 * `UpdateContactData` (bind the session) → `ConnectParticipantWithLexBot`
 * (Nova Sonic alias) with Lex session attribute
 * `x-amz-lex:q-in-connect:ai-agent-arn` selecting the ORCHESTRATION AI agent.
 * The agent calls the 3 tools over MCP via the AgentCore Gateway.
 */
export class ConnectContactFlow extends Construct {
  public readonly flow: connect.CfnContactFlow;

  constructor(scope: Construct, id: string, props: ConnectContactFlowProps) {
    super(scope, id);
    const { envName, projectName } = props;

    const filePath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'infrastructure',
      'contact-flow',
      props.contactFlowFile,
    );
    if (!fs.existsSync(filePath)) {
      throw new Error(`ConnectContactFlow expected ${filePath} but it does not exist.`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    JSON.parse(raw); // synth-time sanity check; throws if invalid JSON

    const subs = props.substitutions ?? {};
    const placeholders = [...raw.matchAll(/\$\{([A-Za-z0-9]+)\}/g)].map((m) => m[1]);
    const missing = [...new Set(placeholders)].filter((p) => !(p in subs));
    if (missing.length > 0) {
      throw new Error(`${props.contactFlowFile}: no substitution for ${missing.join(', ')}`);
    }
    const content = placeholders.length > 0 ? cdk.Fn.sub(raw, subs) : raw;

    this.flow = new connect.CfnContactFlow(this, 'Resource', {
      instanceArn: props.instanceArn,
      name: `${projectName}-orders-${envName}`,
      type: 'CONTACT_FLOW',
      state: 'ACTIVE',
      description: `Forno Pizza ordering IVR (loaded from infrastructure/contact-flow/${props.contactFlowFile})`,
      content,
    });
  }
}
