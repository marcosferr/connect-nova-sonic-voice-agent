#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadEnvironment } from '../config/env-config';
import { VoiceAgentStage } from '../lib/stages/voice-agent-stage';

const config = loadEnvironment();

const app = new cdk.App();

new VoiceAgentStage(app, 'Dev', {
  params: config.params,
  env: { account: config.params.awsAccount, region: config.params.awsRegion },
});

cdk.Tags.of(app).add('Project', config.params.projectName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');
