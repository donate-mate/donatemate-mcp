/**
 * DonateMate Figma VM Stack
 *
 * Windows EC2 instance running Figma Desktop with the relay agent.
 * Connects outbound to the MCP WebSocket API.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export type Environment = 'staging' | 'production';

export interface FigmaVmStackProps extends cdk.StackProps {
  environment: Environment;
  /** VPC to deploy the EC2 instance in */
  vpc?: ec2.IVpc;
  /** WebSocket API endpoint for the relay to connect to */
  wsEndpoint?: string;
}

export class FigmaVmStack extends cdk.Stack {
  public readonly instance: ec2.Instance;

  constructor(scope: Construct, id: string, props: FigmaVmStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // ========================================================================
    // VPC - Use default VPC or create a simple one
    // ========================================================================

    const vpc = props.vpc ?? ec2.Vpc.fromLookup(this, 'DefaultVpc', {
      isDefault: true,
    });

    // ========================================================================
    // Security Group - Outbound HTTPS only, RDP for management
    // ========================================================================

    const securityGroup = new ec2.SecurityGroup(this, 'FigmaVmSg', {
      vpc,
      description: 'Figma VM security group - outbound HTTPS only',
      allowAllOutbound: false,
    });

    // Allow outbound HTTPS (for Figma, AWS APIs, npm)
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS outbound'
    );

    // Allow outbound HTTP (for some package managers)
    securityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP outbound'
    );

    // RDP access (optional, for initial setup - restrict in production)
    if (environment === 'staging') {
      securityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(3389),
        'Allow RDP for setup'
      );
    }

    // ========================================================================
    // IAM Role for EC2 Instance
    // ========================================================================

    const role = new iam.Role(this, 'FigmaVmRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for Figma VM to access SSM and other AWS services',
      managedPolicies: [
        // SSM for remote management (Session Manager)
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Allow reading the WebSocket endpoint and auth token from SSM
    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/donatemate/${environment}/*`,
        ],
      })
    );

    // ========================================================================
    // Windows AMI
    // ========================================================================

    const windowsAmi = ec2.MachineImage.latestWindows(
      ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE
    );

    // ========================================================================
    // User Data Script - Install Node.js
    // ========================================================================

    const userData = ec2.UserData.forWindows();
    userData.addCommands(
      // Install Chocolatey
      `Set-ExecutionPolicy Bypass -Scope Process -Force`,
      `[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072`,
      `iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))`,
      '',
      // Install Node.js
      `choco install nodejs-lts -y`,
      '',
      // Create directory for relay agent
      `New-Item -ItemType Directory -Force -Path C:\\figma-relay`,
      '',
      // Write marker file
      `Set-Content -Path C:\\figma-relay\\setup-complete.txt -Value "Setup completed at $(Get-Date)"`,
      '',
      // Note: Relay agent code needs to be deployed separately or via S3
      `Write-Host "Figma VM setup complete. Deploy relay agent to C:\\figma-relay"`
    );

    // ========================================================================
    // EC2 Instance
    // ========================================================================

    this.instance = new ec2.Instance(this, 'FigmaVm', {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MEDIUM // 2 vCPU, 4GB RAM - adequate for Figma
      ),
      machineImage: windowsAmi,
      securityGroup,
      role,
      userData,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC, // Needs internet access
      },
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      instanceName: `donatemate-${environment}-figma-vm`,
    });

    // ========================================================================
    // SSM Parameters
    // ========================================================================

    // Store instance ID for reference
    new ssm.StringParameter(this, 'FigmaVmInstanceId', {
      parameterName: `/donatemate/${environment}/figma-vm/instance-id`,
      stringValue: this.instance.instanceId,
      description: 'Figma VM EC2 instance ID',
    });

    // ========================================================================
    // Outputs
    // ========================================================================

    new cdk.CfnOutput(this, 'InstanceId', {
      value: this.instance.instanceId,
      description: 'Figma VM EC2 instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: this.instance.instancePublicIp,
      description: 'Figma VM public IP for RDP access',
    });

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: this.instance.instancePrivateIp,
      description: 'Figma VM private IP',
    });
  }
}
