import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { dataRemovalPolicy } from '../../../config/env-config';

export interface GsiSpec {
  /** Index name, e.g. `telefono-index`. */
  indexName: string;
  /** Partition key attribute of the index. */
  partitionKey: string;
}

export interface AppTableProps {
  envName: string;
  projectName: string;
  /** Logical table name segment, e.g. `menu` → `pizza-voice-menu-<env>`. */
  tableSlug: string;
  /** Partition key attribute name. */
  partitionKey: string;
  /** ARN of the CMK for SSE-KMS. */
  kmsKeyArn: string;
  /** Enable a NEW_IMAGE stream (e.g. for Pedidos downstream analytics). */
  enableStream?: boolean;
  /** Optional single GSI (e.g. caller-ID lookup on Clientes). */
  gsi?: GsiSpec;
}

/**
 * Generic L1 `AWS::DynamoDB::Table` for the POC's fixed-menu data model.
 * On-demand billing, SSE with the project CMK, point-in-time recovery and
 * deletion protection ON (single env operates as prod).
 *
 * Used for Menu, Pedidos, Clientes and Tiendas — they only differ in slug,
 * key, optional stream and optional GSI.
 */
export class AppTable extends Construct {
  public readonly table: dynamodb.CfnTable;
  public readonly tableName: string;
  public readonly tableArn: string;
  public readonly indexName?: string;
  public readonly indexArn?: string;

  constructor(scope: Construct, id: string, props: AppTableProps) {
    super(scope, id);
    const { envName, projectName } = props;
    const name = `${projectName}-${props.tableSlug}-${envName}`;

    const attributeDefinitions: dynamodb.CfnTable.AttributeDefinitionProperty[] = [
      { attributeName: props.partitionKey, attributeType: 'S' },
    ];
    if (props.gsi) {
      attributeDefinitions.push({ attributeName: props.gsi.partitionKey, attributeType: 'S' });
    }

    this.table = new dynamodb.CfnTable(this, 'Resource', {
      tableName: name,
      billingMode: 'PAY_PER_REQUEST',
      attributeDefinitions,
      keySchema: [{ attributeName: props.partitionKey, keyType: 'HASH' }],
      sseSpecification: {
        sseEnabled: true,
        sseType: 'KMS',
        kmsMasterKeyId: props.kmsKeyArn,
      },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtectionEnabled: dataRemovalPolicy() === cdk.RemovalPolicy.RETAIN,
      ...(props.enableStream
        ? { streamSpecification: { streamViewType: 'NEW_IMAGE' } }
        : {}),
      ...(props.gsi
        ? {
            globalSecondaryIndexes: [
              {
                indexName: props.gsi.indexName,
                keySchema: [{ attributeName: props.gsi.partitionKey, keyType: 'HASH' }],
                projection: { projectionType: 'ALL' },
              },
            ],
          }
        : {}),
    });
    this.table.applyRemovalPolicy(dataRemovalPolicy());

    this.tableName = this.table.ref;
    this.tableArn = this.table.attrArn;
    if (props.gsi) {
      this.indexName = props.gsi.indexName;
      this.indexArn = `${this.table.attrArn}/index/${props.gsi.indexName}`;
    }
  }
}
