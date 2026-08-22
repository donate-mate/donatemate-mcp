/**
 * DonateMate Hermes Stack
 *
 * Self-hosted agentic-coding platform:
 *  - Control plane: public ALB + Fargate service (Slack/Jira/MCP intake → job dispatch).
 *  - FE worker: Fargate service that runs Claude Code headless to open PRs.
 *  - Data plane: DynamoDB jobs, SQS (+DLQ), S3 artifacts, Secrets Manager, SSM exports.
 *
 * Optional stack — deploy with: --context deploy-hermes=true
 *
 * Container images are referenced from ECR by tag (not built by CDK), so the infra deploys
 * without Docker. Services default to desiredCount 0; flip up once images are pushed:
 *   --context hermes-control-plane-count=1 --context hermes-worker-count=1
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as customResources from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'node:path';

export type Environment = 'staging' | 'production';

const HERMES_CERTIFICATE_ARNS: Record<Environment, string> = {
  staging: 'arn:aws:acm:us-east-2:690788838096:certificate/8767f3d6-c259-4488-8943-a0c3870b5359',
  production: 'arn:aws:acm:us-east-2:690788838096:certificate/8767f3d6-c259-4488-8943-a0c3870b5359',
};

export interface HermesStackProps extends cdk.StackProps {
  environment: Environment;
  mcpEndpoint?: string;
}

export class HermesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: HermesStackProps) {
    super(scope, id, props);

    const { environment } = props;
    const isProd = environment === 'production';

    // Optimal steady-state defaults: control plane HA (2, multi-AZ); worker warm floor 1
    // (always-on, instant first job) autoscaling up to 4 on queue depth. Override via context
    // (e.g. hermes-worker-count=0 for cost-optimal scale-to-zero).
    const controlPlaneDesired = Number(this.node.tryGetContext('hermes-control-plane-count') ?? 2);
    const workerDesired = Number(this.node.tryGetContext('hermes-worker-count') ?? 1);
    const workerMax = Number(this.node.tryGetContext('hermes-worker-max') ?? 8);

    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    // ========================================================================
    // Data plane
    // ========================================================================
    const jobsTable = new dynamodb.Table(this, 'HermesJobs', {
      tableName: `donatemate-${environment}-hermes-jobs`,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProd },
    });
    jobsTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    const dlq = new sqs.Queue(this, 'HermesJobsDLQ', {
      queueName: `donatemate-${environment}-hermes-jobs-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const jobsQueue = new sqs.Queue(this, 'HermesJobsQueue', {
      queueName: `donatemate-${environment}-hermes-jobs`,
      visibilityTimeout: cdk.Duration.hours(6), // coding + post-merge mobile QA jobs can run long
      enforceSSL: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    const artifacts = new s3.Bucket(this, 'HermesArtifacts', {
      bucketName: `donatemate-${environment}-hermes-artifacts-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [{ expiration: cdk.Duration.days(isProd ? 365 : 30) }],
    });

    // ========================================================================
    // Secrets (imported by name) + ECR repos (imported)
    // ========================================================================
    const secGithub = secretsmanager.Secret.fromSecretNameV2(this, 'SecGithubApp', `donatemate/${environment}/hermes/github-app`);
    const secSlack = secretsmanager.Secret.fromSecretNameV2(this, 'SecSlack', `donatemate/${environment}/hermes/slack`);
    const secJiraHook = secretsmanager.Secret.fromSecretNameV2(this, 'SecJiraHook', `donatemate/${environment}/hermes/jira-webhook`);
    const secAnthropic = secretsmanager.Secret.fromSecretNameV2(this, 'SecAnthropic', `donatemate/${environment}/anthropic-api-key`);
    // OpenAI is primary; the independently funded Anthropic key is the automatic failover.
    const secOpenai = secretsmanager.Secret.fromSecretNameV2(this, 'SecOpenai', `donatemate/${environment}/hermes/openai`);
    const secJira = secretsmanager.Secret.fromSecretNameV2(this, 'SecJira', `/donatemate/${environment}/knowledge/jira`);
    // Dedicated hermes@ Atlassian account — write-backs (comments + transitions) post as Hermes.
    const secJiraBot = secretsmanager.Secret.fromSecretNameV2(this, 'SecJiraBot', `donatemate/${environment}/hermes/jira-bot`);
    const secDmMcp = secretsmanager.Secret.fromSecretNameV2(this, 'SecDmMcp', `donatemate/${environment}/hermes/dm-mcp-key`);

    const cpRepo = ecr.Repository.fromRepositoryName(this, 'CpRepo', 'donatemate-hermes-control-plane');
    const workerRepo = ecr.Repository.fromRepositoryName(this, 'WorkerRepo', 'donatemate-hermes-worker');

    // ========================================================================
    // Staging database investigation gateway (backend workers only)
    // ========================================================================
    // Keep the worker out of the database VPC and never expose application credentials to it.
    // Instead it may invoke one IAM-scoped Lambda in the staging VPC. A custom resource provisions
    // a dedicated PostgreSQL login with pg_read_all_data + default_transaction_read_only; the query
    // handler adds statement/row limits and a second read-only transaction boundary.
    let stagingDbQueryFunction: lambdaNodejs.NodejsFunction | undefined;
    if (!isProd) {
      const stagingDataVpc = ec2.Vpc.fromLookup(this, 'StagingDataVpc', {
        tags: { Name: 'donatemate-staging-vpc' },
      });
      const dbHost = ssm.StringParameter.valueForStringParameter(this, '/donatemate/staging/data/rds-endpoint');
      const dbPort = ssm.StringParameter.valueForStringParameter(this, '/donatemate/staging/data/rds-port');
      const dbName = ssm.StringParameter.valueForStringParameter(this, '/donatemate/staging/data/rds-database-name');
      const dbSecurityGroupId = ssm.StringParameter.valueForStringParameter(this, '/donatemate/staging/network/rds-sg-id');
      const masterSecretArn = ssm.StringParameter.valueForStringParameter(this, '/donatemate/staging/data/rds-secret-arn');
      const masterSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'StagingDbMasterSecret', masterSecretArn);
      const readerSecret = new secretsmanager.Secret(this, 'StagingDbReaderSecret', {
        secretName: 'donatemate/staging/hermes/db-reader',
        description: 'Database-enforced read-only PostgreSQL credentials for the Hermes staging query gateway',
        generateSecretString: {
          secretStringTemplate: this.toJsonString({
            host: dbHost,
            port: dbPort,
            dbname: dbName,
            username: 'hermes_staging_reader',
          }),
          generateStringKey: 'password',
          passwordLength: 40,
          excludePunctuation: true,
        },
        // Preserve an established credential on stack deletion/replacement, but clean up a brand-new
        // secret if its first deployment rolls back so a corrected deployment can recreate the name.
        removalPolicy: cdk.RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
      });

      const dbSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
        this,
        'StagingDatabaseSecurityGroup',
        dbSecurityGroupId,
        { mutable: true }
      );
      const querySecurityGroup = new ec2.SecurityGroup(this, 'StagingDbQuerySecurityGroup', {
        vpc: stagingDataVpc,
        description: 'Hermes staging read-only DB query Lambda',
        allowAllOutbound: false,
      });
      querySecurityGroup.addEgressRule(dbSecurityGroup, ec2.Port.tcp(5432), 'Read-only PostgreSQL queries');
      querySecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Secrets Manager through NAT');
      querySecurityGroup.addEgressRule(
        ec2.Peer.ipv4(stagingDataVpc.vpcCidrBlock),
        ec2.Port.udp(53),
        'VPC DNS resolution'
      );
      querySecurityGroup.addEgressRule(
        ec2.Peer.ipv4(stagingDataVpc.vpcCidrBlock),
        ec2.Port.tcp(53),
        'VPC DNS resolution fallback'
      );
      dbSecurityGroup.addIngressRule(querySecurityGroup, ec2.Port.tcp(5432), 'Hermes staging read-only query Lambda');

      const handlerRoot = path.join(__dirname, '..', '..', 'lambda-handlers', 'hermes-db-query', 'src');
      const lambdaDefaults: Partial<lambdaNodejs.NodejsFunctionProps> = {
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        vpc: stagingDataVpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [querySecurityGroup],
        memorySize: 256,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'node20',
          format: lambdaNodejs.OutputFormat.ESM,
          mainFields: ['module', 'main'],
          externalModules: ['@aws-sdk/*'],
        },
      };
      const readerInit = new lambdaNodejs.NodejsFunction(this, 'StagingDbReaderInit', {
        ...lambdaDefaults,
        functionName: 'donatemate-staging-hermes-db-reader-init',
        entry: path.join(handlerRoot, 'init.ts'),
        handler: 'handler',
        timeout: cdk.Duration.minutes(1),
        description: 'Provisions the database-enforced Hermes staging read-only login',
        environment: {
          MASTER_SECRET_ARN: masterSecret.secretArn,
          READER_SECRET_ARN: readerSecret.secretArn,
        },
      });
      masterSecret.grantRead(readerInit);
      readerSecret.grantRead(readerInit);
      const readerInitProvider = new customResources.Provider(this, 'StagingDbReaderInitProvider', {
        onEventHandler: readerInit,
        logRetention: logs.RetentionDays.ONE_MONTH,
      });
      const readerRole = new cdk.CustomResource(this, 'StagingDbReaderRole', {
        serviceToken: readerInitProvider.serviceToken,
        properties: { PolicyVersion: '1', ReaderSecretArn: readerSecret.secretArn },
      });

      stagingDbQueryFunction = new lambdaNodejs.NodejsFunction(this, 'StagingDbQueryFunction', {
        ...lambdaDefaults,
        functionName: 'donatemate-staging-hermes-db-query',
        entry: path.join(handlerRoot, 'index.ts'),
        handler: 'handler',
        timeout: cdk.Duration.seconds(20),
        reservedConcurrentExecutions: 2,
        description: 'IAM-only, database-enforced read-only staging PostgreSQL query gateway for Hermes',
        environment: {
          READER_SECRET_ARN: readerSecret.secretArn,
          STATEMENT_TIMEOUT_MS: '10000',
          DEFAULT_MAX_ROWS: '100',
          HARD_MAX_ROWS: '200',
          MAX_RESPONSE_BYTES: '750000',
        },
      });
      readerSecret.grantRead(stagingDbQueryFunction);
      stagingDbQueryFunction.node.addDependency(readerRole);
      new cdk.CfnOutput(this, 'HermesStagingDbQueryFunctionName', {
        value: stagingDbQueryFunction.functionName,
        description: 'IAM-only read-only staging database query function used by Hermes backend workers',
      });
    }

    // ========================================================================
    // ECS cluster
    // ========================================================================
    const cluster = new ecs.Cluster(this, 'HermesCluster', {
      vpc,
      clusterName: `donatemate-${environment}-hermes`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // ========================================================================
    // Control plane (ALB + Fargate)
    // ========================================================================
    const cpLogs = new logs.LogGroup(this, 'ControlPlaneLogs', {
      logGroupName: `/donatemate/${environment}/hermes/control-plane`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cpTaskDef = new ecs.FargateTaskDefinition(this, 'ControlPlaneTaskDef', {
      family: `donatemate-${environment}-hermes-control-plane`,
      cpu: 512,
      memoryLimitMiB: 1024,
    });
    cpTaskDef.addContainer('control-plane', {
      image: ecs.ContainerImage.fromEcrRepository(cpRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'cp', logGroup: cpLogs }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        ENVIRONMENT: environment,
        JOBS_TABLE: jobsTable.tableName,
        JOBS_QUEUE_URL: jobsQueue.queueUrl,
        ARTIFACTS_BUCKET: artifacts.bucketName,
        SECRET_SLACK: secSlack.secretName,
        SECRET_JIRA_WEBHOOK: secJiraHook.secretName,
        SECRET_GITHUB_APP: secGithub.secretName,
        SECRET_ANTHROPIC: secAnthropic.secretName, // planning/chat failover
        SECRET_OPENAI: secOpenai.secretName, // conversational/planning layer (OpenAI)
        CONVERSE_MODEL: 'gpt-5.6-terra', // planning + chat model (pinned)
        FALLBACK_CONVERSE_MODEL: 'claude-sonnet-5',
        OPENAI_CIRCUIT_BREAKER_SECONDS: '900',
        SECRET_JIRA: secJira.secretName, // read referenced Jira issues during conversation
        SECRET_JIRA_BOT: secJiraBot.secretName, // write-backs (plan/progress comments + transitions) as Hermes
        MCP_ENDPOINT: props.mcpEndpoint ?? 'https://mcp.donate-mate.com/mcp',
        PR_RECONCILE_SECONDS: '300',
        // Jira Automation can delay or suspend rule execution independently of Hermes. Poll
        // assignee-change events as a DynamoDB-deduped intake safety net.
        JIRA_ASSIGNMENT_RECONCILE_SECONDS: '300',
        JIRA_ASSIGNMENT_LOOKBACK_DAYS: '7',
        // Direct Jira REST fast lane keeps assignments and `/go`/refinement comments responsive
        // when Jira Automation's delivery queue is delayed. Durable event claims dedupe both paths.
        JIRA_FAST_POLL_SECONDS: '10',
        JIRA_FAST_LOOKBACK_MINUTES: '15',
        JIRA_FAST_CONCURRENCY: '4',
        QA_BUILD_WORKFLOW_ID: 'staging.yml',
        QA_AUTOMATION_ENABLED: 'false',
        BE_DEPLOY_WORKFLOW_ID: '208630294', // donate-mate/donatemate "Deploy to Staging"
        // --- WS5 control-plane orchestration flags (env-tunable, safe fallbacks) ---
        OVERLAP_COORDINATION_ENABLED: 'true', // WS5.1/5.2 cross-PR overlap + merge re-review
        CHECKLIST_ENABLED: 'true', // WS5.3 ticket checklist + readiness gate
        EVIDENCE_CHECK_ENABLED: 'true', // WS5.4 evidence-ID verification gate
        // Only trusted, addressed review feedback from merged PRs is promoted to durable memory.
        REVIEW_LEARNING_ENABLED: 'true',
        REVIEW_LEARNING_TTL_DAYS: '365',
        REVIEW_LEARNING_OPTOUT_LABEL: 'hermes-no-learn',
        REVIEW_LEARNING_MERGE_RETRY_MS: '1500',
        REVIEW_LEARNING_BACKFILL_DELAY_SECONDS: '60',
        REVIEW_LEARNING_BACKFILL_MAX_ATTEMPTS: '5',
        REVIEW_LEARNING_LEGACY_MIGRATION_DAYS: '30',
        HERMES_METRICS_NAMESPACE: 'DonateMate/Hermes',
      },
    });

    const cpService = new ecs.FargateService(this, 'ControlPlaneService', {
      cluster,
      serviceName: `donatemate-${environment}-hermes-control-plane`,
      taskDefinition: cpTaskDef,
      desiredCount: controlPlaneDesired,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
    });

    // Public ALB (HTTP only for now). Slack Events API needs HTTPS — add an ACM cert + 443
    // listener and a hermes.donate-mate.com CNAME before wiring Slack (tracked in the plan).
    const alb = new elbv2.ApplicationLoadBalancer(this, 'HermesAlb', {
      vpc,
      internetFacing: true,
      loadBalancerName: `dm-${environment}-hermes`,
    });
    const controlPlaneTg = new elbv2.ApplicationTargetGroup(this, 'ControlPlaneTG', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [cpService.loadBalancerTarget({ containerName: 'control-plane', containerPort: 3000 })],
      healthCheck: { path: '/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30) },
      deregistrationDelay: cdk.Duration.seconds(15),
    });

    // Serve HTTPS on 443 and redirect 80→443. The context override is kept for cert rotation,
    // but staging/production default to the issued hermes.donate-mate.com certificate.
    const certArn = (this.node.tryGetContext('hermes-cert-arn') as string | undefined) ?? HERMES_CERTIFICATE_ARNS[environment];
    if (certArn) {
      alb.addListener('HttpsListener', {
        port: 443,
        certificates: [elbv2.ListenerCertificate.fromArn(certArn)],
        defaultTargetGroups: [controlPlaneTg],
      });
      // Same construct id as the no-cert path so CFN modifies the port-80 listener in place
      // (forward → redirect) instead of creating a second listener on port 80.
      alb.addListener('HttpListener', {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });
    } else {
      alb.addListener('HttpListener', { port: 80, defaultTargetGroups: [controlPlaneTg] });
    }

    jobsTable.grantReadWriteData(cpTaskDef.taskRole);
    jobsQueue.grantSendMessages(cpTaskDef.taskRole);
    secSlack.grantRead(cpTaskDef.taskRole);
    secJiraHook.grantRead(cpTaskDef.taskRole);
    secGithub.grantRead(cpTaskDef.taskRole);
    secAnthropic.grantRead(cpTaskDef.taskRole);
    secOpenai.grantRead(cpTaskDef.taskRole);
    secJira.grantRead(cpTaskDef.taskRole);
    secJiraBot.grantRead(cpTaskDef.taskRole);

    // ========================================================================
    // FE worker (Fargate service, no inbound; pulls jobs from SQS)
    // ========================================================================
    const workerLogs = new logs.LogGroup(this, 'FeWorkerLogs', {
      logGroupName: `/donatemate/${environment}/hermes/fe-worker`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'FeWorkerTaskDef', {
      family: `donatemate-${environment}-hermes-fe-worker`,
      cpu: 2048,
      memoryLimitMiB: 8192,
      ephemeralStorageGiB: 40, // room for clean clones + node_modules
    });
    workerTaskDef.addContainer('fe-worker', {
      image: ecs.ContainerImage.fromEcrRepository(workerRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fe-worker', logGroup: workerLogs }),
      environment: {
        ENVIRONMENT: environment,
        AWS_REGION: this.region,
        AWS_DEFAULT_REGION: this.region,
        WORKER_TYPE: 'fe',
        JOBS_TABLE: jobsTable.tableName,
        JOBS_QUEUE_URL: jobsQueue.queueUrl,
        ARTIFACTS_BUCKET: artifacts.bucketName,
        SECRET_GITHUB_APP: secGithub.secretName,
        SECRET_OPENAI: secOpenai.secretName, // coding engine (Codex CLI) auth
        SECRET_ANTHROPIC: secAnthropic.secretName, // Claude Code failover auth
        AGENT_MODEL: 'gpt-5.5', // coding model (pinned)
        FALLBACK_AGENT_MODEL: 'claude-sonnet-5',
        OPENAI_CIRCUIT_BREAKER_SECONDS: '900',
        SECRET_JIRA: secJira.secretName,
        SECRET_JIRA_BOT: secJiraBot.secretName, // progress comments + column moves as Hermes
        SECRET_SLACK: secSlack.secretName, // worker posts PR links back to the Slack thread
        SECRET_DM_MCP: secDmMcp.secretName, // DonateMate MCP API key for the agent
        MCP_ENDPOINT: 'https://mcp.donate-mate.com/mcp',
        // Hard timeout is the budget guardrail for the Codex run.
        JOB_TIMEOUT_SECONDS: '2400',
        // ECS can reject lease renewals with DEPLOYMENT_BLOCKED once a rollout starts. Keep the
        // initial lease long enough for normal jobs, and renew it while the service permits.
        TASK_PROTECTION_EXPIRES_MINUTES: '165',
        TASK_PROTECTION_RENEW_SECONDS: '600',
        // --- Hermes PR-process enhancements (WS1–WS4), all env-tunable with safe fallbacks ---
        AGENT_REASONING_EFFORT: 'medium', // WS3.1 Codex model_reasoning_effort for implementation jobs
        PREOPEN_REVIEW_ENABLED: 'true', // WS4 pre-open adversarial review stage
        PREOPEN_REVIEW_EFFORT: 'high', // WS4 review runs at high reasoning effort
        GATE_MAX_RETRIES: '3', // WS2 pre-commit gate repair rounds before fail-open
        GATE_CMD_TIMEOUT_SECONDS: '1200', // backend Turbo dependency graphs can exceed 10 minutes
        GATE_BUILD_TIMEOUT_SECONDS: '600', // fail open to authoritative CI on a cold Turbo graph
        REVIEW_LEARNING_ENABLED: 'true',
        REVIEW_LEARNING_TOP_K: '5',
        REVIEW_LEARNING_TIMEOUT_MS: '1500',
        REVIEW_LEARNING_MAX_CANDIDATES: '100',
        WORKSPACE_INSTALL_TIMEOUT_SECONDS: '600', // WS1 dependency-install budget
        HERMES_CACHE_DIR: '/opt/hermes-cache', // WS1 warm yarn/turbo cache baked by the nightly image
        HERMES_METRICS_NAMESPACE: 'DonateMate/Hermes', // WS2 CloudWatch metrics namespace
        QA_BUILD_WORKFLOW_ID: 'staging.yml',
        QA_EXECUTION_WORKFLOW_ID: 'hermes-qa.yml',
        QA_AUTOMATION_ENABLED: 'false',
        QA_BUILD_WAIT_SECONDS: '7200',
        QA_EXECUTION_WAIT_SECONDS: '7200',
        QA_POLL_SECONDS: '60',
        BE_DEPLOY_WORKFLOW_ID: '208630294', // donate-mate/donatemate "Deploy to Staging"
        DEPLOY_WAIT_SECONDS: '7200',
        DEPLOY_POLL_SECONDS: '60',
        JIRA_BROWSE_BASE_URL: 'https://donatemate.atlassian.net',
        FE_TESTFLIGHT_FIX_VERSION: 'v61.0.0',
        FE_TESTFLIGHT_RELEASE_VERSION: 'v61.0.0',
        QA_ASSIGNEE_ACCOUNT_ID: '712020:1782f20d-c1fc-4831-ac3f-925cc0773332',
        QA_ASSIGNEE_NAME: 'Patrick Sheehy',
        QA_ASSIGNEE_EMAIL: 'patrick.sheehy@donate-mate.com',
        QA_SLACK_CHANNEL: '#qa',
        // Slack mentions require a member ID token such as <@U123>; display names do not notify.
        QA_SLACK_MENTION: '',
        BE_QA_ASSIGNEE_ACCOUNT_ID: '712020:5168d41e-0688-4f0d-8e00-a3e2048c556e',
        BE_QA_ASSIGNEE_NAME: 'Andrew Sheehy',
        BE_QA_ASSIGNEE_EMAIL: 'andrew.sheehy@donate-mate.com',
        // Slack mentions require a member ID token such as <@U123>; display names do not notify.
        BE_QA_SLACK_MENTION: '',
        HERMES_STAGING_DB_QUERY_FUNCTION: stagingDbQueryFunction?.functionName ?? '',
      },
    });

    const feWorker = new ecs.FargateService(this, 'HermesFeWorker', {
      cluster,
      serviceName: `donatemate-${environment}-hermes-fe-worker`,
      taskDefinition: workerTaskDef,
      desiredCount: workerDesired,
      assignPublicIp: true, // default VPC has public subnets only; needs egress for ECR/GitHub/Anthropic
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    jobsTable.grantReadWriteData(workerTaskDef.taskRole);
    jobsQueue.grantConsumeMessages(workerTaskDef.taskRole);
    artifacts.grantReadWrite(workerTaskDef.taskRole);
    secGithub.grantRead(workerTaskDef.taskRole);
    secOpenai.grantRead(workerTaskDef.taskRole);
    secAnthropic.grantRead(workerTaskDef.taskRole);
    secJira.grantRead(workerTaskDef.taskRole);
    secJiraBot.grantRead(workerTaskDef.taskRole);
    secSlack.grantRead(workerTaskDef.taskRole);
    secDmMcp.grantRead(workerTaskDef.taskRole);
    stagingDbQueryFunction?.grantInvoke(workerTaskDef.taskRole);

    // WS2 — publish Hermes PR-pipeline metrics (DonateMate/Hermes namespace). PutMetricData has no
    // resource-level scoping, so it is granted broadly (constrained to the namespace at call time).
    const putMetricStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    });
    workerTaskDef.taskRole.addToPrincipalPolicy(putMetricStatement);
    cpTaskDef.taskRole.addToPrincipalPolicy(putMetricStatement);

    // Backend defect/alert jobs need read-only production/staging observability. The agent uses
    // AWS CLI evidence to distinguish false positives, noisy alarms, and real source defects.
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:DescribeAlarms',
          'cloudwatch:DescribeAlarmHistory',
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
          'logs:FilterLogEvents',
          'logs:GetLogEvents',
          'logs:StartQuery',
          'logs:GetQueryResults',
          'logs:StopQuery',
          'synthetics:DescribeCanaries',
          'synthetics:DescribeCanariesLastRun',
          'synthetics:GetCanary',
          'synthetics:GetCanaryRuns',
          'synthetics:ListTagsForResource',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:ListFunctions',
          'apigateway:GET',
          'states:DescribeStateMachine',
          'states:DescribeExecution',
          'states:GetExecutionHistory',
          'states:ListExecutions',
          'states:ListStateMachines',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:ListStackResources',
          'codebuild:BatchGetBuilds',
          'codebuild:ListBuildsForProject',
          'codebuild:ListProjects',
          'codepipeline:GetPipeline',
          'codepipeline:GetPipelineExecution',
          'codepipeline:GetPipelineState',
          'codepipeline:ListPipelineExecutions',
          'codepipeline:ListPipelines',
          'events:DescribeRule',
          'events:ListRules',
          'events:ListTargetsByRule',
          'ecs:DescribeServices',
          'ecs:DescribeTasks',
          'ecs:DescribeTaskDefinition',
          'ecs:ListServices',
          'ecs:ListTasks',
          'xray:BatchGetTraces',
          'xray:GetTraceSummaries',
        ],
        resources: ['*'],
      })
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListAllMyBuckets', 's3:GetBucketLocation'],
        resources: ['*'],
      })
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [
          'arn:aws:s3:::donatemate-*-synthetics-artifacts',
          'arn:aws:s3:::cw-syn-results-*',
        ],
      })
    );
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [
          'arn:aws:s3:::donatemate-*-synthetics-artifacts/*',
          'arn:aws:s3:::cw-syn-results-*/*',
        ],
      })
    );

    // The worker protects its own task from scale-in while it's processing a job, so the
    // autoscaler can scale down after a burst without killing an active coding job.
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecs:UpdateTaskProtection'],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:task/donatemate-${environment}-hermes/*`],
      })
    );

    // Autoscale the shared worker fleet to the TOTAL outstanding work (queued + in flight). Using
    // only visible messages made the alarm drop as soon as a worker received a job, and the default
    // five-minute SQS period made burst response much slower than the Jira interaction target.
    // Exact-capacity steps avoid repeatedly adding workers while the alarm remains active: N jobs
    // asks for N workers, bounded by the configured warm floor and maximum.
    const scaling = feWorker.autoScaleTaskCount({ minCapacity: workerDesired, maxCapacity: workerMax });
    if (workerMax > workerDesired) {
      const queuePeriod = cdk.Duration.minutes(1);
      const outstandingJobs = new cloudwatch.MathExpression({
        expression: 'FILL(visible, 0) + FILL(inFlight, 0)',
        usingMetrics: {
          visible: jobsQueue.metricApproximateNumberOfMessagesVisible({ period: queuePeriod, statistic: 'Maximum' }),
          inFlight: jobsQueue.metricApproximateNumberOfMessagesNotVisible({ period: queuePeriod, statistic: 'Maximum' }),
        },
        period: queuePeriod,
        label: 'Hermes outstanding jobs',
      });
      const scalingSteps: appscaling.ScalingInterval[] = [
        { upper: workerDesired + 1, change: workerDesired },
        ...Array.from({ length: Math.max(0, workerMax - workerDesired - 1) }, (_, index) => {
          const capacity = workerDesired + index + 1;
          return { lower: capacity, upper: capacity + 1, change: capacity };
        }),
        { lower: workerMax, change: workerMax },
      ];
      scaling.scaleOnMetric('FeWorkerOutstandingWorkScaling', {
        metric: outstandingJobs,
        adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
        cooldown: cdk.Duration.seconds(30),
        evaluationPeriods: 1,
        scalingSteps,
      });
    }

    // ========================================================================
    // CloudWatch dashboard for the PR-process enhancement metrics (deliverable #6).
    // Baselines (measure one week of staging against these): avg ~2.4 CI fix cycles/PR (worst 6),
    // ~3 blocking human review findings/PR, 0% locally-executed tests.
    // ========================================================================
    const dashboard = new cloudwatch.Dashboard(this, 'HermesDashboard', {
      dashboardName: `donatemate-${environment}-hermes`,
    });
    const hMetric = (metricName: string, statistic: string, label: string) =>
      new cloudwatch.Metric({
        namespace: 'DonateMate/Hermes',
        metricName,
        dimensionsMap: { Environment: environment },
        statistic,
        period: cdk.Duration.hours(6),
        label,
      });
    const baseline = (value: number, label: string): cloudwatch.HorizontalAnnotation => ({
      value,
      label,
      color: cloudwatch.Color.RED,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'WS2 · Pre-commit gate cycles per PR (baseline avg 2.4 CI fix cycles)',
        left: [hMetric('HermesGateCycles', 'Average', 'gate cycles (avg)'), hMetric('HermesGateCycles', 'Maximum', 'gate cycles (max)')],
        leftAnnotations: [baseline(2.4, 'baseline avg CI fix cycles')],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Post-open CI/review auto-repair attempts (baseline worst 6)',
        left: [hMetric('HermesCiFixAttempts', 'Sum', 'ci fix attempts')],
        leftAnnotations: [baseline(6, 'baseline worst-case cycles')],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'WS4 · Pre-open review findings (baseline ~3 blocking human findings/PR)',
        left: [
          hMetric('HermesPreopenFindings', 'Average', 'findings (avg)'),
          hMetric('HermesPreopenBlocking', 'Average', 'blocking (avg)'),
        ],
        leftAnnotations: [baseline(3, 'baseline blocking human findings/PR')],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'WS1 · Toolchain install time + gate-failures shipped (fail-open count)',
        left: [hMetric('HermesInstallSeconds', 'Average', 'install seconds (avg)')],
        right: [hMetric('HermesGateFailShipped', 'Sum', 'gate-failures shipped')],
        width: 12,
        height: 6,
      })
    );
    new cdk.CfnOutput(this, 'HermesDashboardName', { value: dashboard.dashboardName });

    // ========================================================================
    // SSM exports + outputs
    // ========================================================================
    new ssm.StringParameter(this, 'QueueUrlParam', {
      parameterName: `/donatemate/${environment}/hermes/queue-url`,
      stringValue: jobsQueue.queueUrl,
    });
    new ssm.StringParameter(this, 'JobsTableParam', {
      parameterName: `/donatemate/${environment}/hermes/jobs-table`,
      stringValue: jobsTable.tableName,
    });
    new ssm.StringParameter(this, 'ControlPlaneDnsParam', {
      parameterName: `/donatemate/${environment}/hermes/control-plane-dns`,
      stringValue: alb.loadBalancerDnsName,
    });

    const publicBaseUrl = certArn ? 'https://hermes.donate-mate.com' : `http://${alb.loadBalancerDnsName}`;
    new cdk.CfnOutput(this, 'ControlPlaneUrl', { value: publicBaseUrl });
    new cdk.CfnOutput(this, 'SlackEventsUrl', { value: `${publicBaseUrl}/slack/events` });
    new cdk.CfnOutput(this, 'GitHubWebhookUrl', { value: `${publicBaseUrl}/github/webhook` });
    new cdk.CfnOutput(this, 'JobsQueueUrlOut', { value: jobsQueue.queueUrl });
    new cdk.CfnOutput(this, 'ArtifactsBucketOut', { value: artifacts.bucketName });
    new cdk.CfnOutput(this, 'ControlPlaneImageOut', { value: `${cpRepo.repositoryUri}:latest` });
    new cdk.CfnOutput(this, 'FeWorkerImageOut', { value: `${workerRepo.repositoryUri}:latest` });
  }
}
