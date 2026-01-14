/**
 * DonateMate Knowledge Base Stack
 *
 * RAG-powered organizational knowledge system with:
 * - Vector search using pgvector in PostgreSQL
 * - AWS Bedrock Titan embeddings
 * - Webhook receivers for GitHub, Jira, Confluence, Slack
 * - Async indexer for processing content
 *
 * This stack is COMPLETELY SEPARATE from the MCP stack and
 * does not interfere with OAuth 2.1 work.
 */

import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sqsEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { HttpApi, HttpMethod, CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export type Environment = 'staging' | 'production';

export interface KnowledgeStackProps extends cdk.StackProps {
  environment: Environment;
  /** VPC to deploy resources into (uses existing DonateMate VPC) */
  vpcId?: string;
  /** Existing RDS instance ARN (uses existing DonateMate database) */
  rdsSecurityGroupId?: string;
}

export class KnowledgeStack extends cdk.Stack {
  public readonly httpApi: HttpApi;
  public readonly indexQueue: sqs.Queue;
  public readonly integrationsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: KnowledgeStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // ========================================================================
    // Lookup existing VPC (from donatemate-lambdas)
    // ========================================================================

    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      tags: {
        Name: `donatemate-${environment}-vpc`,
      },
    });

    // ========================================================================
    // Integration Configuration Table (DynamoDB)
    // Stores config for each integration (GitHub, Jira, Confluence, Slack)
    // ========================================================================

    this.integrationsTable = new dynamodb.Table(this, 'IntegrationsTable', {
      tableName: `donatemate-${environment}-kb-integrations`,
      partitionKey: {
        name: 'integrationId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy:
        environment === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: environment === 'production',
    });

    // GSI for listing by type
    this.integrationsTable.addGlobalSecondaryIndex({
      indexName: 'type-index',
      partitionKey: {
        name: 'integrationType',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================================================
    // Indexing Queue (SQS)
    // Receives webhook events and triggers async indexing
    // ========================================================================

    const deadLetterQueue = new sqs.Queue(this, 'IndexDLQ', {
      queueName: `donatemate-${environment}-kb-index-dlq`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.indexQueue = new sqs.Queue(this, 'IndexQueue', {
      queueName: `donatemate-${environment}-kb-index`,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // ========================================================================
    // ElastiCache Redis (for embedding cache)
    // ========================================================================

    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      description: 'Security group for Knowledge Base Redis cache',
      allowAllOutbound: true,
    });

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: `donatemate-${environment}-kb-redis`,
      description: 'Subnet group for Knowledge Base Redis',
      subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
    });

    const redisCluster = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      clusterName: `donatemate-${environment}-kb-cache`,
      cacheNodeType: environment === 'production' ? 'cache.t4g.small' : 'cache.t4g.micro',
      engine: 'redis',
      numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      port: 6379,
    });

    redisCluster.addDependency(redisSubnetGroup);

    // ========================================================================
    // Lambda Security Group
    // ========================================================================

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for Knowledge Base Lambda functions',
      allowAllOutbound: true,
    });

    // Allow Lambda to access Redis
    redisSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(6379),
      'Allow Lambda to access Redis'
    );

    // ========================================================================
    // Dedicated PostgreSQL RDS Instance (with pgvector)
    // ========================================================================

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: 'Security group for Knowledge Base PostgreSQL',
      allowAllOutbound: false,
    });

    // Allow Lambda to access the database
    dbSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Lambda to access PostgreSQL'
    );

    // Database credentials secret
    const dbSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      secretName: `/donatemate/${environment}/knowledge/database`,
      description: 'Knowledge Base PostgreSQL credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: 'knowledge_admin',
        }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // RDS Subnet Group
    const dbSubnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      vpc,
      description: 'Subnet group for Knowledge Base PostgreSQL',
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      removalPolicy: environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    // RDS PostgreSQL Instance
    // Using PostgreSQL 15+ which has native pgvector support
    const postgresVersion = rds.PostgresEngineVersion.of('15.10', '15');
    const database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `donatemate-${environment}-knowledge`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: postgresVersion,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        environment === 'production' ? ec2.InstanceSize.SMALL : ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      subnetGroup: dbSubnetGroup,
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: 'knowledge',
      allocatedStorage: 20,
      maxAllocatedStorage: environment === 'production' ? 100 : 50,
      storageType: rds.StorageType.GP3,
      multiAz: environment === 'production',
      deletionProtection: environment === 'production',
      removalPolicy: environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      backupRetention: environment === 'production'
        ? cdk.Duration.days(7)
        : cdk.Duration.days(1),
      enablePerformanceInsights: environment === 'production',
      cloudwatchLogsExports: ['postgresql'],
      parameterGroup: new rds.ParameterGroup(this, 'DatabaseParameterGroup', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: postgresVersion,
        }),
        description: 'Knowledge Base PostgreSQL parameters',
        parameters: {
          // Enable pgvector preload
          'shared_preload_libraries': 'pg_stat_statements',
        },
      }),
    });

    // The secret is automatically attached when using Credentials.fromSecret()
    // Access it via database.secret which includes host/port/dbname
    const dbSecretAttachment = database.secret!;

    // ========================================================================
    // Database Initializer (Custom Resource)
    // Runs migration to set up pgvector and schema
    // ========================================================================

    const dbInitHandler = new lambdaNodejs.NodejsFunction(this, 'DbInitHandler', {
      functionName: `donatemate-${environment}-kb-db-init`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambda-handlers', 'knowledge-db-init', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      description: 'Knowledge Base DB initializer - sets up pgvector and schema',
      environment: {
        DATABASE_SECRET_ARN: dbSecretAttachment.secretArn,
      },
      bundling: {
        minify: false,
        sourceMap: true,
        target: 'node20',
        format: lambdaNodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant access to database secret
    dbSecretAttachment.grantRead(dbInitHandler);

    // Custom resource provider
    const dbInitProvider = new customResources.Provider(this, 'DbInitProvider', {
      onEventHandler: dbInitHandler,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Custom resource that triggers on stack create/update
    const dbInit = new cdk.CustomResource(this, 'DbInit', {
      serviceToken: dbInitProvider.serviceToken,
      properties: {
        // Force re-run on each deployment by including a timestamp
        // Remove this line if you only want it to run on first creation
        Version: Date.now().toString(),
      },
    });

    // Ensure database is ready before running init
    dbInit.node.addDependency(database);

    // ========================================================================
    // Secrets for Integration Credentials
    // ========================================================================

    const githubSecret = new secretsmanager.Secret(this, 'GitHubSecret', {
      secretName: `/donatemate/${environment}/knowledge/github`,
      description: 'GitHub integration credentials (token, webhook secret)',
    });

    const jiraSecret = new secretsmanager.Secret(this, 'JiraSecret', {
      secretName: `/donatemate/${environment}/knowledge/jira`,
      description: 'Jira integration credentials (email, token)',
    });

    const confluenceSecret = new secretsmanager.Secret(this, 'ConfluenceSecret', {
      secretName: `/donatemate/${environment}/knowledge/confluence`,
      description: 'Confluence integration credentials (email, token)',
    });

    const slackSecret = new secretsmanager.Secret(this, 'SlackSecret', {
      secretName: `/donatemate/${environment}/knowledge/slack`,
      description: 'Slack integration credentials (bot token, signing secret)',
    });

    // ========================================================================
    // Common Lambda Configuration
    // ========================================================================

    const handlersPath = path.join(__dirname, '..', '..', 'lambda-handlers');

    const lambdaDefaults: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      vpc,
      securityGroups: [lambdaSecurityGroup],
      logRetention:
        environment === 'production' ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK,
      bundling: {
        minify: environment === 'production',
        sourceMap: true,
        target: 'node20',
        format: lambdaNodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
        ENVIRONMENT: environment,
        INTEGRATIONS_TABLE_NAME: this.integrationsTable.tableName,
        INDEX_QUEUE_URL: this.indexQueue.queueUrl,
        REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        REDIS_PORT: redisCluster.attrRedisEndpointPort,
      },
    };

    // ========================================================================
    // Webhook Receiver Lambda
    // ========================================================================

    const webhookHandler = new lambdaNodejs.NodejsFunction(this, 'WebhookHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-kb-webhook`,
      entry: path.join(handlersPath, 'knowledge-webhook', 'src', 'index.ts'),
      handler: 'handler',
      description: 'Knowledge Base webhook receiver - processes events from integrations',
      environment: {
        ...lambdaDefaults.environment,
        GITHUB_SECRET_ARN: githubSecret.secretArn,
        JIRA_SECRET_ARN: jiraSecret.secretArn,
        CONFLUENCE_SECRET_ARN: confluenceSecret.secretArn,
        SLACK_SECRET_ARN: slackSecret.secretArn,
      },
    });

    // Grant permissions
    this.integrationsTable.grantReadData(webhookHandler);
    this.indexQueue.grantSendMessages(webhookHandler);
    githubSecret.grantRead(webhookHandler);
    slackSecret.grantRead(webhookHandler);

    // ========================================================================
    // Indexer Lambda (processes queue messages)
    // ========================================================================

    const indexerHandler = new lambdaNodejs.NodejsFunction(this, 'IndexerHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-kb-indexer`,
      entry: path.join(handlersPath, 'knowledge-indexer', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      description: 'Knowledge Base indexer - fetches content and generates embeddings',
      environment: {
        ...lambdaDefaults.environment,
        GITHUB_SECRET_ARN: githubSecret.secretArn,
        JIRA_SECRET_ARN: jiraSecret.secretArn,
        CONFLUENCE_SECRET_ARN: confluenceSecret.secretArn,
        SLACK_SECRET_ARN: slackSecret.secretArn,
        DATABASE_SECRET_ARN: dbSecretAttachment.secretArn,
      },
    });

    // Grant permissions
    this.integrationsTable.grantReadData(indexerHandler);
    githubSecret.grantRead(indexerHandler);
    jiraSecret.grantRead(indexerHandler);
    confluenceSecret.grantRead(indexerHandler);
    slackSecret.grantRead(indexerHandler);
    dbSecretAttachment.grantRead(indexerHandler);

    // Grant Bedrock access for embeddings
    indexerHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
      })
    );

    // Add SQS trigger
    indexerHandler.addEventSource(
      new sqsEventSources.SqsEventSource(this.indexQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(30),
        reportBatchItemFailures: true,
      })
    );

    // ========================================================================
    // Search Lambda (for MCP tools)
    // ========================================================================

    const searchHandler = new lambdaNodejs.NodejsFunction(this, 'SearchHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-kb-search`,
      entry: path.join(handlersPath, 'knowledge-search', 'src', 'index.ts'),
      handler: 'handler',
      description: 'Knowledge Base search - hybrid vector + full-text search',
      environment: {
        ...lambdaDefaults.environment,
        DATABASE_SECRET_ARN: dbSecretAttachment.secretArn,
      },
    });

    // Grant permissions
    dbSecretAttachment.grantRead(searchHandler);

    // Grant Bedrock access for query embeddings
    searchHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel'],
        resources: ['arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0'],
      })
    );

    // ========================================================================
    // Sync Scheduler (EventBridge Rule)
    // Periodically syncs content from integrations
    // ========================================================================

    const syncHandler = new lambdaNodejs.NodejsFunction(this, 'SyncHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-kb-sync`,
      entry: path.join(handlersPath, 'knowledge-sync', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      description: 'Knowledge Base sync - scheduled sync of integration content',
      environment: {
        ...lambdaDefaults.environment,
        GITHUB_SECRET_ARN: githubSecret.secretArn,
        JIRA_SECRET_ARN: jiraSecret.secretArn,
        CONFLUENCE_SECRET_ARN: confluenceSecret.secretArn,
        SLACK_SECRET_ARN: slackSecret.secretArn,
      },
    });

    // Grant permissions
    this.integrationsTable.grantReadWriteData(syncHandler);
    this.indexQueue.grantSendMessages(syncHandler);
    githubSecret.grantRead(syncHandler);
    jiraSecret.grantRead(syncHandler);
    confluenceSecret.grantRead(syncHandler);
    slackSecret.grantRead(syncHandler);

    // Schedule sync every hour
    new events.Rule(this, 'SyncSchedule', {
      ruleName: `donatemate-${environment}-kb-sync`,
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new eventsTargets.LambdaFunction(syncHandler)],
    });

    // ========================================================================
    // Admin Lambda (for managing integrations)
    // ========================================================================

    // Import the existing API keys table from MCP stack
    const apiKeysTable = dynamodb.Table.fromTableName(
      this,
      'ApiKeysTable',
      `donatemate-${environment}-mcp-api-keys-v2`
    );

    const adminHandler = new lambdaNodejs.NodejsFunction(this, 'AdminHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-kb-admin`,
      entry: path.join(handlersPath, 'knowledge-admin', 'src', 'index.ts'),
      handler: 'handler',
      description: 'Knowledge Base admin - manage integrations',
      environment: {
        ...lambdaDefaults.environment,
        API_KEYS_TABLE_NAME: apiKeysTable.tableName,
        SYNC_FUNCTION_ARN: syncHandler.functionArn,
      },
    });

    // Grant permissions
    this.integrationsTable.grantReadWriteData(adminHandler);
    this.indexQueue.grantSendMessages(adminHandler);
    apiKeysTable.grantReadData(adminHandler);
    syncHandler.grantInvoke(adminHandler);

    // ========================================================================
    // HTTP API Gateway (for webhooks, search, and admin)
    // ========================================================================

    this.httpApi = new HttpApi(this, 'WebhookApi', {
      apiName: `donatemate-${environment}-kb-api`,
      description: `DonateMate Knowledge Base API - ${environment}`,
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Hub-Signature-256', 'X-Slack-Signature'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.PUT, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const webhookIntegration = new HttpLambdaIntegration('WebhookIntegration', webhookHandler);

    // GitHub webhook endpoint
    this.httpApi.addRoutes({
      path: '/webhook/github',
      methods: [HttpMethod.POST],
      integration: webhookIntegration,
    });

    // Jira webhook endpoint
    this.httpApi.addRoutes({
      path: '/webhook/jira',
      methods: [HttpMethod.POST],
      integration: webhookIntegration,
    });

    // Confluence webhook endpoint
    this.httpApi.addRoutes({
      path: '/webhook/confluence',
      methods: [HttpMethod.POST],
      integration: webhookIntegration,
    });

    // Slack webhook endpoint (Events API)
    this.httpApi.addRoutes({
      path: '/webhook/slack',
      methods: [HttpMethod.POST],
      integration: webhookIntegration,
    });

    // Health check endpoint
    this.httpApi.addRoutes({
      path: '/health',
      methods: [HttpMethod.GET],
      integration: webhookIntegration,
    });

    // ========================================================================
    // Search API Routes
    // ========================================================================

    const searchIntegration = new HttpLambdaIntegration('SearchIntegration', searchHandler);

    this.httpApi.addRoutes({
      path: '/search',
      methods: [HttpMethod.POST],
      integration: searchIntegration,
    });

    this.httpApi.addRoutes({
      path: '/stats',
      methods: [HttpMethod.GET],
      integration: searchIntegration,
    });

    // ========================================================================
    // Admin API Routes
    // ========================================================================

    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', adminHandler);

    this.httpApi.addRoutes({
      path: '/admin/integrations',
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: adminIntegration,
    });

    this.httpApi.addRoutes({
      path: '/admin/integrations/{integrationId}',
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: adminIntegration,
    });

    this.httpApi.addRoutes({
      path: '/admin/integrations/{integrationId}/sync',
      methods: [HttpMethod.POST],
      integration: adminIntegration,
    });

    // ========================================================================
    // SSM Parameters
    // ========================================================================

    new ssm.StringParameter(this, 'WebhookApiEndpoint', {
      parameterName: `/donatemate/${environment}/knowledge/webhook-endpoint`,
      stringValue: this.httpApi.url || '',
      description: 'Knowledge Base webhook API endpoint URL',
    });

    new ssm.StringParameter(this, 'IndexQueueUrl', {
      parameterName: `/donatemate/${environment}/knowledge/index-queue-url`,
      stringValue: this.indexQueue.queueUrl,
      description: 'Knowledge Base index queue URL',
    });

    new ssm.StringParameter(this, 'SearchFunctionArn', {
      parameterName: `/donatemate/${environment}/knowledge/search-function-arn`,
      stringValue: searchHandler.functionArn,
      description: 'Knowledge Base search Lambda ARN (for MCP integration)',
    });

    // ========================================================================
    // Monitoring & Alerts
    // ========================================================================

    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `donatemate-${environment}-kb-alerts`,
      displayName: `DonateMate Knowledge Base Alerts (${environment})`,
    });

    // DLQ alarm
    const dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: `donatemate-${environment}-kb-dlq-messages`,
      alarmDescription: 'Messages in Knowledge Base dead letter queue',
      metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // Indexer error alarm
    const indexerErrorAlarm = new cloudwatch.Alarm(this, 'IndexerErrorAlarm', {
      alarmName: `donatemate-${environment}-kb-indexer-errors`,
      alarmDescription: 'Knowledge Base indexer Lambda errors',
      metric: indexerHandler.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    indexerErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // ========================================================================
    // Stack Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'WebhookApiUrl', {
      value: this.httpApi.url || '',
      description: 'Knowledge Base webhook API URL',
    });

    new cdk.CfnOutput(this, 'GitHubWebhookUrl', {
      value: `${this.httpApi.url}webhook/github`,
      description: 'GitHub webhook URL - configure in GitHub repo settings',
    });

    new cdk.CfnOutput(this, 'JiraWebhookUrl', {
      value: `${this.httpApi.url}webhook/jira`,
      description: 'Jira webhook URL - configure in Jira project settings',
    });

    new cdk.CfnOutput(this, 'ConfluenceWebhookUrl', {
      value: `${this.httpApi.url}webhook/confluence`,
      description: 'Confluence webhook URL - configure in Confluence settings',
    });

    new cdk.CfnOutput(this, 'SlackWebhookUrl', {
      value: `${this.httpApi.url}webhook/slack`,
      description: 'Slack Events API URL - configure in Slack app settings',
    });

    new cdk.CfnOutput(this, 'SearchFunctionArnOutput', {
      value: searchHandler.functionArn,
      description: 'Search Lambda ARN for MCP tool integration',
    });

    new cdk.CfnOutput(this, 'IndexQueueUrlOutput', {
      value: this.indexQueue.queueUrl,
      description: 'SQS queue URL for indexing jobs',
    });

    new cdk.CfnOutput(this, 'AlertsTopicArn', {
      value: alertsTopic.topicArn,
      description: 'SNS topic ARN for alerts - subscribe email/Slack here',
    });

    new cdk.CfnOutput(this, 'SearchApiUrl', {
      value: `${this.httpApi.url}search`,
      description: 'Knowledge Base search API endpoint',
    });

    new cdk.CfnOutput(this, 'AdminApiUrl', {
      value: `${this.httpApi.url}admin/integrations`,
      description: 'Knowledge Base admin API endpoint',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instanceEndpoint.hostname,
      description: 'Knowledge Base PostgreSQL endpoint',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: dbSecretAttachment.secretArn,
      description: 'Knowledge Base database credentials secret ARN',
    });

    new cdk.CfnOutput(this, 'DatabaseSecurityGroupId', {
      value: dbSecurityGroup.securityGroupId,
      description: 'Knowledge Base database security group ID',
    });
  }
}
