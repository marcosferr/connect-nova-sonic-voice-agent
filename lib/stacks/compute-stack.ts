import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { ToolLambda } from '../constructs/compute/tool-lambda';

export interface ComputeStackProps extends cdk.StackProps {
  params: ParamsConfig;
  validateCustomerRoleArn: string;
  getMenuRoleArn: string;
  createOrderRoleArn: string;
  menuTableName: string;
  ordersTableName: string;
  customersTableName: string;
  customersTableIndexName: string;
  storesTableName: string;
  posSecretArn: string;
}

/**
 * The 3 MCP tool Lambdas exposed to the orchestrator via AgentCore Gateway.
 * Each is a thin Python 3.12 function reading/writing the DynamoDB tables;
 * `create-order` also posts to the Forno Pizza POS using the secret.
 */
export class ComputeStack extends cdk.Stack {
  public readonly validateCustomerFunction: lambda.IFunction;
  public readonly getMenuFunction: lambda.IFunction;
  public readonly createOrderFunction: lambda.IFunction;
  public readonly validateCustomerFunctionName: string;
  public readonly getMenuFunctionName: string;
  public readonly createOrderFunctionName: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const shared = {
      envName: props.params.envName,
      projectName: props.params.projectName,
      warmMode: props.params.toolWarmMode,
      provisionedConcurrency: props.params.toolProvisionedConcurrency,
    };

    const validateCustomer = new ToolLambda(this, 'ValidateCustomer', {
      ...shared,
      toolSlug: 'validate-customer',
      roleArn: props.validateCustomerRoleArn,
      description: 'Resolves the caller phone against the Customers table; creates the customer if missing',
      environment: {
        CUSTOMERS_TABLE: props.customersTableName,
        CUSTOMERS_PHONE_INDEX: props.customersTableIndexName,
      },
    });

    const getMenu = new ToolLambda(this, 'GetMenu', {
      ...shared,
      toolSlug: 'get-menu',
      roleArn: props.getMenuRoleArn,
      description: 'Reads the Menu table: fixed pizzas, prices and active promos',
      environment: {
        MENU_TABLE: props.menuTableName,
      },
    });

    const createOrder = new ToolLambda(this, 'CreateOrder', {
      ...shared,
      toolSlug: 'create-order',
      roleArn: props.createOrderRoleArn,
      description: 'Validates the order against the catalog, stores it once and sends it to the store POS',
      timeout: cdk.Duration.seconds(60),
      environment: {
        ORDERS_TABLE: props.ordersTableName,
        MENU_TABLE: props.menuTableName,
        STORES_TABLE: props.storesTableName,
        POS_API_BASE_URL: props.params.posApiBaseUrl,
        POS_SECRET_ARN: props.posSecretArn,
      },
    });

    this.validateCustomerFunction = validateCustomer.target;
    this.getMenuFunction = getMenu.target;
    this.createOrderFunction = createOrder.target;
    this.validateCustomerFunctionName = validateCustomer.functionName;
    this.getMenuFunctionName = getMenu.functionName;
    this.createOrderFunctionName = createOrder.functionName;
  }
}
