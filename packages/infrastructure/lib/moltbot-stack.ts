/**
 * DonateMate Moltbot Stack
 *
 * Linux EC2 instance running Moltbot (Claude-powered AI assistant).
 * Connects to messaging channels (Slack, Telegram, Discord) and
 * uses DonateMate MCP API for Figma operations.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export type Environment = 'staging' | 'production';

export interface MoltbotStackProps extends cdk.StackProps {
  environment: Environment;
  /** VPC to deploy the EC2 instance in */
  vpc?: ec2.IVpc;
  /** MCP API endpoint */
  mcpEndpoint?: string;
}

export class MoltbotStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: MoltbotStackProps) {
    super(scope, id, props);

    const { environment } = props;
    const mcpEndpoint = props.mcpEndpoint || 'https://mcp.donate-mate.com/mcp';

    // ========================================================================
    // VPC - Use default VPC or provided one
    // ========================================================================

    const vpc = props.vpc ?? ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // ========================================================================
    // Security Group - Outbound HTTPS only, SSH for management
    // ========================================================================

    const securityGroup = new ec2.SecurityGroup(this, 'MoltbotSg', {
      vpc,
      description: 'Moltbot security group - outbound HTTPS only',
      allowAllOutbound: false,
    });

    // Allow outbound HTTPS (for Anthropic API, Slack API, MCP API)
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound'
    );

    // Allow outbound HTTP (for package managers)
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP outbound'
    );

    // SSH access (for staging setup - use SSM Session Manager in production)
    if (environment === 'staging') {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(22),
        'Allow SSH for setup'
      );
    }

    // ========================================================================
    // IAM Role for EC2 Instance
    // ========================================================================

    const role = new iam.Role(this, 'MoltbotRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for Moltbot VM to access SSM and secrets',
      managedPolicies: [
        // SSM for remote management (Session Manager)
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Allow reading and writing SSM Parameter Store
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:GetParametersByPath',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/donatemate/${environment}/*`,
        ],
      })
    );

    // S3: List all buckets and read/write DonateMate buckets
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListAllMyBuckets', 's3:GetBucketLocation'],
        resources: ['*'],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:ListBucket',
        ],
        resources: [
          `arn:aws:s3:::donatemate-*`,
          `arn:aws:s3:::donatemate-*/*`,
        ],
      })
    );

    // Lambda: List, describe, and invoke functions
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'lambda:ListFunctions',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:InvokeFunction',
        ],
        resources: ['*'],
      })
    );

    // DynamoDB: Read access to all tables
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:ListTables',
          'dynamodb:DescribeTable',
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:Scan',
        ],
        resources: ['*'],
      })
    );

    // Secrets Manager: Read secrets (not create/delete)
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:ListSecrets',
          'secretsmanager:GetSecretValue',
          'secretsmanager:DescribeSecret',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch Logs: Read logs
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:DescribeLogGroups',
          'logs:DescribeLogStreams',
          'logs:GetLogEvents',
          'logs:FilterLogEvents',
        ],
        resources: ['*'],
      })
    );

    // CloudWatch Metrics: Read metrics
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:GetMetricStatistics',
          'cloudwatch:ListMetrics',
        ],
        resources: ['*'],
      })
    );

    // CloudFormation: Read-only access
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackResources',
          'cloudformation:ListStacks',
        ],
        resources: ['*'],
      })
    );

    // EC2: Describe instances (for self-awareness)
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeVpcs',
        ],
        resources: ['*'],
      })
    );

    // ========================================================================
    // Amazon Linux 2023 AMI
    // ========================================================================

    const amazonLinux = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.X86_64,
    });

    // ========================================================================
    // User Data Script - Install Node.js and Moltbot
    // ========================================================================

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      '',
      '# Update system',
      'dnf update -y',
      '',
      '# Install Node.js 22',
      'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
      'dnf install -y nodejs',
      '',
      '# Install Git and jq',
      'dnf install -y git jq',
      '',
      '# Create moltbot user',
      'useradd -m -s /bin/bash moltbot || true',
      '',
      '# Create directories',
      'mkdir -p /home/moltbot/.clawdbot/skills',
      '',
      '# Install Clawdbot globally',
      'npm install -g clawdbot@latest',
      '',
      '# Install DonateMate skill',
      'npm install -g @donatemate/moltbot-skill@latest || true',
      '',
      '# Create symlink for moltbot -> clawdbot',
      'ln -sf /usr/lib/node_modules/clawdbot/dist/entry.js /usr/bin/clawdbot || true',
      '',
      '# Write marker file',
      'echo "Moltbot setup completed at $(date)" > /home/moltbot/setup-complete.txt',
      '',
      '# Set ownership',
      'chown -R moltbot:moltbot /home/moltbot',
      '',
      '# Create script to fetch SSM parameters and write env file',
      'cat > /usr/local/bin/clawdbot-env-setup << \'ENVSCRIPT\'',
      '#!/bin/bash',
      'set -e',
      'REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)',
      `ENV_PREFIX="/donatemate/${environment}/moltbot"`,
      '',
      'get_param() {',
      '  aws ssm get-parameter --name "$1" --with-decryption --region "$REGION" --query "Parameter.Value" --output text 2>/dev/null || echo ""',
      '}',
      '',
      'cat > /home/moltbot/.clawdbot/env << EOF',
      'NODE_ENV=production',
      'DM_MCP_ENDPOINT=$(get_param "$ENV_PREFIX/mcp-endpoint")',
      'DM_API_KEY=$(get_param "$ENV_PREFIX/mcp-api-key")',
      'ANTHROPIC_API_KEY=$(get_param "$ENV_PREFIX/anthropic-api-key")',
      'SLACK_BOT_TOKEN=$(get_param "$ENV_PREFIX/slack-bot-token")',
      'SLACK_APP_TOKEN=$(get_param "$ENV_PREFIX/slack-app-token")',
      'EOF',
      '',
      'chown moltbot:moltbot /home/moltbot/.clawdbot/env',
      'chmod 600 /home/moltbot/.clawdbot/env',
      'ENVSCRIPT',
      'chmod +x /usr/local/bin/clawdbot-env-setup',
      '',
      '# Run env setup initially',
      '/usr/local/bin/clawdbot-env-setup',
      '',
      '# Create systemd service for Moltbot',
      'cat > /etc/systemd/system/moltbot.service << \'SERVICEEOF\'',
      '[Unit]',
      'Description=Clawdbot Gateway',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=moltbot',
      'WorkingDirectory=/home/moltbot',
      'EnvironmentFile=/home/moltbot/.clawdbot/env',
      'ExecStartPre=/usr/local/bin/clawdbot-env-setup',
      'ExecStart=/usr/bin/clawdbot gateway --verbose',
      'Restart=always',
      'RestartSec=10',
      'StandardOutput=journal',
      'StandardError=journal',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      'SERVICEEOF',
      '',
      '# Reload systemd, enable and start service',
      'systemctl daemon-reload',
      'systemctl enable moltbot',
      'systemctl start moltbot',
      '',
      'echo "Moltbot installation complete and service started."',
    );

    // ========================================================================
    // EC2 Instance
    // ========================================================================

    this.instance = new ec2.Instance(this, 'MoltbotVm', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL // 2 vCPU, 2GB RAM - sufficient for Moltbot
      ),
      machineImage: amazonLinux,
      securityGroup,
      role,
      userData,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC, // Needs internet access
      },
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      instanceName: `donatemate-${environment}-moltbot`,
    });

    // ========================================================================
    // SSM Parameters for Moltbot Configuration
    // ========================================================================

    // Store instance ID
    new ssm.StringParameter(this, 'MoltbotInstanceId', {
      parameterName: `/donatemate/${environment}/moltbot/instance-id`,
      stringValue: this.instance.instanceId,
      description: 'Moltbot EC2 instance ID',
    });

    // MCP endpoint
    new ssm.StringParameter(this, 'MoltbotMcpEndpoint', {
      parameterName: `/donatemate/${environment}/moltbot/mcp-endpoint`,
      stringValue: mcpEndpoint,
      description: 'DonateMate MCP API endpoint',
    });

    // Placeholder for Slack Bot Token (to be set manually)
    new ssm.StringParameter(this, 'MoltbotSlackToken', {
      parameterName: `/donatemate/${environment}/moltbot/slack-bot-token`,
      stringValue: 'PLACEHOLDER_SET_VIA_CONSOLE',
      description: 'Slack Bot Token for Moltbot (set via AWS Console)',
    });

    // Placeholder for Slack App Token (to be set manually)
    new ssm.StringParameter(this, 'MoltbotSlackAppToken', {
      parameterName: `/donatemate/${environment}/moltbot/slack-app-token`,
      stringValue: 'PLACEHOLDER_SET_VIA_CONSOLE',
      description: 'Slack App Token for Moltbot (set via AWS Console)',
    });

    // Placeholder for Anthropic API Key (to be set manually)
    new ssm.StringParameter(this, 'MoltbotAnthropicKey', {
      parameterName: `/donatemate/${environment}/moltbot/anthropic-api-key`,
      stringValue: 'PLACEHOLDER_SET_VIA_CONSOLE',
      description: 'Anthropic API Key for Moltbot (set via AWS Console)',
    });

    // Placeholder for DonateMate MCP API Key (to be set manually)
    new ssm.StringParameter(this, 'MoltbotMcpApiKey', {
      parameterName: `/donatemate/${environment}/moltbot/mcp-api-key`,
      stringValue: 'PLACEHOLDER_SET_VIA_CONSOLE',
      description: 'DonateMate MCP API Key (set via AWS Console)',
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'Moltbot EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: this.instance.instancePublicIp,
      description: 'Moltbot public IP',
    });

    new cdk.CfnOutput(this, 'SsmConnectCommand', {
      value: `aws ssm start-session --target ${this.instance.instanceId}`,
      description: 'SSM Session Manager connect command',
    });

    new cdk.CfnOutput(this, 'SetupInstructions', {
      value: 'See /donatemate/packages/moltbot-skill/README.md for setup instructions',
      description: 'Setup instructions location',
    });
  }
}
