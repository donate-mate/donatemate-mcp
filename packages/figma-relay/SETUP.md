# Figma VM Setup Guide

This guide covers setting up the Figma relay agent on the AWS Windows VM.

## Prerequisites

- AWS CLI configured with access to the DonateMate account
- RDP client (built into Windows, or use Microsoft Remote Desktop on Mac)

## VM Details

- **Instance ID**: `i-0890ee403d8c729f5`
- **Public IP**: `18.222.164.239`
- **Region**: `us-east-2`
- **OS**: Windows Server 2022

## Step 1: Get Windows Administrator Password

```bash
# Get the password using AWS CLI (requires the EC2 key pair)
aws ec2 get-password-data \
  --instance-id i-0890ee403d8c729f5 \
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
2. Computer: `18.222.164.239`
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
1. Fetch the WebSocket endpoint from SSM
2. Connect to AWS API Gateway
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

### "AUTH_TOKEN environment variable not set"
Set the token before running:
```powershell
$env:AUTH_TOKEN = (aws ssm get-parameter --name "/donatemate/staging/figma-relay/auth-token" --with-decryption --query "Parameter.Value" --output text)
.\scripts\start-relay.ps1
```

### Plugin not connecting
- Ensure Figma Desktop is running
- Check that port 3055 is not blocked by Windows Firewall
- Verify the plugin is running (check Figma's plugin panel)

### Connection to AWS fails
- Check the VM has outbound HTTPS access
- Verify the auth token is valid and not expired
- Check CloudWatch logs for the Lambda handler

## Auto-Start on Boot (Optional)

Create a scheduled task to start the relay on boot:

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-File C:\figma-relay\scripts\start-relay.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount
Register-ScheduledTask -TaskName "FigmaRelay" -Action $action -Trigger $trigger -Principal $principal
```

## SSM Parameters Reference

| Parameter | Description |
|-----------|-------------|
| `/donatemate/staging/mcp/websocket-endpoint` | WebSocket API Gateway URL |
| `/donatemate/staging/figma-relay/auth-token` | Cognito JWT for relay auth |
| `/donatemate/staging/figma-vm/instance-id` | EC2 instance ID |
