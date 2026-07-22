param(
    [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path -LiteralPath $RootDir).Path.TrimEnd("\")
$companionPath = Join-Path $RootDir "companion.js"
$launcherPath = Join-Path $PSScriptRoot "launch-tradingview-debug.ps1"

$nodeCommand = if ($env:IOF_NODE) { $env:IOF_NODE } else { "node" }
$node = Get-Command $nodeCommand -ErrorAction Stop
$nodeVersion = & $node.Source -p "process.versions.node"
$nodeMajor = [int](($nodeVersion -split "\.")[0])
if ($nodeMajor -lt 22) {
    throw "Node.js 22 or newer is required (found $nodeVersion)."
}

$localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$appDir = Join-Path $localData "gexbot-tradingview-v1.0"
$runtimeDir = Join-Path $appDir "run"
$stateDir = Join-Path $appDir "logs"
$configDir = $appDir
$pidFile = Join-Path $runtimeDir "companion.pid"
$debugPortFile = Join-Path $runtimeDir "debug.port"
$stdoutLog = Join-Path $stateDir "companion.log"
$stderrLog = Join-Path $stateDir "companion-error.log"
New-Item -ItemType Directory -Force -Path $runtimeDir, $stateDir, $configDir | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    $oldPidText = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($oldPidText -match "^\d+$") {
        $oldPid = [int]$oldPidText
        $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
        if ($oldProcess -and $oldProcess.CommandLine -match "companion\.js") {
            Write-Host "[gexbot] Stopping previous companion PID $oldPid..."
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

if ($env:IOF_PORT) {
    $port = [int]$env:IOF_PORT
    if ($port -lt 1 -or $port -gt 65535) { throw "Invalid IOF_PORT: $($env:IOF_PORT)" }
} else {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
}
Set-Content -LiteralPath $debugPortFile -Value $port -Encoding Ascii
Write-Host "[gexbot] Selected random loopback debug port $port."

& $launcherPath -Port $port -RootDir $RootDir

$env:IOF_PORT = [string]$port
$env:IOF_PID_FILE = $pidFile
$env:IOF_CONFIG_DIR = $configDir
Write-Host "[gexbot] Starting the shared gexbot companion..."
$process = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @("`"$companionPath`"") `
    -WorkingDirectory $RootDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

Start-Sleep -Seconds 1
if ($process.HasExited) {
    $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine } else { "" }
    throw "The companion exited during startup. $details"
}

Write-Host "[gexbot] Ready (companion PID $($process.Id))." -ForegroundColor Green
Write-Host "[gexbot] Logs: $stateDir"
