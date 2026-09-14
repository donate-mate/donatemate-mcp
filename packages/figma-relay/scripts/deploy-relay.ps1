param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,
    [string]$RelayDirectory = "C:\figma-relay"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$taskName = "FigmaRelay"
$sourceBundle = Join-Path $PackageRoot "dist\index.cjs"
$sourceScripts = Join-Path $PackageRoot "scripts"
$sourcePlugin = Join-Path $PackageRoot "plugin"
$targetBundle = Join-Path $RelayDirectory "dist\index.cjs"
$targetScripts = Join-Path $RelayDirectory "scripts"
$targetPlugin = Join-Path $RelayDirectory "plugin"

if (-not (Test-Path $sourceBundle)) {
    throw "Deployment bundle not found: $sourceBundle"
}
if (-not (Test-Path (Join-Path $sourceScripts "start-relay.ps1"))) {
    throw "Deployment scripts not found: $sourceScripts"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = Join-Path $RelayDirectory "backups\$timestamp"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq "Running") {
    Stop-ScheduledTask -TaskName $taskName
    Start-Sleep -Seconds 2
}

# Stop only the Node process running this relay; do not disturb unrelated Node workloads.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match "figma-relay.*dist.index.cjs" } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }

New-Item -ItemType Directory -Force -Path (Split-Path $targetBundle), $targetScripts, $backupDirectory | Out-Null
if (Test-Path $targetBundle) {
    Copy-Item $targetBundle (Join-Path $backupDirectory "index.cjs") -Force
}
if (Test-Path (Join-Path $targetScripts "start-relay.ps1")) {
    Copy-Item (Join-Path $targetScripts "start-relay.ps1") $backupDirectory -Force
}
if (Test-Path (Join-Path $targetScripts "install-relay-task.ps1")) {
    Copy-Item (Join-Path $targetScripts "install-relay-task.ps1") $backupDirectory -Force
}
if (Test-Path $targetPlugin) {
    Copy-Item $targetPlugin (Join-Path $backupDirectory "plugin") -Recurse -Force
}

Copy-Item $sourceBundle $targetBundle -Force
Copy-Item (Join-Path $sourceScripts "start-relay.ps1") $targetScripts -Force
Copy-Item (Join-Path $sourceScripts "install-relay-task.ps1") $targetScripts -Force
Copy-Item (Join-Path $sourceScripts "deploy-relay.ps1") $targetScripts -Force
if (Test-Path (Join-Path $sourcePlugin "manifest.json")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $targetPlugin "dist") | Out-Null
    Copy-Item (Join-Path $sourcePlugin "manifest.json") $targetPlugin -Force
    Copy-Item (Join-Path $sourcePlugin "dist\code.js") (Join-Path $targetPlugin "dist") -Force
    Copy-Item (Join-Path $sourcePlugin "dist\ui.html") (Join-Path $targetPlugin "dist") -Force
}

try {
    & (Join-Path $targetScripts "install-relay-task.ps1") -RelayDirectory $RelayDirectory -Start
    Start-Sleep -Seconds 10

    $task = Get-ScheduledTask -TaskName $taskName
    $relayProcess = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -match "figma-relay.*dist.index.cjs" } |
        Select-Object -First 1
    if ($task.State -ne "Running" -or -not $relayProcess) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
        throw "Relay failed to stay running (task=$($task.State), result=$($taskInfo.LastTaskResult))."
    }

    Write-Host "Figma relay deployed and running. PID: $($relayProcess.ProcessId)"
} catch {
    Write-Host "Deployment verification failed; restoring the previous relay bundle."
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (Test-Path (Join-Path $backupDirectory "index.cjs")) {
        Copy-Item (Join-Path $backupDirectory "index.cjs") $targetBundle -Force
    }
    if (Test-Path (Join-Path $backupDirectory "start-relay.ps1")) {
        Copy-Item (Join-Path $backupDirectory "start-relay.ps1") $targetScripts -Force
    }
    if (Test-Path (Join-Path $backupDirectory "install-relay-task.ps1")) {
        Copy-Item (Join-Path $backupDirectory "install-relay-task.ps1") $targetScripts -Force
    }
    if (Test-Path (Join-Path $backupDirectory "plugin")) {
        Copy-Item (Join-Path $backupDirectory "plugin\*") $targetPlugin -Recurse -Force
    }
    & (Join-Path $targetScripts "install-relay-task.ps1") -RelayDirectory $RelayDirectory -Start
    throw
}
