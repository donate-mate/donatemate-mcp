# Figma Relay Agent startup script. Secrets are loaded at process start so a
# token rotation only requires a supervised restart, never a code change.

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RELAY_DIR = "C:\figma-relay"
$LOG_FILE = "$RELAY_DIR\relay.log"
$ENVIRONMENT = if ($env:DONATEMATE_ENVIRONMENT) { $env:DONATEMATE_ENVIRONMENT } else { "staging" }
$AWS_CLI = "$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe"

if (-not (Test-Path $AWS_CLI)) {
    $awsCommand = Get-Command aws.exe -ErrorAction SilentlyContinue
    if (-not $awsCommand) {
        Write-Host "ERROR: AWS CLI v2 is not installed."
        exit 1
    }
    $AWS_CLI = $awsCommand.Source
}

function Get-SsmParameterValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [switch]$WithDecryption
    )

    $arguments = @(
        "ssm", "get-parameter",
        "--name", $Name,
        "--region", "us-east-2",
        "--query", "Parameter.Value",
        "--output", "text"
    )
    if ($WithDecryption) {
        $arguments += "--with-decryption"
    }

    $value = & $script:AWS_CLI @arguments
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) {
        throw "Could not load required SSM parameter: $Name"
    }
    return $value.Trim()
}

if (-not (Test-Path $RELAY_DIR)) {
    New-Item -ItemType Directory -Force -Path $RELAY_DIR | Out-Null
}
Set-Location $RELAY_DIR

$BUNDLED_ENTRY = "$RELAY_DIR\dist\index.cjs"
$SOURCE_ENTRY = "$RELAY_DIR\dist\index.js"
if (Test-Path $BUNDLED_ENTRY) {
    $RELAY_ENTRY = $BUNDLED_ENTRY
} elseif (Test-Path $SOURCE_ENTRY) {
    $RELAY_ENTRY = $SOURCE_ENTRY
} else {
    Write-Host "ERROR: Relay entry point not found."
    exit 1
}

try {
    $env:AWS_WS_URL = Get-SsmParameterValue "/donatemate/$ENVIRONMENT/mcp/websocket-endpoint"
    $env:API_KEY = Get-SsmParameterValue "/donatemate/$ENVIRONMENT/figma-relay/api-key" -WithDecryption
    $env:FIGMA_ACCESS_TOKEN = Get-SsmParameterValue "/donatemate/$ENVIRONMENT/figma/access-token" -WithDecryption
    $env:FIGMA_TEAM_ID = Get-SsmParameterValue "/donatemate/$ENVIRONMENT/figma/team-id"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    Write-Host "Make sure the parameters exist and the EC2 instance role can read them."
    exit 1
}

$env:PLUGIN_PORT = "3055"

Write-Host ""
Write-Host "=============================================="
Write-Host "  Figma Relay Agent"
Write-Host "=============================================="
Write-Host "Environment: $ENVIRONMENT"
Write-Host "WebSocket URL: configured"
Write-Host "API key: configured"
Write-Host "Figma access token: configured"
Write-Host "Figma team ID: configured"
Write-Host "Plugin Port: 3055"
Write-Host "Log File: $LOG_FILE"
Write-Host "=============================================="
Write-Host "Starting relay agent..."

& node $RELAY_ENTRY 2>&1 | Tee-Object -FilePath $LOG_FILE -Append
$relayExitCode = $LASTEXITCODE
Write-Host "Relay exited with code $relayExitCode"
exit $relayExitCode
