#Requires -Version 5.1
<#
.SYNOPSIS
  Legacy export / upload wrapper. Prefer Build.cmd, DeployLocal.cmd, DeployProd.cmd
  (actions/*.mjs) — see deploy.md and AgentController repository-commands.md.

.PARAMETER SkipUpload
  Build only; do not sync to S3. Same idea as Build.cmd / actions/Build.mjs.

.PARAMETER S3Bucket
  Destination bucket (default: baffledcat.com).

.PARAMETER S3Prefix
  Key prefix ending with / (default: mandelbrot/).
#>
[CmdletBinding()]
param(
  [switch]$SkipUpload,
  [string]$S3Bucket = "baffledcat.com",
  [string]$S3Prefix = "mandelbrot/"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
Set-Location $Root

if (-not $S3Prefix.EndsWith("/")) {
  $S3Prefix = "$S3Prefix/"
}

function Ensure-NodeModules {
  if (-not (Test-Path (Join-Path $Root "node_modules\esbuild"))) {
    Write-Host "Installing npm dependencies (esbuild)..."
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }
}

function Invoke-Packager {
  # A real upload is a release: it claims the next version number on GitHub (VERSION) first.
  # -SkipUpload builds locally without using up a number.
  if ($SkipUpload) {
    Write-Host "Running export-static.mjs (local build)..."
    node (Join-Path $Root "export-static.mjs")
  } else {
    Write-Host "Running export-static.mjs --release..."
    node (Join-Path $Root "export-static.mjs") --release
  }
  if ($LASTEXITCODE -ne 0) { throw "export-static.mjs failed" }
}

function Read-LatestManifest {
  $path = Join-Path $Root "Export\latest.json"
  if (-not (Test-Path $path)) {
    throw "Export/latest.json missing after packager run"
  }
  return Get-Content -Raw -Path $path | ConvertFrom-Json
}

function Ensure-AwsIdentity {
  aws sts get-caller-identity 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { return }

  Write-Host "AWS credentials not ready; running 'aws login'..."
  aws login
  if ($LASTEXITCODE -ne 0) { throw "aws login failed" }

  aws sts get-caller-identity | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Still not authenticated after aws login" }
}

function Sync-ToS3 {
  param(
    [string]$LocalDir,
    [string]$Version
  )

  $s3Root = "s3://$S3Bucket/$S3Prefix"
  Write-Host "Uploading $LocalDir → $s3Root"

  aws s3 sync $LocalDir $s3Root `
    --delete `
    --exclude "index.html" `
    --exclude "*.json.gz" `
    --cache-control "public, max-age=31536000, immutable"
  if ($LASTEXITCODE -ne 0) { throw "s3 sync (assets) failed" }

  $gzFiles = Get-ChildItem -Path $LocalDir -Filter "*.json.gz" -Recurse -ErrorAction SilentlyContinue
  if ($gzFiles) {
    aws s3 sync $LocalDir $s3Root `
      --exclude "*" `
      --include "*.json.gz" `
      --content-type "application/gzip" `
      --cache-control "public, max-age=31536000, immutable"
    if ($LASTEXITCODE -ne 0) { throw "s3 sync (json.gz) failed" }
  }

  aws s3 cp (Join-Path $LocalDir "index.html") ($s3Root + "index.html") `
    --cache-control "public, max-age=60" `
    --content-type "text/html; charset=utf-8"
  if ($LASTEXITCODE -ne 0) { throw "s3 cp index.html failed" }

  $publicUrl = "https://$S3Bucket/$S3Prefix" + "index.html"
  Write-Host "Verifying remote version at $publicUrl ..."
  $remoteHtml = (Invoke-WebRequest -Uri $publicUrl -UseBasicParsing).Content
  if ($remoteHtml -notmatch "__MANDELBROT_ASSET_VERSION__\s*=\s*[`"']$Version[`"']") {
    throw "Post-upload verification failed: expected asset version $Version in $publicUrl"
  }
  Write-Host "Remote index.html reports asset version $Version."
  Write-Host "Live URL: https://$S3Bucket/$S3Prefix"
}

# --- main ---
Ensure-NodeModules
Invoke-Packager

$manifest = Read-LatestManifest
$version = [string]$manifest.version
$localDir = Join-Path $Root ($manifest.dir -replace "/", "\")

if (-not (Test-Path $localDir)) {
  throw "Export folder missing: $localDir"
}

Write-Host ""
Write-Host "Latest export: $version ($localDir)"
Write-Host ""
Write-Host "aws s3 commands for this build:"
$s3Uri = "s3://$S3Bucket/$S3Prefix"
Write-Host ('aws s3 sync "{0}" "{1}" --delete --exclude index.html --exclude "*.json.gz" --cache-control "public, max-age=31536000, immutable"' -f $localDir, $s3Uri)
Write-Host ('aws s3 cp "{0}\index.html" "{1}index.html" --cache-control "public, max-age=60" --content-type "text/html; charset=utf-8"' -f $localDir, $s3Uri)
Write-Host ""

if ($SkipUpload) {
  Write-Host "SkipUpload set - not uploading."
  Write-Host "Smoke-test: npx --yes serve $($manifest.dir) -p 8080"
  exit 0
}

Ensure-AwsIdentity
Sync-ToS3 -LocalDir $localDir -Version $version
