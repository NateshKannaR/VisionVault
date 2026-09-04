# restart.ps1 — stops whatever holds the server port, then starts a fresh instance.
#
# `uvicorn --reload` spawns a worker via multiprocessing whose command line contains neither
# "uvicorn" nor "main:app", so killing by command line leaves it running and holding the port.
# The next start then fails to bind and exits, while the stale worker keeps answering with old
# code — which looks exactly like a code change having no effect. Killing by port owner is the
# only reliable way.
#
# Usage:  powershell -ExecutionPolicy Bypass -File server\restart.ps1 [-Port 8000]

param(
    [int]$Port = 8000,
    [string]$Python = "C:\Python312\python.exe"
)

$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Only LISTEN sockets, and never the system PIDs. Sockets in TIME_WAIT report an owner of 0,
# and "taskkill /F /PID 0 /T" walks the entire System process tree — it is refused, but asking
# is not something this script should ever do.
$owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
          Select-Object -ExpandProperty OwningProcess -Unique |
          Where-Object { $_ -gt 4 }
foreach ($procId in $owners) {
    $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    Write-Host "stopping $name (pid $procId) holding port $Port"
    & taskkill /F /PID $procId /T | Out-Null
}

# Wait for the socket to be released rather than assuming it.
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $still) { break }
}

$log = Join-Path $root "logs\uvicorn.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

Start-Process -FilePath $Python `
    -ArgumentList "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "$Port" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
    -WindowStyle Hidden

for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3 -UseBasicParsing
        Write-Host $r.Content
        exit 0
    } catch { }
}

Write-Host "server did not come up; see $log.err"
Get-Content "$log.err" -Tail 10
exit 1
