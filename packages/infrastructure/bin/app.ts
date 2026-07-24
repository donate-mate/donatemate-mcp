#!/usr/bin/env node
/**
 * DonateMate MCP CDK App Entry Point
 *
 * Deploys the MCP WebSocket API Gateway stack for AI assistant integration.
 * Uses Cognito User Pool from donatemate-lambdas for authentication.
 */

import * as cdk from 'aws-cdk-lib';
import { McpStack, Environment } from '../lib/mcp-stack.js';
import { FigmaVmStack } from '../lib/figma-vm-stack.js';
import { KnowledgeStack } from '../lib/knowledge-stack.js';
import { MoltbotStack } from '../lib/moltbot-stack.js';
import { HermesStack } from '../lib/hermes-stack.js';

const app = new cdk.App();

// Get environment from context or default to staging
const environment = (app.node.tryGetContext('environment') || 'staging') as Environment;

// Validate environment
if (environment !== 'staging' && environment !== 'production') {
  throw new Error(
    `Invalid environment: ${environment}. Must be 'staging' or 'production'.`
  );
}

// AWS Account and Region
const awsEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || 'us-east-2',
};

// Stack naming: DonateMate-MCP-{Environment}
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const stackName = `DonateMate-MCP-${capitalize(environment)}`;

// Create the MCP stack
const mcpStack = new McpStack(app, stackName, {
  env: awsEnv,
  environment,
  description: `DonateMate MCP WebSocket API - ${environment}`,
  terminationProtection: environment === 'production',
});

// Create the Figma VM stack (optional, deploy with --context deploy-figma-vm=true)
const deployFigmaVm = app.node.tryGetContext('deploy-figma-vm') === 'true';
if (deployFigmaVm) {
  new FigmaVmStack(app, `DonateMate-FigmaVM-${capitalize(environment)}`, {
    env: awsEnv,
    environment,
    responseBucket: mcpStack.figmaResponseBucket,
    description: `DonateMate Figma VM - ${environment}`,
  });
}

// Create the Knowledge Base stack (optional, deploy with --context deploy-knowledge=true)
const deployKnowledge = app.node.tryGetContext('deploy-knowledge') === 'true';
if (deployKnowledge) {
  new KnowledgeStack(app, `DonateMate-Knowledge-${capitalize(environment)}`, {
    env: awsEnv,
    environment,
    description: `DonateMate Knowledge Base - ${environment}`,
    terminationProtection: environment === 'production',
  });
}

// Create the Moltbot stack (optional, deploy with --context deploy-moltbot=true)
// Linux EC2 running Moltbot for Slack/Telegram integration
const deployMoltbot = app.node.tryGetContext('deploy-moltbot') === 'true';
if (deployMoltbot) {
  new MoltbotStack(app, `DonateMate-Moltbot-${capitalize(environment)}`, {
    env: awsEnv,
    environment,
    description: `DonateMate Moltbot (Slack/Telegram bot) - ${environment}`,
    mcpEndpoint: `https://mcp.donate-mate.com/mcp`,
  });
}

// Create the Hermes stack (optional, deploy with --context deploy-hermes=true)
// ECS Fargate agentic-coding control plane + worker pool.
const deployHermes = app.node.tryGetContext('deploy-hermes') === 'true';
if (deployHermes) {
  new HermesStack(app, `DonateMate-Hermes-${capitalize(environment)}`, {
    env: awsEnv,
    environment,
    description: `DonateMate Hermes agentic-coding platform - ${environment}`,
    mcpEndpoint: `https://mcp.donate-mate.com/mcp`,
    terminationProtection: environment === 'production',
  });
}

console.log(`
============================================================
DonateMate MCP Infrastructure - ${environment.toUpperCase()}
============================================================

Stack: ${stackName}
Region: ${awsEnv.region}

Resources:
  - WebSocket API Gateway (donatemate-${environment}-mcp)
  - DynamoDB connections table
  - Lambda handlers (connect, disconnect, message)
  - SSM parameters for integration

Optional Stacks:
  - Figma VM: --context deploy-figma-vm=true
  - Knowledge Base: --context deploy-knowledge=true
  - Moltbot (Slack/Telegram): --context deploy-moltbot=true

Prerequisites:
  - Cognito User Pool must exist in donatemate-lambdas
  - SSM parameter: /donatemate/${environment}/auth/user-pool-id

Deploy MCP stack:
  npx cdk deploy --context environment=${environment}

Deploy with Knowledge Base:
  npx cdk deploy --context environment=${environment} --context deploy-knowledge=true

Deploy with Moltbot:
  npx cdk deploy DonateMate-Moltbot-${capitalize(environment)} --context deploy-moltbot=true

============================================================
`);

app.synth();
