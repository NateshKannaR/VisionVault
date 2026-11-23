param(
    [int]$Port = 8000,
    [string]$Python
)

$ErrorActionPreference = "Stop"
if (!$Python) {
    $Python = @(
        (Join-Path $PSScriptRoot ".venv/Scripts/python.exe"),
        (Join-Path $PSScriptRoot "../.venv/Scripts/python.exe"),
        (Join-Path $PSScriptRoot "venv/Scripts/python.exe")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (!$Python) { $Python = "python" }
}
Push-Location $PSScriptRoot
try {
    & $Python -m uvicorn main:app --host 127.0.0.1 --port $Port --no-proxy-headers --no-access-log --limit-concurrency 24
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
