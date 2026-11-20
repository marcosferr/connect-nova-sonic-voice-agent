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
  pedidosTableArn: string;
  clientesTableArn: string;
  clientesTableIndexArn: string;
  tiendasTableArn: string;
}

/**
 * All IAM identities, in one reviewable place. The 3 tool-Lambda execution
 * roles (least privilege) plus the Lex bot role. The AgentCore Gateway
 * outbound role is created in the ConversationalAI stack because it needs the
 * concrete tool-Lambda ARNs.
 */
export class GovernanceStack extends cdk.Stack {
  public readonly validarClienteRoleArn: string;
  public readonly consultarMenuRoleArn: string;
  public readonly crearPedidoRoleArn: string;
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

    // validarCliente — read/write Clientes (+ caller-ID GSI).
    this.validarClienteRoleArn = new LambdaRole(this, 'ValidarClienteRole', {
      ...shared,
      roleSlug: 'validar-cliente',
      statements: [
        {
          Sid: 'ClientesRW',
          Effect: 'Allow',
          Action: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
          ],
          Resource: [props.clientesTableArn, props.clientesTableIndexArn],
        },
        kmsStatement,
      ],
    }).roleArn;

    // consultarMenu — read-only Menu.
    this.consultarMenuRoleArn = new LambdaRole(this, 'ConsultarMenuRole', {
      ...shared,
      roleSlug: 'consultar-menu',
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

    // crearPedido — write Pedidos, read Menu + Tiendas to validate, read POS secret.
    this.crearPedidoRoleArn = new LambdaRole(this, 'CrearPedidoRole', {
      ...shared,
      roleSlug: 'crear-pedido',
      statements: [
        {
          Sid: 'PedidosWrite',
          Effect: 'Allow',
          Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          Resource: [props.pedidosTableArn],
        },
        {
          Sid: 'MenuAndTiendasRead',
          Effect: 'Allow',
          // Scan: list the valid catalog back to the agent when it asks for an unknown pizza.
          Action: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
          Resource: [props.menuTableArn, props.tiendasTableArn],
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
