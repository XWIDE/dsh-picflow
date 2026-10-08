# dsh-picflow installer for the DSH desktop app (Windows).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Remove
#
# One-liner, straight from the shell (no file to download first):
#
#   iwr https://raw.githubusercontent.com/XWIDE/dsh-picflow/main/install.ps1 -useb | iex
#
# Why this script exists: the desktop build puts no `dsh` on PATH, so install.sh
# cannot run there. This script drives the plugin operations that ship inside the
# application itself (resources\app\lib\plugin-cli.js), so it needs nothing beyond
# PowerShell 5.1 and an installed DSH NEXT.
#
# Kept pure ASCII on purpose: a piped `iex` has no reliable file encoding.
#
# The host half registers its HTTP routes when the app starts, so restart the app
# once afterwards - "Reload interface" alone is not enough.

param(
  [string]$Profile = 'desktop',
  [string]$Exe = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$Name = 'dsh-picflow'
$Spec = 'github:XWIDE/dsh-picflow'

function Find-AppExe([string]$given) {
  if ($given -ne '') {
    if (-not (Test-Path -LiteralPath $given)) { throw "not a file: $given" }
    return (Get-Item -LiteralPath $given).FullName
  }
  $candidates = @()
  foreach ($var in 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)') {
    $root = [Environment]::GetEnvironmentVariable($var)
    if ($root) {
      $candidates += Join-Path $root 'Programs\DSH NEXT\DSH NEXT.exe'
      $candidates += Join-Path $root 'DSH NEXT\DSH NEXT.exe'
    }
  }
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return (Get-Item -LiteralPath $c).FullName }
  }
  throw 'DSH NEXT.exe was not found in the usual locations. Pass its full path with -Exe.'
}

$exePath = Find-AppExe $Exe
$appDir = Split-Path -Parent $exePath
$cli = Join-Path $appDir 'resources\app\lib\plugin-cli.js'
if (-not (Test-Path -LiteralPath $cli)) {
  throw "this application install has no plugin operations entry point: $cli"
}

# The plugin operations resolve the profile directory from DSH_HOME.
$env:DSH_HOME = Join-Path $HOME '.dsh'

if ($Remove) {
  $op = @('remove', $Name)
} else {
  $op = @('add', $Spec)
}

$argv = @($cli, $Profile) + $op
Write-Host ('Running: "' + $exePath + '" --expose-internals ' + ($argv -join ' '))
& $exePath --expose-internals @argv
if ($LASTEXITCODE -ne 0) {
  throw "plugin operation failed (exit code $LASTEXITCODE)"
}

if ($Remove) {
  Write-Host ''
  Write-Host "$Name removed from profile '$Profile'. Restart the app to apply."
} else {
  Write-Host ''
  Write-Host "$Name installed into profile '$Profile'."
  Write-Host 'Restart DSH NEXT once - the host half registers its routes at startup.'
  Write-Host 'Then Ctrl+V a screenshot into the composer: it is stored, numbered, and lands at the caret.'
}
