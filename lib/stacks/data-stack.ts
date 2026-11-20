import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { AppTable } from '../constructs/data/app-table';

export interface DataStackProps extends cdk.StackProps {
  params: ParamsConfig;
  kmsKeyArn: string;
}

/**
 * DynamoDB data model for the ordering IVR (fixed menu):
 *   - `Menu`      (PK pizzaId)                       — fixed pizzas, prices, promos
 *   - `Orders`    (PK orderId, stream)               — placed orders
 *   - `Customers` (PK customerId + GSI phone-index)  — caller-ID lookup
 *   - `Stores`    (PK storeId)                       — store locations
 *
 * All L1 `CfnTable`, on-demand, SSE-KMS, PITR + deletion protection ON.
 */
export class DataStack extends cdk.Stack {
  public readonly menuTableName: string;
  public readonly menuTableArn: string;
  public readonly ordersTableName: string;
  public readonly ordersTableArn: string;
  public readonly customersTableName: string;
  public readonly customersTableArn: string;
  public readonly customersTableIndexName: string;
  public readonly customersTableIndexArn: string;
  public readonly storesTableName: string;
  public readonly storesTableArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const shared = {
      envName: props.params.envName,
      projectName: props.params.projectName,
      kmsKeyArn: props.kmsKeyArn,
    };

    const menu = new AppTable(this, 'Menu', {
      ...shared,
      tableSlug: 'menu',
      partitionKey: 'pizzaId',
    });

    const orders = new AppTable(this, 'Orders', {
      ...shared,
      tableSlug: 'orders',
      partitionKey: 'orderId',
      enableStream: true,
    });

    const customers = new AppTable(this, 'Customers', {
      ...shared,
      tableSlug: 'customers',
      partitionKey: 'customerId',
      gsi: { indexName: 'phone-index', partitionKey: 'phone' },
    });

    const stores = new AppTable(this, 'Stores', {
      ...shared,
      tableSlug: 'stores',
      partitionKey: 'storeId',
    });

    this.menuTableName = menu.tableName;
    this.menuTableArn = menu.tableArn;
    this.ordersTableName = orders.tableName;
    this.ordersTableArn = orders.tableArn;
    this.customersTableName = customers.tableName;
    this.customersTableArn = customers.tableArn;
    this.customersTableIndexName = customers.indexName!;
    this.customersTableIndexArn = customers.indexArn!;
    this.storesTableName = stores.tableName;
    this.storesTableArn = stores.tableArn;
  }
}
