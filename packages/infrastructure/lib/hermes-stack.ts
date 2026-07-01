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
import { Construct } from 'constructs';

export type Environment = 'staging' | 'production';

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
    const workerMax = Number(this.node.tryGetContext('hermes-worker-max') ?? 4);

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
      visibilityTimeout: cdk.Duration.hours(1), // coding jobs can run long
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
    // OpenAI API key — coding engine (Codex CLI) + planning/chat layer.
    const secOpenai = secretsmanager.Secret.fromSecretNameV2(this, 'SecOpenai', `donatemate/${environment}/hermes/openai`);
    const secJira = secretsmanager.Secret.fromSecretNameV2(this, 'SecJira', `/donatemate/${environment}/knowledge/jira`);
    // Dedicated hermes@ Atlassian account — write-backs (comments + transitions) post as Hermes.
    const secJiraBot = secretsmanager.Secret.fromSecretNameV2(this, 'SecJiraBot', `donatemate/${environment}/hermes/jira-bot`);
    const secDmMcp = secretsmanager.Secret.fromSecretNameV2(this, 'SecDmMcp', `donatemate/${environment}/hermes/dm-mcp-key`);

    const cpRepo = ecr.Repository.fromRepositoryName(this, 'CpRepo', 'donatemate-hermes-control-plane');
    const workerRepo = ecr.Repository.fromRepositoryName(this, 'WorkerRepo', 'donatemate-hermes-worker');

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
        SECRET_ANTHROPIC: secAnthropic.secretName, // (legacy) Anthropic key, no longer used
        SECRET_OPENAI: secOpenai.secretName, // conversational/planning layer (OpenAI)
        CONVERSE_MODEL: 'gpt-5.3-chat-latest', // planning + chat model (pinned)
        SECRET_JIRA: secJira.secretName, // read referenced Jira issues during conversation
        SECRET_JIRA_BOT: secJiraBot.secretName, // write-backs (plan/progress comments + transitions) as Hermes
        MCP_ENDPOINT: props.mcpEndpoint ?? 'https://mcp.donate-mate.com/mcp',
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

    // When a cert ARN is supplied (--context hermes-cert-arn=...), serve HTTPS on 443 and
    // redirect 80→443 (Slack Events API requires HTTPS). Otherwise plain HTTP on 80.
    const certArn = this.node.tryGetContext('hermes-cert-arn') as string | undefined;
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
        WORKER_TYPE: 'fe',
        JOBS_TABLE: jobsTable.tableName,
        JOBS_QUEUE_URL: jobsQueue.queueUrl,
        ARTIFACTS_BUCKET: artifacts.bucketName,
        SECRET_GITHUB_APP: secGithub.secretName,
        SECRET_OPENAI: secOpenai.secretName, // coding engine (Codex CLI) auth
        AGENT_MODEL: 'gpt-5.5', // coding model (pinned)
        SECRET_JIRA: secJira.secretName,
        SECRET_JIRA_BOT: secJiraBot.secretName, // progress comments + column moves as Hermes
        SECRET_SLACK: secSlack.secretName, // worker posts PR links back to the Slack thread
        SECRET_DM_MCP: secDmMcp.secretName, // DonateMate MCP API key for the agent
        MCP_ENDPOINT: 'https://mcp.donate-mate.com/mcp',
        // Hard timeout is the budget guardrail for the Codex run.
        JOB_TIMEOUT_SECONDS: '2400',
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
    secJira.grantRead(workerTaskDef.taskRole);
    secJiraBot.grantRead(workerTaskDef.taskRole);
    secSlack.grantRead(workerTaskDef.taskRole);
    secDmMcp.grantRead(workerTaskDef.taskRole);

    // The worker protects its own task from scale-in while it's processing a job, so the
    // autoscaler can scale down after a burst without killing an active coding job.
    workerTaskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ecs:UpdateTaskProtection'],
        resources: [`arn:aws:ecs:${this.region}:${this.account}:task/donatemate-${environment}-hermes/*`],
      })
    );

    // Autoscale FE worker on queue depth: scale OUT on backlog, scale IN to the warm floor
    // when the queue is empty (busy tasks are protected, so scale-in only removes idle ones).
    const scaling = feWorker.autoScaleTaskCount({ minCapacity: workerDesired, maxCapacity: workerMax });
    scaling.scaleOnMetric('FeWorkerQueueScaling', {
      metric: jobsQueue.metricApproximateNumberOfMessagesVisible(),
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(120),
      scalingSteps: [
        { upper: 0, change: -1 },
        { lower: 1, change: +1 },
        { lower: 5, change: +2 },
      ],
    });

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

    new cdk.CfnOutput(this, 'ControlPlaneUrl', { value: `http://${alb.loadBalancerDnsName}` });
    new cdk.CfnOutput(this, 'SlackEventsUrl', { value: `http://${alb.loadBalancerDnsName}/slack/events`, description: 'Needs HTTPS before Slack will accept it' });
    new cdk.CfnOutput(this, 'JobsQueueUrlOut', { value: jobsQueue.queueUrl });
    new cdk.CfnOutput(this, 'ArtifactsBucketOut', { value: artifacts.bucketName });
    new cdk.CfnOutput(this, 'ControlPlaneImageOut', { value: `${cpRepo.repositoryUri}:latest` });
    new cdk.CfnOutput(this, 'FeWorkerImageOut', { value: `${workerRepo.repositoryUri}:latest` });
  }
}
