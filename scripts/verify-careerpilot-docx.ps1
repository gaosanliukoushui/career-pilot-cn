$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$qaOutput = Join-Path $repoRoot 'output\careerpilot\qa-anonymous-workspace\output\careerpilot'
$qaReport = Join-Path $qaOutput 'qa-results.json'
$soffice = if ($env:CAREERPILOT_SOFFICE) { $env:CAREERPILOT_SOFFICE } else { 'E:\liberoffice\program\soffice.com' }
if (-not (Test-Path -LiteralPath $soffice)) {
  throw "LibreOffice CLI not found: $soffice"
}

$verified = @()
$results = (Get-Content -LiteralPath $qaReport -Raw | ConvertFrom-Json).results
$directPdfs = @($results | Where-Object { $_.format -eq 'pdf' } | ForEach-Object { $_.path })
foreach ($template in @('soe-one-page', 'tech-two-page', 'application-detail')) {
  $inputPath = ($results | Where-Object { $_.template -eq $template -and $_.format -eq 'docx' }).path
  if (-not (Test-Path -LiteralPath $inputPath)) { throw "DOCX not found: $inputPath" }
  # Keep paths short: LibreOffice on Windows can silently return 0 without
  # producing output when its per-run profile/output path approaches MAX_PATH.
  $renderDir = Join-Path $qaOutput "lo-$(([Guid]::NewGuid()).ToString('N').Substring(0, 8))"
  $profileDir = Join-Path $renderDir 'profile'
  & (Join-Path $PSScriptRoot 'render-docx-qa.ps1') -Soffice $soffice -InputPath $inputPath -OutputDir $renderDir -ProfileDir $profileDir
  $pdfPath = Join-Path $renderDir "$template.pdf"
  if (-not (Test-Path -LiteralPath $pdfPath) -or (Get-Item -LiteralPath $pdfPath).Length -lt 1000) {
    throw "LibreOffice render did not produce a valid PDF: $pdfPath"
  }
  $verified += $pdfPath
}
& node (Join-Path $PSScriptRoot 'verify-pdf-qa.mjs') @verified @directPdfs
if ($LASTEXITCODE -ne 0) { throw "PDF semantic QA failed with exit code $LASTEXITCODE" }
Write-Output "PASS LibreOffice DOCX render: $($verified.Count)/3"
$verified | ForEach-Object { Write-Output $_ }
