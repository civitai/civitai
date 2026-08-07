# Windows Defender exclusions for the dev environment.
#
# Real-time protection scans every file Turbopack and pnpm touch — ~210k files in
# node_modules plus a multi-GB build cache per branch. Excluding them is the single
# biggest win for cold-start and branch-switch time on Windows.
#
# Must run from an ELEVATED PowerShell (Run as Administrator).

#Requires -RunAsAdministrator

# Add-MpPreference accepts a path that does not exist, so a wrong root here reports success and
# excludes nothing. Override with -ReposRoot on any machine that doesn't use this layout.
param([string]$ReposRoot = 'C:\Dev\Repos\work')

$paths = @(
  $ReposRoot,
  "$env:LOCALAPPDATA\pnpm",
  "$env:LOCALAPPDATA\pnpm-store"
)

$processes = @('node.exe', 'pnpm.exe', 'npm.exe')

foreach ($p in $paths) {
  Add-MpPreference -ExclusionPath $p
  Write-Host "excluded path:    $p"
}

foreach ($p in $processes) {
  Add-MpPreference -ExclusionProcess $p
  Write-Host "excluded process: $p"
}

Write-Host "`nCurrent exclusions:"
$pref = Get-MpPreference
$pref.ExclusionPath | ForEach-Object { "  path    $_" }
$pref.ExclusionProcess | ForEach-Object { "  process $_" }
