import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { SecurityStack } from '../stacks/security-stack';
import { StorageStack } from '../stacks/storage-stack';
import { DataStack } from '../stacks/data-stack';
import { GovernanceStack } from '../stacks/governance-stack';
import { ComputeStack } from '../stacks/compute-stack';
import { ConversationalAIStack } from '../stacks/conversational-ai-stack';
import { ObservabilityStack } from '../stacks/observability-stack';
import { AnalyticsStack } from '../stacks/analytics-stack';

export interface VoiceAgentStageProps extends cdk.StageProps {
  params: ParamsConfig;
}

/**
 * Wires every stack for the single `dev` environment (operates as prod).
 * Dependencies are declared with `addDependency` so `cdk deploy "Dev/*"`
 * topo-sorts: Security → Storage → Data → Governance → Compute →
 * ConversationalAI → Observability → Analytics.
 *
 * Cross-stack data is passed as plain strings (ARNs / names) exposed as
 * public readonly fields, keeping every resource L1 and avoiding implicit
 * cross-stack imports.
 */
export class VoiceAgentStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: VoiceAgentStageProps) {
    super(scope, id, props);
    const { params } = props;
    const stackProps = { env: { account: params.awsAccount, region: params.awsRegion }, params };
    const prefix = `${params.projectName}-${params.envName}`;

    const security = new SecurityStack(this, 'SecurityStack', {
      ...stackProps,
      stackName: `${prefix}-security`,
    });

    const storage = new StorageStack(this, 'StorageStack', {
      ...stackProps,
      stackName: `${prefix}-storage`,
      kmsKeyArn: security.kmsKeyArn,
    });
    storage.addStackDependency(security);

    const data = new DataStack(this, 'DataStack', {
      ...stackProps,
      stackName: `${prefix}-data`,
      kmsKeyArn: security.kmsKeyArn,
    });
    data.addStackDependency(security);

    const governance = new GovernanceStack(this, 'GovernanceStack', {
      ...stackProps,
      stackName: `${prefix}-governance`,
      kmsKeyArn: security.kmsKeyArn,
      posSecretArn: security.posSecretArn,
      jwtSecretArn: security.jwtSecretArn,
      menuTableArn: data.menuTableArn,
      ordersTableArn: data.ordersTableArn,
      customersTableArn: data.customersTableArn,
      customersTableIndexArn: data.customersTableIndexArn,
      storesTableArn: data.storesTableArn,
    });
    governance.addStackDependency(security);
    governance.addStackDependency(data);

    const compute = new ComputeStack(this, 'ComputeStack', {
      ...stackProps,
      stackName: `${prefix}-compute`,
      validateCustomerRoleArn: governance.validateCustomerRoleArn,
      getMenuRoleArn: governance.getMenuRoleArn,
      createOrderRoleArn: governance.createOrderRoleArn,
      menuTableName: data.menuTableName,
      ordersTableName: data.ordersTableName,
      customersTableName: data.customersTableName,
      customersTableIndexName: data.customersTableIndexName,
      storesTableName: data.storesTableName,
      posSecretArn: security.posSecretArn,
    });
    compute.addStackDependency(governance);
    compute.addStackDependency(data);

    if (params.enableConversationalAI) {
      const conversational = new ConversationalAIStack(this, 'ConversationalAIStack', {
        ...stackProps,
        stackName: `${prefix}-conversational-ai`,
        connectStorageBucketName: storage.connectStorageBucketName,
        kmsKeyArn: security.kmsKeyArn,
        lexBotRoleArn: governance.lexBotRoleArn,
        toolLambdas: {
          validateCustomer: compute.validateCustomerFunction,
          getMenu: compute.getMenuFunction,
          createOrder: compute.createOrderFunction,
        },
      });
      conversational.addStackDependency(storage);
      conversational.addStackDependency(governance);
      conversational.addStackDependency(compute);
    }

    if (params.enableObservability) {
      const observability = new ObservabilityStack(this, 'ObservabilityStack', {
        ...stackProps,
        stackName: `${prefix}-observability`,
        lambdaFunctionNames: [
          compute.validateCustomerFunctionName,
          compute.getMenuFunctionName,
          compute.createOrderFunctionName,
        ],
      });
      observability.addStackDependency(storage);
      observability.addStackDependency(compute);
    }

    const analytics = new AnalyticsStack(this, 'AnalyticsStack', {
      ...stackProps,
      stackName: `${prefix}-analytics`,
      analyticsBucketName: storage.analyticsBucketName,
    });
    analytics.addStackDependency(storage);

    applyGlobalTags(this, params);
  }
}

function applyGlobalTags(stage: cdk.Stage, params: ParamsConfig): void {
  cdk.Tags.of(stage).add('Project', params.projectName);
  cdk.Tags.of(stage).add('Environment', params.envName);
  cdk.Tags.of(stage).add('ManagedBy', 'CDK');
}
