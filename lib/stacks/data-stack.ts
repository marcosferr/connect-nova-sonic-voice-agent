import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { AppTable } from '../constructs/data/app-table';

export interface DataStackProps extends cdk.StackProps {
  params: ParamsConfig;
  kmsKeyArn: string;
}

/**
 * DynamoDB data model for the Pedidos IVR (fixed menu):
 *   - `Menu`     (PK pizzaId)            — pizzas fijas, precios, promos
 *   - `Pedidos`  (PK pedidoId, stream)   — pedidos creados
 *   - `Clientes` (PK clienteId + GSI telefono-index) — lookup por caller ID
 *   - `Tiendas`  (PK tiendaId)           — sucursales / cobertura
 *
 * All L1 `CfnTable`, on-demand, SSE-KMS, PITR + deletion protection ON.
 */
export class DataStack extends cdk.Stack {
  public readonly menuTableName: string;
  public readonly menuTableArn: string;
  public readonly pedidosTableName: string;
  public readonly pedidosTableArn: string;
  public readonly clientesTableName: string;
  public readonly clientesTableArn: string;
  public readonly clientesTableIndexName: string;
  public readonly clientesTableIndexArn: string;
  public readonly tiendasTableName: string;
  public readonly tiendasTableArn: string;

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

    const pedidos = new AppTable(this, 'Pedidos', {
      ...shared,
      tableSlug: 'pedidos',
      partitionKey: 'pedidoId',
      enableStream: true,
    });

    const clientes = new AppTable(this, 'Clientes', {
      ...shared,
      tableSlug: 'clientes',
      partitionKey: 'clienteId',
      gsi: { indexName: 'telefono-index', partitionKey: 'telefono' },
    });

    const tiendas = new AppTable(this, 'Tiendas', {
      ...shared,
      tableSlug: 'tiendas',
      partitionKey: 'tiendaId',
    });

    this.menuTableName = menu.tableName;
    this.menuTableArn = menu.tableArn;
    this.pedidosTableName = pedidos.tableName;
    this.pedidosTableArn = pedidos.tableArn;
    this.clientesTableName = clientes.tableName;
    this.clientesTableArn = clientes.tableArn;
    this.clientesTableIndexName = clientes.indexName!;
    this.clientesTableIndexArn = clientes.indexArn!;
    this.tiendasTableName = tiendas.tableName;
    this.tiendasTableArn = tiendas.tableArn;
  }
}
