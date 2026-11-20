import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { ParamsConfig } from '../../config/env-config';
import { ToolLambda } from '../constructs/compute/tool-lambda';

export interface ComputeStackProps extends cdk.StackProps {
  params: ParamsConfig;
  validarClienteRoleArn: string;
  consultarMenuRoleArn: string;
  crearPedidoRoleArn: string;
  menuTableName: string;
  pedidosTableName: string;
  clientesTableName: string;
  clientesTableIndexName: string;
  tiendasTableName: string;
  posSecretArn: string;
}

/**
 * The 3 MCP tool Lambdas exposed to the orchestrator via AgentCore Gateway.
 * Each is a thin Python 3.12 function reading/writing the DynamoDB tables;
 * `crear-pedido` also posts to the Forno Pizza POS using the secret.
 */
export class ComputeStack extends cdk.Stack {
  public readonly validarClienteFunction: lambda.IFunction;
  public readonly consultarMenuFunction: lambda.IFunction;
  public readonly crearPedidoFunction: lambda.IFunction;
  public readonly validarClienteFunctionName: string;
  public readonly consultarMenuFunctionName: string;
  public readonly crearPedidoFunctionName: string;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const shared = { envName: props.params.envName, projectName: props.params.projectName };

    const validarCliente = new ToolLambda(this, 'ValidarCliente', {
      ...shared,
      toolSlug: 'validar-cliente',
      roleArn: props.validarClienteRoleArn,
      description: 'Resuelve el caller ID contra la tabla Clientes; crea el cliente si no existe',
      environment: {
        CLIENTES_TABLE: props.clientesTableName,
        CLIENTES_TELEFONO_INDEX: props.clientesTableIndexName,
      },
    });

    const consultarMenu = new ToolLambda(this, 'ConsultarMenu', {
      ...shared,
      toolSlug: 'consultar-menu',
      roleArn: props.consultarMenuRoleArn,
      description: 'Lee la tabla Menu: pizzas fijas disponibles, precios y promos activas',
      environment: {
        MENU_TABLE: props.menuTableName,
      },
    });

    const crearPedido = new ToolLambda(this, 'CrearPedido', {
      ...shared,
      toolSlug: 'crear-pedido',
      roleArn: props.crearPedidoRoleArn,
      description: 'Valida la pizza del catálogo, guarda el pedido y lo envía al POS de la tienda',
      timeout: cdk.Duration.seconds(60),
      environment: {
        PEDIDOS_TABLE: props.pedidosTableName,
        MENU_TABLE: props.menuTableName,
        TIENDAS_TABLE: props.tiendasTableName,
        POS_API_BASE_URL: props.params.posApiBaseUrl,
        POS_SECRET_ARN: props.posSecretArn,
      },
    });

    this.validarClienteFunction = validarCliente.function;
    this.consultarMenuFunction = consultarMenu.function;
    this.crearPedidoFunction = crearPedido.function;
    this.validarClienteFunctionName = validarCliente.functionName;
    this.consultarMenuFunctionName = consultarMenu.functionName;
    this.crearPedidoFunctionName = crearPedido.functionName;
  }
}
