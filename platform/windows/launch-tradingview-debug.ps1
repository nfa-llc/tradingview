param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,

    [string]$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
)

$ErrorActionPreference = "Stop"
$arguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port"
)

Write-Host "[gexbot] Closing TradingView..."
Get-Process -Name "TradingView*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if ($env:TRADINGVIEW_BIN) {
    if (-not (Test-Path -LiteralPath $env:TRADINGVIEW_BIN -PathType Leaf)) {
        throw "TRADINGVIEW_BIN does not exist: $($env:TRADINGVIEW_BIN)"
    }
    Write-Host "[gexbot] Starting $($env:TRADINGVIEW_BIN) on loopback debug port $Port..."
    Start-Process -FilePath $env:TRADINGVIEW_BIN -ArgumentList $arguments | Out-Null
} else {
    $package = Get-AppxPackage "TradingView.Desktop" -ErrorAction SilentlyContinue
    if (-not $package) {
        throw "TradingView.Desktop was not found. Install it or set TRADINGVIEW_BIN to TradingView.exe."
    }
    $executable = Join-Path $package.InstallLocation "TradingView.exe"
    Write-Host "[gexbot] Starting the TradingView MSIX package on loopback debug port $Port..."
    Invoke-CommandInDesktopPackage `
        -PackageFamilyName $package.PackageFamilyName `
        -AppId "TradingView.Desktop" `
        -Command $executable `
        -Args ($arguments -join " ") | Out-Null
}

$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $response = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    throw "TradingView did not open debug port $Port within 20 seconds."
}

Write-Host "[gexbot] Debug port $Port is ready." -ForegroundColor Green
