param(
  [Parameter(Mandatory = $true)][string]$Soffice,
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$ProfileDir
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutputDir, $ProfileDir | Out-Null
$profileUri = ([Uri]$ProfileDir).AbsoluteUri
& $Soffice --headless "-env:UserInstallation=$profileUri" --convert-to pdf --outdir $OutputDir $InputPath
exit $LASTEXITCODE
