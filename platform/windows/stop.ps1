param(
    [switch]$CompanionOnly
)

$ErrorActionPreference = "SilentlyContinue"
$localData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$runtimeDir = Join-Path (Join-Path $localData "gexbot-tradingview-v1.0") "run"
$pidFile = Join-Path $runtimeDir "companion.pid"
$stopped = $false

if (Test-Path -LiteralPath $pidFile) {
    $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($pidText -match "^\d+$") {
        $companionPid = [int]$pidText
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $companionPid"
        if ($process -and $process.CommandLine -match "companion\.js") {
            Write-Host "[gexbot] Stopping companion PID $companionPid..."
            Stop-Process -Id $companionPid -Force
            $stopped = $true
        }
    }
    Remove-Item -LiteralPath $pidFile -Force
}
Remove-Item -LiteralPath (Join-Path $runtimeDir "debug.port") -Force

if (-not $stopped) { Write-Host "[gexbot] No running companion was found." }

if ($CompanionOnly) {
    Write-Warning "TradingView remains open with its unauthenticated local debug endpoint."
} else {
    Write-Host "[gexbot] Closing the debug-enabled TradingView session..."
    Get-Process -Name "TradingView*" | Stop-Process -Force
}
