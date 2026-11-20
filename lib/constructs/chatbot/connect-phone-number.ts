import * as cdk from 'aws-cdk-lib';
import * as connect from 'aws-cdk-lib/aws-connect';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export interface ConnectPhoneNumberProps {
  envName: string;
  projectName: string;
  /** Connect instance ARN that owns the number. */
  targetArn: string;
  /** Connect instance id (for the flow association call). */
  instanceId: string;
  /** ISO country code, e.g. `US`. Chile (`CL`) needs an AWS support case. */
  countryCode: string;
  /** `DID` or `TOLL_FREE`. */
  phoneType: string;
  /** Inbound contact flow to route the number to. */
  contactFlowArn: string;
}

/**
 * L1 `AWS::Connect::PhoneNumber` (claims a DID) + its inbound flow
 * association. CloudFormation has no resource for
 * `AssociatePhoneNumberContactFlow`, so that one call is an
 * `AwsCustomResource`.
 *
 * Chile (+56) DIDs are not self-service claimable: they need an AWS support
 * case with regulatory documents. The POC uses a US DID (`countryCode: US`).
 */
export class ConnectPhoneNumber extends Construct {
  public readonly phoneNumber: connect.CfnPhoneNumber;

  constructor(scope: Construct, id: string, props: ConnectPhoneNumberProps) {
    super(scope, id);

    this.phoneNumber = new connect.CfnPhoneNumber(this, 'Resource', {
      targetArn: props.targetArn,
      type: props.phoneType,
      countryCode: props.countryCode,
      description: `${props.projectName} Pedidos inbound DID (${props.envName})`,
    });

    const phoneNumberId = cdk.Fn.select(1, cdk.Fn.split('/', this.phoneNumber.attrPhoneNumberArn));
    const contactFlowId = cdk.Fn.select(3, cdk.Fn.split('/', props.contactFlowArn));

    const association = new cr.AwsCustomResource(this, 'FlowAssociation', {
      onCreate: {
        service: 'Connect',
        action: 'associatePhoneNumberContactFlow',
        parameters: {
          PhoneNumberId: phoneNumberId,
          InstanceId: props.instanceId,
          ContactFlowId: contactFlowId,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-flow-association`),
      },
      onUpdate: {
        service: 'Connect',
        action: 'associatePhoneNumberContactFlow',
        parameters: {
          PhoneNumberId: phoneNumberId,
          InstanceId: props.instanceId,
          ContactFlowId: contactFlowId,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${id}-flow-association`),
      },
      onDelete: {
        service: 'Connect',
        action: 'disassociatePhoneNumberContactFlow',
        parameters: { PhoneNumberId: phoneNumberId, InstanceId: props.instanceId },
      },
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'connect:AssociatePhoneNumberContactFlow',
            'connect:DisassociatePhoneNumberContactFlow',
          ],
          resources: ['*'],
        }),
      ]),
    });
  }
}
