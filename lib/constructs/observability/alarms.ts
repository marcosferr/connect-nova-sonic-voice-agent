import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface LambdaErrorAlarmsProps {
  envName: string;
  projectName: string;
  /** Function names to watch for errors. */
  lambdaFunctionNames: string[];
}

/**
 * One L1 `AWS::CloudWatch::Alarm` per tool Lambda on the `Errors` metric.
 * No alarm action is attached (no SNS topic in the POC) — the alarms are for
 * the Connect/QuickSight dashboards and console visibility.
 */
export class LambdaErrorAlarms extends Construct {
  constructor(scope: Construct, id: string, props: LambdaErrorAlarmsProps) {
    super(scope, id);
    const { envName, projectName } = props;

    props.lambdaFunctionNames.forEach((fnName, idx) => {
      new cloudwatch.CfnAlarm(this, `Errors${idx}`, {
        alarmName: `${projectName}-${fnName}-errors-${envName}`,
        alarmDescription: `Errores en la Lambda ${fnName}`,
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensions: [{ name: 'FunctionName', value: fnName }],
        statistic: 'Sum',
        period: 300,
        evaluationPeriods: 1,
        threshold: 1,
        comparisonOperator: 'GreaterThanOrEqualToThreshold',
        treatMissingData: 'notBreaching',
      });
    });
  }
}
