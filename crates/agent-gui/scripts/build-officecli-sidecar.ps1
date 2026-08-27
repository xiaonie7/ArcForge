[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc",
    [string]$OfficeCliBinary = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$officeCliVersion = "1.0.144"
$officeCliAsset = "officecli-win-x64.exe"
$officeCliSha256 = "e780cc6a5385f84b4d54d71b0c179904ed534125ec33fe39b1a8711fa80e387e"
$releaseUrl = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v$officeCliVersion/$officeCliAsset"

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "ArcForge OfficeCLI packaging currently supports Windows only."
}
if ($TargetTriple -ne "x86_64-pc-windows-msvc") {
    throw "OfficeCLI packaging currently supports only x86_64-pc-windows-msvc."
}

$guiRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tauriRoot = Join-Path $guiRoot "src-tauri"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$binaryPath = Join-Path $binaryDirectory "arcforge-officecli-$TargetTriple.exe"
$binaryStamp = "$binaryPath.source.sha256"
$workDirectory = Join-Path $tauriRoot "target\officecli-sidecar\$TargetTriple"
$cachedBinary = Join-Path $workDirectory $officeCliAsset

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha256.ComputeHash($bytes)
    }
    finally {
        $sha256.Dispose()
    }
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
}

function Get-VerifiedHash {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "OfficeCLI binary does not exist: $Path"
    }
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $officeCliSha256) {
        throw "OfficeCLI SHA-256 mismatch for $Path. Expected $officeCliSha256, got $hash."
    }
    return $hash
}

function Resolve-InputBinary {
    if ($OfficeCliBinary.Trim()) {
        return (Resolve-Path -LiteralPath $OfficeCliBinary).Path
    }
    if (Test-Path -LiteralPath $cachedBinary -PathType Leaf) {
        return $cachedBinary
    }

    New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null
    Write-Host "Downloading OfficeCLI v$officeCliVersion..."
    Invoke-WebRequest -Uri $releaseUrl -OutFile $cachedBinary -UseBasicParsing
    return $cachedBinary
}

$sourceScript = $PSCommandPath
$sourceFingerprint = Get-TextSha256 ((Get-FileHash -LiteralPath $sourceScript -Algorithm SHA256).Hash.ToLowerInvariant() +
    "|$officeCliVersion|$officeCliSha256|$TargetTriple")
if (-not $Force -and (Test-Path -LiteralPath $binaryPath -PathType Leaf) -and
    (Test-Path -LiteralPath $binaryStamp -PathType Leaf) -and
    (Get-Content -LiteralPath $binaryStamp -Raw).Trim() -eq $sourceFingerprint) {
    $builtHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($builtHash -eq $officeCliSha256) {
        Write-Host "ArcForge OfficeCLI sidecar is up to date: $binaryPath"
        return
    }
    Write-Warning "ArcForge OfficeCLI sidecar hash changed; rebuilding the verified binary."
}

$inputBinary = Resolve-InputBinary
$actualHash = Get-VerifiedHash -Path $inputBinary
New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
Copy-Item -LiteralPath $inputBinary -Destination $binaryPath -Force
Set-Content -LiteralPath $binaryStamp -Value $sourceFingerprint -Encoding ascii

Write-Host "Built ArcForge OfficeCLI sidecar: $binaryPath"
Write-Host "Version: $officeCliVersion"
Write-Host "SHA-256: $actualHash"
