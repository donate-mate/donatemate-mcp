/**
 * DonateMate MCP Stack
 *
 * WebSocket API Gateway for MCP server connections from Claude.ai and other AI clients.
 * Uses existing Cognito User Pool from donatemate-lambdas for authentication.
 */

import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpApi, HttpMethod, CorsHttpMethod, DomainName } from 'aws-cdk-lib/aws-apigatewayv2';

export type Environment = 'staging' | 'production';

// Admin Cognito User Pool IDs (for admin/internal access to MCP)
const ADMIN_USER_POOL_IDS: Record<Environment, string> = {
  staging: 'us-east-2_5CfBGj5LQ',     // DonateMate-Staging-AdminUsers
  production: 'us-east-2_GXOhBd1nN',  // DonateMate-Production-AdminUsers
};

// ACM Certificate ARNs for custom domain (mcp.donate-mate.com)
const MCP_CERTIFICATE_ARNS: Record<Environment, string> = {
  staging: 'arn:aws:acm:us-east-2:690788838096:certificate/c84fe58a-e939-4723-85f4-a61b8a3fcb52',
  production: 'arn:aws:acm:us-east-2:690788838096:certificate/c84fe58a-e939-4723-85f4-a61b8a3fcb52', // Same cert for now
};

export interface McpStackProps extends cdk.StackProps {
  environment: Environment;
  /** Override Cognito User Pool ID (defaults to admin pool) */
  cognitoUserPoolId?: string;
}

export class McpStack extends cdk.Stack {
  public readonly webSocketApi: apigatewayv2.WebSocketApi;
  public readonly httpApi: HttpApi;
  public readonly connectionsTable: dynamodb.Table;
  public readonly apiKeysTable: dynamodb.Table;
  public readonly oauthUserPool: cognito.UserPool;

  constructor(scope: Construct, id: string, props: McpStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // ========================================================================
    // Use Admin Cognito User Pool for MCP authentication
    // ========================================================================

    const cognitoUserPoolId = props.cognitoUserPoolId || ADMIN_USER_POOL_IDS[environment];

    // ========================================================================
    // DynamoDB Table for Connection State
    // ========================================================================

    this.connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: `donatemate-${environment}-mcp-connections`,
      partitionKey: {
        name: 'connectionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: environment === 'production',
    });

    // GSI for looking up connections by user
    this.connectionsTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'connectedAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================================================
    // DynamoDB Table for API Keys (long-lived auth tokens)
    // Keys are stored as SHA-256 hashes for security - full key only shown once
    // ========================================================================

    this.apiKeysTable = new dynamodb.Table(this, 'ApiKeysTableV2', {
      tableName: `donatemate-${environment}-mcp-api-keys-v2`,
      partitionKey: {
        name: 'keyHash',  // SHA-256 hash of the API key
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'expiresAt',
    });

    // GSI for looking up keys by user
    this.apiKeysTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for looking up by key prefix (first 8 chars for identification)
    this.apiKeysTable.addGlobalSecondaryIndex({
      indexName: 'keyPrefix-index',
      partitionKey: {
        name: 'keyPrefix',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ========================================================================
    // OAuth 2.1 Cognito User Pool for MCP (Claude.ai Web support)
    // Per MCP spec, Claude.ai requires OAuth for authentication
    // ========================================================================

    // Pre-token generation Lambda trigger - adds audience claim
    const oauthTokenCustomizer = new lambdaNodejs.NodejsFunction(this, 'OAuthTokenCustomizer', {
      functionName: `donatemate-${environment}-mcp-oauth-token`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambda-handlers', 'oauth-token-customizer', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'MCP OAuth pre-token trigger - adds audience claim for MCP server',
      environment: {
        MCP_SERVER_AUDIENCE: 'https://mcp.donate-mate.com',
      },
      bundling: {
        minify: environment === 'production',
        sourceMap: true,
        target: 'node20',
        format: lambdaNodejs.OutputFormat.ESM,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Create MCP OAuth User Pool (separate from admin pool)
    this.oauthUserPool = new cognito.UserPool(this, 'McpOAuthUserPool', {
      userPoolName: `donatemate-${environment}-mcp-oauth`,
      selfSignUpEnabled: false, // Invite-only
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: environment === 'production'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      lambdaTriggers: {
        preTokenGeneration: oauthTokenCustomizer,
      },
    });

    // Add Cognito hosted domain for OAuth
    const oauthDomain = this.oauthUserPool.addDomain('McpOAuthDomain', {
      cognitoDomain: {
        domainPrefix: `donatemate-mcp-${environment}`,
      },
    });

    // Create resource server for MCP scopes
    const mcpResourceServer = this.oauthUserPool.addResourceServer('McpResourceServer', {
      identifier: 'mcp.donate-mate.com',
      userPoolResourceServerName: 'DonateMate MCP',
      scopes: [
        {
          scopeName: 'read',
          scopeDescription: 'Read access to MCP tools and resources',
        },
        {
          scopeName: 'write',
          scopeDescription: 'Write access to MCP tools (Figma editing)',
        },
      ],
    });

    // Create app client for Claude.ai
    const oauthClient = this.oauthUserPool.addClient('ClaudeMcpClient', {
      userPoolClientName: 'claude-mcp-client',
      generateSecret: false, // Public client (PKCE required)
      authFlows: {
        userPassword: false,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.resourceServer(mcpResourceServer, {
            scopeName: 'read',
            scopeDescription: 'Read access to MCP tools and resources',
          }),
          cognito.OAuthScope.resourceServer(mcpResourceServer, {
            scopeName: 'write',
            scopeDescription: 'Write access to MCP tools (Figma editing)',
          }),
        ],
        callbackUrls: [
          'https://claude.ai/api/mcp/auth_callback',
          'https://claude.com/api/mcp/auth_callback', // Future-proofing
        ],
        logoutUrls: [
          'https://claude.ai',
          'https://claude.com',
        ],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Store OAuth configuration in SSM for HTTP handler
    new ssm.StringParameter(this, 'OAuthUserPoolId', {
      parameterName: `/donatemate/${environment}/mcp/oauth-user-pool-id`,
      stringValue: this.oauthUserPool.userPoolId,
      description: 'MCP OAuth Cognito User Pool ID',
    });

    new ssm.StringParameter(this, 'OAuthClientId', {
      parameterName: `/donatemate/${environment}/mcp/oauth-client-id`,
      stringValue: oauthClient.userPoolClientId,
      description: 'MCP OAuth Client ID for Claude.ai',
    });

    new ssm.StringParameter(this, 'OAuthDomain', {
      parameterName: `/donatemate/${environment}/mcp/oauth-domain`,
      stringValue: oauthDomain.domainName,
      description: 'MCP OAuth Cognito domain',
    });

    // ========================================================================
    // Lambda Handlers for WebSocket Routes
    // ========================================================================

    const handlersPath = path.join(__dirname, '..', '..', 'lambda-handlers');

    // Common Lambda configuration
    const lambdaDefaults: Partial<lambdaNodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: environment === 'production'
        ? logs.RetentionDays.ONE_MONTH
        : logs.RetentionDays.ONE_WEEK,
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
        CONNECTIONS_TABLE_NAME: this.connectionsTable.tableName,
        API_KEYS_TABLE_NAME: this.apiKeysTable.tableName,
        COGNITO_USER_POOL_ID: cognitoUserPoolId,
      },
    };

    // $connect handler - validates JWT and stores connection
    const connectHandler = new lambdaNodejs.NodejsFunction(this, 'ConnectHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-mcp-connect`,
      entry: path.join(handlersPath, 'connect', 'src', 'index.ts'),
      handler: 'handler',
      description: 'MCP WebSocket $connect - validates JWT and stores connection',
    });

    // $disconnect handler - cleans up connection state
    const disconnectHandler = new lambdaNodejs.NodejsFunction(this, 'DisconnectHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-mcp-disconnect`,
      entry: path.join(handlersPath, 'disconnect', 'src', 'index.ts'),
      handler: 'handler',
      description: 'MCP WebSocket $disconnect - cleans up connection state',
    });

    // Figma access token is fetched at runtime from SSM
    const figmaTokenParamName = `/donatemate/${environment}/figma/access-token`;

    // $default handler - processes MCP messages
    const messageHandler = new lambdaNodejs.NodejsFunction(this, 'MessageHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-mcp-message`,
      entry: path.join(handlersPath, 'message', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60), // Longer timeout for processing
      memorySize: 512, // More memory for MCP operations
      description: 'MCP WebSocket $default - processes MCP protocol messages',
      environment: {
        ...lambdaDefaults.environment,
        FIGMA_TOKEN_PARAM_NAME: figmaTokenParamName,
      },
    });

    // Grant permission to read the Figma token from SSM
    messageHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${figmaTokenParamName}`,
        ],
      })
    );

    // Grant DynamoDB permissions
    this.connectionsTable.grantReadWriteData(connectHandler);
    this.connectionsTable.grantReadWriteData(disconnectHandler);
    this.connectionsTable.grantReadWriteData(messageHandler);

    // Grant API keys table read access (for auth validation)
    this.apiKeysTable.grantReadData(connectHandler);
    this.apiKeysTable.grantReadData(messageHandler);

    // ========================================================================
    // WebSocket API Gateway
    // ========================================================================

    this.webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: `donatemate-${environment}-mcp`,
      description: `DonateMate MCP WebSocket API - ${environment}`,
      connectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'ConnectIntegration',
          connectHandler
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DisconnectIntegration',
          disconnectHandler
        ),
      },
      defaultRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DefaultIntegration',
          messageHandler
        ),
      },
    });

    // WebSocket Stage
    const stage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi: this.webSocketApi,
      stageName: environment,
      autoDeploy: true,
    });

    // Grant permission to send messages back to clients
    const apiArn = `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${environment}/*`;
    messageHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [apiArn],
    }));

    // ========================================================================
    // HTTP API Gateway (for Claude Web, Desktop, Code remote MCP)
    // ========================================================================

    // HTTP handler - processes MCP messages via HTTP transport
    const httpHandler = new lambdaNodejs.NodejsFunction(this, 'HttpHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-mcp-http`,
      entry: path.join(handlersPath, 'http', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      description: 'MCP HTTP transport - for Claude Web, Desktop, and Code',
      environment: {
        ...lambdaDefaults.environment,
        FIGMA_TOKEN_PARAM_NAME: figmaTokenParamName,
        WEBSOCKET_URL: `wss://${this.webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/${environment}`,
        WEBSOCKET_ENDPOINT: `https://${this.webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/${environment}`,
        // OAuth configuration for MCP spec compliance
        OAUTH_USER_POOL_ID: this.oauthUserPool.userPoolId,
        OAUTH_CLIENT_ID: oauthClient.userPoolClientId,
        OAUTH_DOMAIN: oauthDomain.domainName,
        MCP_SERVER_AUDIENCE: 'https://mcp.donate-mate.com',
      },
    });

    // Grant DynamoDB permissions for relay bridge
    this.connectionsTable.grantReadWriteData(httpHandler);
    // Grant full read/write for API keys table (includes UpdateItem for rate limit tracking)
    this.apiKeysTable.grantReadWriteData(httpHandler);

    // Grant permission to send messages via WebSocket API
    const httpApiArn = `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${environment}/*`;
    httpHandler.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [httpApiArn],
    }));

    // Grant permission to read SSM parameters (Figma token + Knowledge search ARN)
    httpHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${figmaTokenParamName}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/donatemate/${environment}/knowledge/*`,
        ],
      })
    );

    // Grant permission to invoke knowledge search Lambda
    httpHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:donatemate-${environment}-kb-*`,
        ],
      })
    );

    // Create HTTP API with rate limiting
    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `donatemate-${environment}-mcp-http`,
      description: `DonateMate MCP HTTP API - ${environment} (for Claude Web/Desktop/Code)`,
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'MCP-Protocol-Version'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.DELETE, CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
        exposeHeaders: ['Mcp-Session-Id', 'MCP-Protocol-Version'],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Add throttling to the default stage
    const httpStage = this.httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    if (httpStage) {
      httpStage.defaultRouteSettings = {
        throttlingBurstLimit: 50,  // Max concurrent requests
        throttlingRateLimit: 20,   // Requests per second
      };
    }

    // Add routes
    // Note: HTTP API Gateway max integration timeout is 29 seconds
    const httpIntegration = new HttpLambdaIntegration('HttpIntegration', httpHandler, {
      timeout: cdk.Duration.seconds(28), // Just under 29s max for HTTP API Gateway
    });

    // OAuth Protected Resource Metadata endpoint (MCP OAuth 2.1 spec requirement)
    // Claude.ai discovers authorization servers from this endpoint
    this.httpApi.addRoutes({
      path: '/.well-known/oauth-protected-resource',
      methods: [HttpMethod.GET],
      integration: httpIntegration,
    });

    // OAuth Authorization Server Metadata endpoint (RFC 8414)
    // Claude.ai fetches this to discover OAuth endpoints including DCR
    this.httpApi.addRoutes({
      path: '/.well-known/oauth-authorization-server',
      methods: [HttpMethod.GET],
      integration: httpIntegration,
    });

    // Dynamic Client Registration endpoint (RFC 7591)
    // Required by Claude.ai per MCP OAuth spec
    this.httpApi.addRoutes({
      path: '/oauth/register',
      methods: [HttpMethod.POST],
      integration: httpIntegration,
    });

    // Root path - MCP protocol endpoint (Claude.ai may use this)
    this.httpApi.addRoutes({
      path: '/',
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
      integration: httpIntegration,
    });

    // /mcp path - MCP protocol endpoint (Claude Code uses this)
    this.httpApi.addRoutes({
      path: '/mcp',
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.DELETE],
      integration: httpIntegration,
    });

    this.httpApi.addRoutes({
      path: '/mcp/health',
      methods: [HttpMethod.GET],
      integration: httpIntegration,
    });

    // ========================================================================
    // Admin API Handler (API Key Management)
    // ========================================================================

    const adminHandler = new lambdaNodejs.NodejsFunction(this, 'AdminHandler', {
      ...lambdaDefaults,
      functionName: `donatemate-${environment}-mcp-admin`,
      entry: path.join(handlersPath, 'admin', 'src', 'index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      description: 'MCP Admin API - API key management for root admins',
    });

    // Grant DynamoDB permissions for API key management
    this.apiKeysTable.grantReadWriteData(adminHandler);

    // Add admin routes
    const adminIntegration = new HttpLambdaIntegration('AdminIntegration', adminHandler);

    this.httpApi.addRoutes({
      path: '/admin/keys',
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.OPTIONS],
      integration: adminIntegration,
    });

    this.httpApi.addRoutes({
      path: '/admin/keys/{prefix}',
      methods: [HttpMethod.DELETE, HttpMethod.OPTIONS],
      integration: adminIntegration,
    });

    this.httpApi.addRoutes({
      path: '/admin/keys/{prefix}/rotate',
      methods: [HttpMethod.POST, HttpMethod.OPTIONS],
      integration: adminIntegration,
    });

    // ========================================================================
    // Custom Domain (mcp.donate-mate.com)
    // ========================================================================

    const certificate = certificatemanager.Certificate.fromCertificateArn(
      this,
      'McpCertificate',
      MCP_CERTIFICATE_ARNS[environment]
    );

    const customDomain = new DomainName(this, 'McpDomain', {
      domainName: 'mcp.donate-mate.com',
      certificate,
    });

    // Map the custom domain to the HTTP API
    new apigatewayv2.ApiMapping(this, 'McpApiMapping', {
      api: this.httpApi,
      domainName: customDomain,
    });

    // ========================================================================
    // SSM Parameter Exports (for other services to consume)
    // ========================================================================

    new ssm.StringParameter(this, 'WebSocketApiEndpoint', {
      parameterName: `/donatemate/${environment}/mcp/websocket-endpoint`,
      stringValue: stage.url,
      description: 'MCP WebSocket API endpoint URL',
    });

    new ssm.StringParameter(this, 'HttpApiEndpoint', {
      parameterName: `/donatemate/${environment}/mcp/http-endpoint`,
      stringValue: this.httpApi.url || '',
      description: 'MCP HTTP API endpoint URL (for Claude Web/Desktop/Code)',
    });

    new ssm.StringParameter(this, 'ConnectionsTableName', {
      parameterName: `/donatemate/${environment}/mcp/connections-table`,
      stringValue: this.connectionsTable.tableName,
      description: 'MCP connections DynamoDB table name',
    });

    // ========================================================================
    // Monitoring & Alerts
    // ========================================================================

    // SNS Topic for alerts
    const alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `donatemate-${environment}-mcp-alerts`,
      displayName: `DonateMate MCP Alerts (${environment})`,
    });

    // Store SNS topic ARN in SSM for external subscriptions
    new ssm.StringParameter(this, 'AlertsTopicArn', {
      parameterName: `/donatemate/${environment}/mcp/alerts-topic-arn`,
      stringValue: alertsTopic.topicArn,
      description: 'SNS topic ARN for MCP alerts - subscribe email/Slack here',
    });

    // Get HTTP handler log group
    const httpLogGroup = httpHandler.logGroup;

    // Metric filter for auth failures
    const authFailureMetric = new logs.MetricFilter(this, 'AuthFailureMetric', {
      logGroup: httpLogGroup,
      metricNamespace: `DonateMate/MCP/${environment}`,
      metricName: 'AuthFailures',
      filterPattern: logs.FilterPattern.anyTerm('API key not found', 'API key expired', 'API key revoked', 'Invalid or expired API key'),
      metricValue: '1',
    });

    // Alarm for high auth failure rate (>10 in 5 minutes)
    const authFailureAlarm = new cloudwatch.Alarm(this, 'AuthFailureAlarm', {
      alarmName: `donatemate-${environment}-mcp-auth-failures`,
      alarmDescription: 'High rate of authentication failures - possible attack or misconfigured client',
      metric: authFailureMetric.metric({
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    authFailureAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // Alarm for HTTP API 4xx errors (client errors including auth)
    const http4xxAlarm = new cloudwatch.Alarm(this, 'Http4xxAlarm', {
      alarmName: `donatemate-${environment}-mcp-http-4xx`,
      alarmDescription: 'High rate of HTTP 4xx errors',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '4xx',
        dimensionsMap: {
          ApiId: this.httpApi.apiId,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    http4xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // Alarm for HTTP API 5xx errors (server errors)
    const http5xxAlarm = new cloudwatch.Alarm(this, 'Http5xxAlarm', {
      alarmName: `donatemate-${environment}-mcp-http-5xx`,
      alarmDescription: 'HTTP 5xx server errors detected',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: '5xx',
        dimensionsMap: {
          ApiId: this.httpApi.apiId,
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    http5xxAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // Lambda error alarm
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmName: `donatemate-${environment}-mcp-lambda-errors`,
      alarmDescription: 'Lambda function errors detected',
      metric: httpHandler.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    lambdaErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

    // ========================================================================
    // Stack Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: stage.url,
      description: 'WebSocket API URL for MCP connections (full plugin functionality)',
    });

    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: this.httpApi.url || '',
      description: 'HTTP API URL for MCP connections (Claude Web/Desktop/Code)',
    });

    new cdk.CfnOutput(this, 'McpEndpoint', {
      value: `${this.httpApi.url}mcp`,
      description: 'MCP endpoint URL - use this for Claude configuration',
    });

    new cdk.CfnOutput(this, 'ConnectionsTableOutput', {
      value: this.connectionsTable.tableName,
      description: 'DynamoDB table for MCP connections',
    });

    new cdk.CfnOutput(this, 'CustomDomainTarget', {
      value: customDomain.regionalDomainName,
      description: 'CNAME target for mcp.donate-mate.com',
    });

    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: 'https://mcp.donate-mate.com/mcp',
      description: 'Custom domain MCP endpoint URL',
    });

    // OAuth outputs
    new cdk.CfnOutput(this, 'OAuthUserPoolIdOutput', {
      value: this.oauthUserPool.userPoolId,
      description: 'MCP OAuth Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'OAuthClientIdOutput', {
      value: oauthClient.userPoolClientId,
      description: 'MCP OAuth Client ID for Claude.ai',
    });

    new cdk.CfnOutput(this, 'OAuthDomainOutput', {
      value: `https://${oauthDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito OAuth hosted UI domain',
    });

    new cdk.CfnOutput(this, 'OAuthMetadataUrl', {
      value: 'https://mcp.donate-mate.com/.well-known/oauth-protected-resource',
      description: 'OAuth Protected Resource Metadata URL (for Claude.ai)',
    });
  }
}
