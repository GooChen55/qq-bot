param([switch]$PanelOnly)
$deploymentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Push-Location $deploymentRoot
try { if ($PanelOnly) { node deployment/cli.mjs start --panel-only } else { node deployment/cli.mjs start } } finally { Pop-Location }
