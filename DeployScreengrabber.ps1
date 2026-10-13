<#
.SYNOPSIS
  Provision Cloudflare infra for baffledcat-screenshots and deploy production Worker code.

.DESCRIPTION
  - npm install (worker)
  - Create D1 database + R2 bucket if missing; write database_id into wrangler.toml
  - Apply remote D1 migrations
  - Set production secrets (from env / optional secrets file / generated where safe)
  - Ensure custom domain route for shots.baffledcat.com
  - Sync SDK into Mandelbrot vendor/
  - wrangler deploy
  - Smoke-test /health

.PARAMETER SkipSecrets
  Do not create or update Worker secrets.

.PARAMETER SkipDomain
  Do not add/update the shots.baffledcat.com route in wrangler.toml.

.PARAMETER DryRun
  Print actions without creating resources or deploying.

.EXAMPLE
  .\DeployScreengrabber.ps1

.EXAMPLE
  $env:TURNSTILE_SECRET = "..."
  $env:ADMIN_TOKEN = "..."
  .\DeployScreengrabber.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipSecrets,
  [switch]$SkipDomain,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = $PSScriptRoot
$WorkerDir = Join-Path $RepoRoot "baffledcat-screenshots\worker"
$WranglerToml = Join-Path $WorkerDir "wrangler.toml"
$SdkSrc = Join-Path $RepoRoot "baffledcat-screenshots\sdk\baffled-screenshots.js"
$SdkDst = Join-Path $RepoRoot "js\vendor\baffled-screenshots.js"
$SecretsFile = Join-Path $WorkerDir ".deploy-secrets.env"

$WorkerName = "baffledcat-screenshots"
$DbName = "baffledcat-shots"
$BucketName = "baffledcat-shots"
$PublicHost = "shots.baffledcat.com"
$ZoneName = "baffledcat.com"
$PublicBaseUrl = "https://$PublicHost"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
  Write-Host "    $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
  Write-Host "    WARN: $msg" -ForegroundColor Yellow
}

function Assert-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $name"
  }
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$NativeArgs
  )
  # StrictMode + native stderr-as-ErrorRecord causes "Statement" property errors on WinPS 5.1.
  Set-StrictMode -Off
  $prevEa = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $outFile = [System.IO.Path]::GetTempFileName()
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $argList = @()
    if ($NativeArgs) { $argList = $NativeArgs }

    # .cmd/.bat tools (npm, npx) must run via cmd.exe on Windows.
    $useCmd = $false
    $cmdLine = $null
    $leaf = [System.IO.Path]::GetFileNameWithoutExtension($FilePath).ToLowerInvariant()
    if ($leaf -eq "npm" -or $leaf -eq "npx" -or $FilePath -match '\.(cmd|bat)$') {
      $useCmd = $true
      $quotedArgs = @()
      foreach ($a in $argList) {
        if ($a -match '[\s"]') {
          $quotedArgs += '"' + ($a -replace '"', '\"') + '"'
        } else {
          $quotedArgs += $a
        }
      }
      $cmdLine = "$FilePath $($quotedArgs -join ' ')"
    }

    # Redirected Start-Process is non-interactive: Wrangler OAuth will NOT work.
    # Prefer CLOUDFLARE_API_TOKEN in the environment (see Ensure-CloudflareAuth).
    $psiEnv = $null
    if ($useCmd) {
      $p = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/c", $cmdLine) `
        -WorkingDirectory (Get-Location).Path `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile
    } else {
      $p = Start-Process -FilePath $FilePath -ArgumentList $argList `
        -WorkingDirectory (Get-Location).Path `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $outFile `
        -RedirectStandardError $errFile
    }

    $stdout = ""
    $stderr = ""
    if (Test-Path $outFile) { $stdout = [System.IO.File]::ReadAllText($outFile) }
    if (Test-Path $errFile) { $stderr = [System.IO.File]::ReadAllText($errFile) }
    $text = (($stdout, $stderr) | Where-Object { $_ }) -join "`n"
    $code = 1
    if ($null -ne $p -and $null -ne $p.ExitCode) { $code = [int]$p.ExitCode }
    return [pscustomobject]@{ ExitCode = $code; Text = $text.TrimEnd() }
  } finally {
    $ErrorActionPreference = $prevEa
    Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
    Set-StrictMode -Version Latest
  }
}

function Invoke-Npm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArgs)
  Push-Location $WorkerDir
  try {
    $r = Invoke-Native npm @NpmArgs
    if ($r.ExitCode -ne 0) { throw "npm $($NpmArgs -join ' ') failed ($($r.ExitCode)): $($r.Text)" }
    if ($r.Text) { Write-Host $r.Text }
  } finally {
    Pop-Location
  }
}

function Invoke-Wrangler {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WArgs)
  Push-Location $WorkerDir
  try {
    $r = Invoke-Native npx wrangler @WArgs
    if ($r.ExitCode -ne 0) { throw "wrangler $($WArgs -join ' ') failed ($($r.ExitCode)): $($r.Text)" }
    return $r.Text
  } finally {
    Pop-Location
  }
}

function Ensure-CloudflareAuth {
  Write-Step "Cloudflare auth"

  $fileMap = Read-EnvFile $SecretsFile
  $alt = Join-Path $RepoRoot "baffledcat-screenshots\.deploy-secrets.env"
  foreach ($kv in (Read-EnvFile $alt).GetEnumerator()) {
    if (-not $fileMap.ContainsKey($kv.Key)) { $fileMap[$kv.Key] = $kv.Value }
  }

  $token = Get-SecretValue "CLOUDFLARE_API_TOKEN" $fileMap
  if ($token) {
    $env:CLOUDFLARE_API_TOKEN = $token
    Write-Ok "Using CLOUDFLARE_API_TOKEN from environment or .deploy-secrets.env"
  } else {
    Write-Warn "No CLOUDFLARE_API_TOKEN set."
    Write-Warn "DeployScreengrabber runs Wrangler non-interactively, so browser OAuth (wrangler login) is not used."
    Write-Warn "Create an API token, then either:"
    Write-Warn "  set CLOUDFLARE_API_TOKEN=...   (current session)"
    Write-Warn "  or add CLOUDFLARE_API_TOKEN=... to baffledcat-screenshots\worker\.deploy-secrets.env"
    Write-Warn "Token create: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"
    Write-Warn "Suggested permissions: Account - Workers Scripts Edit, Workers R2 Storage Edit, D1 Edit;"
    Write-Warn "  User - Memberships Read (or set CLOUDFLARE_ACCOUNT_ID to skip /memberships)."
  }

  # Prefer explicit account id so Wrangler skips GET /memberships (needs extra token perms).
  $accountId = Get-SecretValue "CLOUDFLARE_ACCOUNT_ID" $fileMap
  if ($accountId) {
    $env:CLOUDFLARE_ACCOUNT_ID = $accountId
    Write-Ok "Using CLOUDFLARE_ACCOUNT_ID=$accountId"
  }

  if ($DryRun -and -not (Test-Path (Join-Path $WorkerDir "node_modules\wrangler"))) {
    Write-Warn "Dry run without node_modules; skipping wrangler whoami"
    return
  }

  Push-Location $WorkerDir
  try {
    $who = Invoke-Native npx wrangler whoami
    if ($who.Text) { Write-Host $who.Text }
    $text = ""
    if ($who.Text) { $text = $who.Text }

    # Success looks like an account table / "logged in". Do NOT treat the
    # informational line "API Token is read from the CLOUDFLARE_API_TOKEN..." as failure.
    $failedExplicit =
      ($text -match '(?i)you are not authenticated') -or
      ($text -match '(?i)not authenticated\. Please run') -or
      ($text -match '(?i)Unable to authenticate') -or
      ($text -match '(?i)Invalid API Token')
    $looksLoggedIn =
      ($text -match '(?i)You are logged in') -or
      ($text -match '(?i)Account Name') -or
      ($text -match '(?i)Account ID')

    $authed = ($who.ExitCode -eq 0) -and $looksLoggedIn -and (-not $failedExplicit)
    if (-not $authed) {
      Write-Host ""
      Write-Host "Cloudflare authentication required." -ForegroundColor Yellow
      Write-Host "1) Open: https://dash.cloudflare.com/profile/api-tokens"
      Write-Host "2) Create token (Workers Edit + D1 Edit + R2 Edit is enough for this deploy)."
      Write-Host "3) Save it in worker\.deploy-secrets.env as:"
      Write-Host "     CLOUDFLARE_API_TOKEN=your_token_here"
      Write-Host "     CLOUDFLARE_ACCOUNT_ID=your_account_id"
      Write-Host "4) Re-run DeployScreengrabber.cmd"
      Write-Host ""
      throw "Not authenticated to Cloudflare (set CLOUDFLARE_API_TOKEN, then re-run)."
    }

    if (-not $env:CLOUDFLARE_ACCOUNT_ID) {
      # Account IDs are 32 hex chars (no dashes). Prefer the table cell after Account Name.
      if ($text -match '(?im)Account ID[^\n]*\n[^\n]*\|\s*([0-9a-f]{32})\s*\|') {
        $env:CLOUDFLARE_ACCOUNT_ID = $Matches[1]
      } elseif ($text -match '(?i)\b([0-9a-f]{32})\b') {
        $env:CLOUDFLARE_ACCOUNT_ID = $Matches[1]
      }
      if ($env:CLOUDFLARE_ACCOUNT_ID) {
        Write-Ok "Detected CLOUDFLARE_ACCOUNT_ID=$($env:CLOUDFLARE_ACCOUNT_ID)"
        if (-not $DryRun) {
          if (Test-Path $SecretsFile) {
            $existing = Get-Content -Raw -Path $SecretsFile
            if ($existing -notmatch '(?m)^CLOUDFLARE_ACCOUNT_ID=') {
              Add-Content -Path $SecretsFile -Value "CLOUDFLARE_ACCOUNT_ID=$($env:CLOUDFLARE_ACCOUNT_ID)"
              Write-Ok "Saved CLOUDFLARE_ACCOUNT_ID to worker/.deploy-secrets.env"
            }
          } else {
            Set-Content -Path $SecretsFile -Value @(
              "# Generated by DeployScreengrabber.ps1 - do not commit",
              "CLOUDFLARE_ACCOUNT_ID=$($env:CLOUDFLARE_ACCOUNT_ID)"
            ) -Encoding utf8
            Write-Ok "Created worker/.deploy-secrets.env with CLOUDFLARE_ACCOUNT_ID"
          }
        }
      } else {
        Write-Warn "Could not detect account id. If D1/R2 fails with /memberships errors, add:"
        Write-Warn "  CLOUDFLARE_ACCOUNT_ID=... to worker/.deploy-secrets.env"
      }
    }

    Write-Ok "Cloudflare auth OK"
  } finally {
    Pop-Location
  }
}

function Read-EnvFile([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $i = $t.IndexOf("=")
    if ($i -lt 1) { continue }
    $k = $t.Substring(0, $i).Trim()
    $v = $t.Substring($i + 1).Trim()
    if (
      ($v.StartsWith('"') -and $v.EndsWith('"')) -or
      ($v.StartsWith("'") -and $v.EndsWith("'"))
    ) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    $map[$k] = $v
  }
  return $map
}

function Get-SecretValue([string]$name, [hashtable]$fileMap) {
  $envVal = [Environment]::GetEnvironmentVariable($name)
  if ($envVal) { return $envVal }
  if ($fileMap.ContainsKey($name) -and $fileMap[$name]) { return $fileMap[$name] }
  return $null
}

function New-RandomToken([int]$bytes = 32) {
  $buf = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buf)
  } finally {
    $rng.Dispose()
  }
  return ([BitConverter]::ToString($buf) -replace "-", "").ToLowerInvariant()
}

function Set-WranglerDatabaseId([string]$tomlPath, [string]$databaseId) {
  $text = Get-Content -Raw -Path $tomlPath
  if ($text -notmatch 'database_id\s*=') {
    throw "wrangler.toml missing database_id field"
  }
  $updated = [regex]::Replace(
    $text,
    'database_id\s*=\s*"[^"]*"',
    "database_id = `"$databaseId`""
  )
  if ($updated -eq $text -and $text -notmatch [regex]::Escape($databaseId)) {
    # still placeholder or different quoting
    $updated = $text -replace 'database_id\s*=\s*"[^"]*"', "database_id = `"$databaseId`""
  }
  if (-not $DryRun) {
    Set-Content -Path $tomlPath -Value $updated -NoNewline -Encoding utf8
  }
  Write-Ok "wrangler.toml database_id = $databaseId"
}

function Ensure-CustomDomainRoute([string]$tomlPath) {
  $text = Get-Content -Raw -Path $tomlPath
  if ($text -match 'custom_domain\s*=\s*true' -and $text -match [regex]::Escape($PublicHost)) {
    Write-Ok "Custom domain route already present for $PublicHost"
    return
  }

  $block = @"

# Production hostname (managed by DeployScreengrabber.ps1)
routes = [
  { pattern = "$PublicHost", custom_domain = true }
]
"@

  if ($text -match '(?m)^routes\s*=') {
    Write-Warn "wrangler.toml already has a routes = … block; leave it unchanged and ensure $PublicHost is attached in the dashboard if needed."
    return
  }

  if ($DryRun) {
    Write-Ok "[dry-run] would add custom_domain route for $PublicHost"
    return
  }
  Add-Content -Path $tomlPath -Value $block -Encoding utf8
  Write-Ok "Added custom_domain route for $PublicHost"
}

function Ensure-PublicBaseUrl([string]$tomlPath) {
  $text = Get-Content -Raw -Path $tomlPath
  $updated = [regex]::Replace(
    $text,
    'PUBLIC_BASE_URL\s*=\s*"[^"]*"',
    "PUBLIC_BASE_URL = `"$PublicBaseUrl`""
  )
  # Production must not bypass Turnstile
  if ($updated -match '(?m)^\s*DEV_BYPASS_TURNSTILE\s*=') {
    $updated = [regex]::Replace(
      $updated,
      '(?m)^\s*DEV_BYPASS_TURNSTILE\s*=.*$',
      '# DEV_BYPASS_TURNSTILE removed for production by DeployScreengrabber'
    )
  }
  if (-not $DryRun -and $updated -ne $text) {
    Set-Content -Path $tomlPath -Value $updated -NoNewline -Encoding utf8
  }
  Write-Ok "PUBLIC_BASE_URL = $PublicBaseUrl (DEV_BYPASS unset for prod)"
}

function Put-Secret([string]$name, [string]$value) {
  if ($DryRun) {
    Write-Ok "[dry-run] would set secret $name"
    return
  }
  Push-Location $WorkerDir
  try {
    Set-StrictMode -Off
    $prevEa = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    # wrangler secret put reads the secret from stdin
    $value | cmd /d /c "npx wrangler secret put $name"
    $code = if (Test-Path variable:/LASTEXITCODE) { [int]$LASTEXITCODE } else { 1 }
    $ErrorActionPreference = $prevEa
    Set-StrictMode -Version Latest
    if ($code -ne 0) { throw "Failed to set secret $name (exit $code)" }
  } finally {
    Pop-Location
  }
  Write-Ok "Secret set: $name"
}

function Find-D1Id([string]$name) {
  Push-Location $WorkerDir
  try {
    $r = Invoke-Native npx wrangler d1 list --json
    $raw = $r.Text
    if ($r.ExitCode -ne 0) {
      $r2 = Invoke-Native npx wrangler d1 list
      $raw = $r2.Text
    }
  } finally {
    Pop-Location
  }

  # JSON array
  try {
    $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
    foreach ($row in @($parsed)) {
      if ($row.name -eq $name -or $row.database_name -eq $name) {
        if ($row.uuid) { return [string]$row.uuid }
        if ($row.id) { return [string]$row.id }
      }
    }
  } catch {
    # fall through to regex
  }

  # Text table / create output: "database_id = ...." or UUID near name
  if ($raw -match '(?im)database_id\s*[:=]\s*([0-9a-f-]{36})') {
    return $Matches[1]
  }
  $uuidMatches = [regex]::Matches($raw, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
  if ($uuidMatches.Count -eq 1) { return $uuidMatches[0].Value }

  # Line containing db name + uuid
  foreach ($line in ($raw -split "`n")) {
    if ($line -match [regex]::Escape($name) -and $line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
      return $Matches[1]
    }
  }
  return $null
}

function Ensure-D1 {
  Write-Step "D1 database '$DbName'"
  if ($DryRun) {
    Write-Ok "[dry-run] would ensure D1 $DbName and update wrangler.toml"
    return "00000000-0000-0000-0000-000000000000"
  }

  $existing = Find-D1Id $DbName
  if ($existing) {
    Write-Ok "Already exists: $existing"
    Set-WranglerDatabaseId $WranglerToml $existing
    return $existing
  }

  Push-Location $WorkerDir
  try {
    $created = Invoke-Native npx wrangler d1 create $DbName
    $out = $created.Text
    Write-Host $out
    if ($created.ExitCode -ne 0 -and $out -notmatch 'already exists') {
      if ($out -match 'memberships' -or $out -match 'code: 10000') {
        Write-Warn "D1 create hit a Cloudflare auth/memberships error."
        Write-Warn "Add CLOUDFLARE_ACCOUNT_ID to worker/.deploy-secrets.env (from wrangler whoami),"
        Write-Warn "and/or grant the token: User -> Memberships -> Read, Account -> D1 -> Edit."
      }
      throw "d1 create failed"
    }
  } finally {
    Pop-Location
  }

  $id = Find-D1Id $DbName
  if (-not $id -and $out -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') {
    $id = $Matches[1]
  }
  if (-not $id) { throw "Could not determine D1 database_id after create" }
  Set-WranglerDatabaseId $WranglerToml $id
  return $id
}

function Ensure-R2 {
  Write-Step "R2 bucket '$BucketName'"
  if ($DryRun) {
    Write-Ok "[dry-run] would ensure R2 bucket"
    return
  }
  Push-Location $WorkerDir
  try {
    $created = Invoke-Native npx wrangler r2 bucket create $BucketName
    $out = $created.Text
    if ($created.ExitCode -eq 0) {
      Write-Ok "Created bucket $BucketName"
    } elseif ($out -match 'already exists') {
      Write-Ok "Bucket already exists: $BucketName"
    } else {
      Write-Host $out
      if ($out -match 'enable R2' -or $out -match 'code: 10042') {
        Write-Host ""
        Write-Host "R2 is not enabled on this Cloudflare account yet." -ForegroundColor Yellow
        Write-Host "1) Open: https://dash.cloudflare.com/?to=/:account/r2"
        Write-Host "2) Click Enable / Get started for R2 (accept the free tier if prompted)."
        Write-Host "3) Re-run DeployScreengrabber.cmd"
        Write-Host ""
        throw "r2 bucket create failed (enable R2 in the Cloudflare dashboard first)"
      }
      $list = (Invoke-Native npx wrangler r2 bucket list).Text
      if ($list -match [regex]::Escape($BucketName)) {
        Write-Ok "Bucket already listed: $BucketName"
      } else {
        throw "r2 bucket create failed"
      }
    }
  } finally {
    Pop-Location
  }
}

# --- main ---

Write-Host "DeployScreengrabber - $WorkerName -> $PublicBaseUrl"
if ($DryRun) { Write-Warn "Dry run: no remote mutations" }

if (-not (Test-Path $WorkerDir)) {
  throw "Worker directory not found: $WorkerDir"
}
if (-not (Test-Path $WranglerToml)) {
  throw "Missing $WranglerToml"
}

Assert-Command node
Assert-Command npm

Write-Step "Install worker dependencies"
if (-not $DryRun) { Invoke-Npm install }

Ensure-CloudflareAuth

Ensure-PublicBaseUrl $WranglerToml
if (-not $SkipDomain) { Ensure-CustomDomainRoute $WranglerToml }

$dbId = Ensure-D1
Ensure-R2

Write-Step "Apply remote D1 migrations"
if (-not $DryRun) {
  $mig = Invoke-Wrangler d1 migrations apply $DbName --remote
  Write-Host $mig
  Write-Ok "Migrations applied"
} else {
  Write-Ok "[dry-run] would apply migrations"
}

Write-Step "Sync SDK -> js/vendor"
if (-not (Test-Path $SdkSrc)) { throw "SDK missing: $SdkSrc" }
if (-not $DryRun) {
  $vendorDir = Split-Path $SdkDst -Parent
  if (-not (Test-Path $vendorDir)) { New-Item -ItemType Directory -Path $vendorDir | Out-Null }
  Copy-Item -Path $SdkSrc -Destination $SdkDst -Force
}
Write-Ok "Updated $SdkDst"

if (-not $SkipSecrets) {
  Write-Step "Production secrets"
  $fileMap = Read-EnvFile $SecretsFile
  # Also allow baffledcat-screenshots/.deploy-secrets.env
  $alt = Join-Path $RepoRoot "baffledcat-screenshots\.deploy-secrets.env"
  foreach ($kv in (Read-EnvFile $alt).GetEnumerator()) {
    if (-not $fileMap.ContainsKey($kv.Key)) { $fileMap[$kv.Key] = $kv.Value }
  }

  $ticket = Get-SecretValue "TICKET_HMAC_SECRET" $fileMap
  if (-not $ticket) {
    $ticket = New-RandomToken 32
    Write-Warn "Generated TICKET_HMAC_SECRET (saved to worker/.deploy-secrets.env)"
  }

  $admin = Get-SecretValue "ADMIN_TOKEN" $fileMap
  if (-not $admin) {
    $admin = New-RandomToken 24
    Write-Warn "Generated ADMIN_TOKEN (saved to worker/.deploy-secrets.env)"
  }

  $turnstile = Get-SecretValue "TURNSTILE_SECRET" $fileMap
  if (-not $turnstile) {
    Write-Warn "TURNSTILE_SECRET not set. Uploads will fail Turnstile until you set it."
    Write-Warn "Set env TURNSTILE_SECRET then re-run DeployScreengrabber.ps1"
    Write-Warn "Or put TURNSTILE_SECRET=... in worker/.deploy-secrets.env"
  }

  if (-not $DryRun) {
    $persistLines = New-Object System.Collections.Generic.List[string]
    [void]$persistLines.Add("# Generated/updated by DeployScreengrabber.ps1 - do not commit")
    [void]$persistLines.Add("TICKET_HMAC_SECRET=$ticket")
    [void]$persistLines.Add("ADMIN_TOKEN=$admin")
    if ($turnstile) {
      [void]$persistLines.Add("TURNSTILE_SECRET=$turnstile")
    }
    Set-Content -Path $SecretsFile -Value $persistLines -Encoding utf8
  }

  Put-Secret "TICKET_HMAC_SECRET" $ticket
  Put-Secret "ADMIN_TOKEN" $admin
  if ($turnstile) {
    Put-Secret "TURNSTILE_SECRET" $turnstile
  }
} else {
  Write-Step "Skipping secrets (-SkipSecrets)"
}

Write-Step "Deploy Worker"
if (-not $DryRun) {
  $dep = Invoke-Wrangler deploy
  Write-Host $dep
  Write-Ok "Deployed $WorkerName"
} else {
  Write-Ok "[dry-run] would wrangler deploy"
}

Write-Step "Smoke test"
$healthUrls = @(
  $PublicBaseUrl,
  "$PublicBaseUrl/health"
)
foreach ($u in $healthUrls) {
  try {
    if ($DryRun) {
      Write-Ok "[dry-run] would GET $u"
      continue
    }
    $resp = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 30
    Write-Ok ("GET {0} -> {1}" -f $u, $resp.StatusCode)
  } catch {
    Write-Warn ("GET {0} failed: {1}" -f $u, $_.Exception.Message)
    Write-Warn ("DNS/custom domain may still be propagating; check Cloudflare Workers Domains for {0}" -f $WorkerName)
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("  API:     {0}" -f $PublicBaseUrl)
Write-Host ("  Admin:   {0}/admin" -f $PublicBaseUrl)
Write-Host ("  D1:      {0} ({1})" -f $DbName, $dbId)
Write-Host ("  R2:      {0}" -f $BucketName)
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Keep CLOUDFLARE_API_TOKEN in worker/.deploy-secrets.env for future deploys."
Write-Host "  2. Confirm Turnstile widget secret is set (TURNSTILE_SECRET)."
Write-Host "  3. Put the Turnstile site key in js/shotsConfig.js and set devBypassTurnstile: false."
Write-Host "  4. Add Mandelbrot production origin to ALLOWED_ORIGINS in wrangler.toml if needed, then re-run."
Write-Host "  5. Open admin with ADMIN_TOKEN from worker/.deploy-secrets.env"
