import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { LambdaRole } from '../constructs/governance/lambda-role';
import { LexBotRole } from '../constructs/governance/lex-bot-role';

export interface GovernanceStackProps extends cdk.StackProps {
  params: ParamsConfig;
  kmsKeyArn: string;
  posSecretArn: string;
  jwtSecretArn: string;
  menuTableArn: string;
  ordersTableArn: string;
  customersTableArn: string;
  customersTableIndexArn: string;
  storesTableArn: string;
}

/**
 * All IAM identities, in one reviewable place. The 3 tool-Lambda execution
 * roles (least privilege) plus the Lex bot role. The AgentCore Gateway
 * outbound role is created in the ConversationalAI stack because it needs the
 * concrete tool-Lambda ARNs.
 */
export class GovernanceStack extends cdk.Stack {
  public readonly validateCustomerRoleArn: string;
  public readonly getMenuRoleArn: string;
  public readonly createOrderRoleArn: string;
  public readonly lexBotRoleArn: string;

  constructor(scope: Construct, id: string, props: GovernanceStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    const kmsStatement = {
      Sid: 'UseCmk',
      Effect: 'Allow' as const,
      Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
      Resource: [props.kmsKeyArn],
    };

    // validateCustomer — read/write Customers (+ phone GSI).
    this.validateCustomerRoleArn = new LambdaRole(this, 'ValidateCustomerRole', {
      ...shared,
      roleSlug: 'validate-customer',
      statements: [
        {
          Sid: 'CustomersRW',
          Effect: 'Allow',
          Action: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
          ],
          Resource: [props.customersTableArn, props.customersTableIndexArn],
        },
        kmsStatement,
      ],
    }).roleArn;

    // getMenu — read-only Menu.
    this.getMenuRoleArn = new LambdaRole(this, 'GetMenuRole', {
      ...shared,
      roleSlug: 'get-menu',
      statements: [
        {
          Sid: 'MenuRead',
          Effect: 'Allow',
          Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
          Resource: [props.menuTableArn],
        },
        kmsStatement,
      ],
    }).roleArn;

    // createOrder — write Orders, read Menu + Stores to validate, read POS secret.
    this.createOrderRoleArn = new LambdaRole(this, 'CreateOrderRole', {
      ...shared,
      roleSlug: 'create-order',
      statements: [
        {
          Sid: 'OrdersWrite',
          Effect: 'Allow',
          Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          Resource: [props.ordersTableArn],
        },
        {
          Sid: 'MenuAndStoresRead',
          Effect: 'Allow',
          // Scan: list the valid catalog back to the agent when it asks for an unknown pizza.
          Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
          Resource: [props.menuTableArn, props.storesTableArn],
        },
        {
          Sid: 'ReadPosSecret',
          Effect: 'Allow',
          Action: ['secretsmanager:GetSecretValue'],
          Resource: [props.posSecretArn],
        },
        kmsStatement,
      ],
    }).roleArn;

    this.lexBotRoleArn = new LexBotRole(this, 'LexBotRole', shared).roleArn;
  }
}
