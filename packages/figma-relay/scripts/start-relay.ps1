# Figma Relay Agent Startup Script
# Run this on the Figma VM to start the relay agent

$ErrorActionPreference = "Stop"

# Configuration
$RELAY_DIR = "C:\figma-relay"
$LOG_FILE = "$RELAY_DIR\relay.log"

# Check if relay directory exists
if (-not (Test-Path $RELAY_DIR)) {
    Write-Host "Creating relay directory..."
    New-Item -ItemType Directory -Force -Path $RELAY_DIR
}

# Change to relay directory
Set-Location $RELAY_DIR

# Check if node_modules exists
if (-not (Test-Path "$RELAY_DIR\node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

# Get configuration from SSM
Write-Host "Fetching configuration from SSM..."

try {
    $WS_ENDPOINT = aws ssm get-parameter --name "/donatemate/staging/mcp/websocket-endpoint" --query "Parameter.Value" --output text
    Write-Host "WebSocket endpoint: $WS_ENDPOINT"
} catch {
    Write-Host "ERROR: Could not fetch WebSocket endpoint from SSM"
    Write-Host "Make sure the EC2 instance has the correct IAM permissions"
    exit 1
}

# Check for auth token
$AUTH_TOKEN = $env:AUTH_TOKEN
if (-not $AUTH_TOKEN) {
    Write-Host ""
    Write-Host "WARNING: AUTH_TOKEN environment variable not set!"
    Write-Host "Set it with: `$env:AUTH_TOKEN = 'your-cognito-jwt-token'"
    Write-Host ""
}

# Set environment variables
$env:AWS_WS_URL = $WS_ENDPOINT
$env:PLUGIN_PORT = "3055"

Write-Host ""
Write-Host "=============================================="
Write-Host "  Figma Relay Agent"
Write-Host "=============================================="
Write-Host "WebSocket URL: $WS_ENDPOINT"
Write-Host "Plugin Port: 3055"
Write-Host "Log File: $LOG_FILE"
Write-Host "=============================================="
Write-Host ""
Write-Host "Starting relay agent..."
Write-Host "Press Ctrl+C to stop"
Write-Host ""

# Start the relay agent
node dist/index.js 2>&1 | Tee-Object -FilePath $LOG_FILE -Append
