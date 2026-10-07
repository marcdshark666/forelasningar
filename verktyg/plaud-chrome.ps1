# Opens web.plaud.ai in a dedicated Chrome profile with a local CDP port (127.0.0.1:9335).
# Marc logs in ONCE himself (Logga in med Google, mkjonssonpf@gmail.com). No password is ever
# typed, read or stored by any script. After that, an agent can read the latest recordings
# (transcripts) from this window via CDP and import them locally - nothing is published.
# The profile lives in forelasningar\data\chrome-plaud (git-ignored, never committed).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $root 'data\chrome-plaud'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { throw "Chrome not found: $chrome" }
New-Item -ItemType Directory -Force $profileDir | Out-Null
$inUse = Get-NetTCPConnection -LocalPort 9335 -State Listen -ErrorAction SilentlyContinue
if ($inUse) { Write-Output 'PLAUD window already running (CDP 127.0.0.1:9335).'; exit 0 }
Start-Process -FilePath $chrome -ArgumentList @(
  "--user-data-dir=`"$profileDir`"",
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9335',
  '--no-first-run',
  'https://web.plaud.ai/'
)
Write-Output "Started. Log in to PLAUD with Google in the new window, then tell Claude 'PLAUD inloggad'."
