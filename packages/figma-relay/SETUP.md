# Figma VM Setup Guide

This guide covers setting up the Figma relay agent on the AWS Windows VM.

## Prerequisites

- AWS CLI configured with access to the DonateMate account
- RDP client (built into Windows, or use Microsoft Remote Desktop on Mac)

## VM Details

- **Region**: `us-east-2`
- **OS**: Windows Server 2022

The instance can be replaced, so resolve its current ID and address instead of
copying a previously documented value:

```bash
INSTANCE_ID=$(aws ssm get-parameter \
  --name /donatemate/staging/figma-vm/instance-id \
  --region us-east-2 \
  --query Parameter.Value \
  --output text)
aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --region us-east-2 \
  --query 'Reservations[0].Instances[0].{State:State.Name,PublicIp:PublicIpAddress}'
```

## Step 1: Get Windows Administrator Password

```bash
# Get the password using AWS CLI (requires the EC2 key pair)
aws ec2 get-password-data \
  --instance-id "$INSTANCE_ID" \
  --priv-launch-key /path/to/your-key.pem \
  --region us-east-2
```

Or via AWS Console:
1. Go to EC2 > Instances
2. Select `donatemate-staging-figma-vm`
3. Actions > Security > Get Windows password
4. Upload the private key file to decrypt

## Step 2: Connect via RDP

1. Open Remote Desktop Connection
2. Computer: the current `PublicIp` returned above
3. Username: `Administrator`
4. Password: (from Step 1)

## Step 3: Install Figma Desktop

1. Open Edge browser on the VM
2. Go to https://www.figma.com/downloads/
3. Download and install Figma Desktop
4. Sign in with the shared DonateMate Figma account

## Step 4: Install the Figma Plugin

1. In Figma Desktop, go to Menu > Plugins > Development > Import plugin from manifest
2. Navigate to `C:\figma-relay\plugin\manifest.json`
3. The plugin should now appear in your plugins list

## Step 5: Deploy Relay Agent Code

Merges to `main` that change `packages/figma-relay/**` run the **Deploy Figma
Relay to Staging** workflow. It builds a self-contained bundle, deploys it over
SSM, installs the supervised scheduled task, and calls `dm_figma_list_files` as
an end-to-end smoke test.

Use the workflow dispatch action for a safe redeploy of the current version.
The manual options below are intended only for recovery.

Copy the relay agent files to the VM. You can use:

**Option A: Clone from Git**
```powershell
cd C:\figma-relay
git clone https://github.com/donate-mate/donatemate-mcp.git temp
Copy-Item -Recurse temp\packages\figma-relay\* .
Copy-Item -Recurse temp\packages\figma-plugin plugin
Remove-Item -Recurse -Force temp
npm install
npm run build
```

**Option B: Download from S3**
```powershell
# Upload to S3 first, then download on VM
aws s3 cp s3://donatemate-artifacts/figma-relay.zip C:\figma-relay\
Expand-Archive -Path C:\figma-relay\figma-relay.zip -DestinationPath C:\figma-relay
cd C:\figma-relay
npm install
npm run build
```

**Option C: Manual Copy**
Copy the following from your local machine:
- `packages/figma-relay/*` -> `C:\figma-relay\`
- `packages/figma-plugin/*` -> `C:\figma-relay\plugin\`

Then on the VM:
```powershell
cd C:\figma-relay
npm install
npm run build
```

## Step 6: Start the Relay Agent

Run the startup script:

```powershell
cd C:\figma-relay
.\scripts\start-relay.ps1
```

The script will:
1. Fetch the WebSocket endpoint, relay API key, Figma token, and team ID from SSM
2. Connect to AWS API Gateway and keep the connection alive
3. Start a local WebSocket server on port 3055 for the Figma plugin

## Step 7: Run the Figma Plugin

1. Open a Figma design file
2. Menu > Plugins > Development > DonateMate Design Bridge
3. The plugin will connect to the relay on port 3055

## Verification

Once everything is running, you should see in the relay console:
```
[Relay] Plugin server started on port 3055
[Relay] Connecting to AWS...
[Relay] Connected to AWS
[Relay] Figma plugin connected
```

## Troubleshooting

### "Could not fetch WebSocket endpoint from SSM"
- Ensure the EC2 instance has the correct IAM role attached
- Check that the SSM parameter exists: `/donatemate/staging/mcp/websocket-endpoint`

### Token or configuration errors

The startup script reads all required values from SSM. Rotate the Figma token at
`/donatemate/staging/figma/access-token`, then restart the `FigmaRelay` task. Do
not put tokens directly in the task definition or log.

### Plugin not connecting
- Ensure Figma Desktop is running
- Check that port 3055 is not blocked by Windows Firewall
- Verify the plugin is running (check Figma's plugin panel)

### Connection to AWS fails
- Check the VM has outbound HTTPS access
- Verify the auth token is valid and not expired
- Check CloudWatch logs for the Lambda handler

## Supervised Auto-Start

Install the scheduled task through the checked-in helper:

```powershell
C:\figma-relay\scripts\install-relay-task.ps1 -Start
```

The task has no execution-time cutoff and retries a failed relay every minute.

## SSM Parameters Reference

| Parameter | Description |
|-----------|-------------|
| `/donatemate/staging/mcp/websocket-endpoint` | WebSocket API Gateway URL |
| `/donatemate/staging/figma-relay/api-key` | Long-lived API key for relay authentication |
| `/donatemate/staging/figma/access-token` | Granular Figma PAT with `folders:read` and required file scopes |
| `/donatemate/staging/figma/team-id` | Team used for folder/file discovery |
| `/donatemate/staging/figma-vm/instance-id` | EC2 instance ID |
