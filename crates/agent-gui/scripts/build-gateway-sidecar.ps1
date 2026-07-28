[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc",
    [string]$GoExecutable = "go",
    [string]$PnpmExecutable = "pnpm",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "ArcForge Gateway sidecar packaging currently supports Windows only."
}

$guiRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $guiRoot "..\..")).Path
$gatewayRoot = Join-Path $repoRoot "crates\agent-gateway"
$gatewayWebRoot = Join-Path $gatewayRoot "web"
$gatewayWebDist = Join-Path $gatewayWebRoot "dist"
$tauriRoot = Join-Path $guiRoot "src-tauri"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$binaryPath = Join-Path $binaryDirectory "arcforge-gateway-$TargetTriple.exe"
$binaryStamp = "$binaryPath.source.sha256"
$workDirectory = Join-Path $tauriRoot "target\gateway-sidecar\$TargetTriple"
$builtBinary = Join-Path $workDirectory "arcforge-gateway.exe"

$targetArchitectures = @{
    "x86_64-pc-windows-msvc" = "amd64"
    "aarch64-pc-windows-msvc" = "arm64"
    "i686-pc-windows-msvc" = "386"
}
if (-not $targetArchitectures.ContainsKey($TargetTriple)) {
    throw "Unsupported Windows target triple for the Gateway sidecar: $TargetTriple"
}
$goArchitecture = $targetArchitectures[$TargetTriple]

if (-not (Test-Path -LiteralPath (Join-Path $gatewayRoot "go.mod") -PathType Leaf)) {
    throw "ArcForge Gateway source is missing: $gatewayRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $gatewayWebRoot "package.json") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $gatewayWebRoot "pnpm-lock.yaml") -PathType Leaf)) {
    throw "ArcForge Gateway Web UI source is missing: $gatewayWebRoot"
}

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

function Resolve-GoExecutable {
    try {
        $command = Get-Command $GoExecutable -CommandType Application -ErrorAction Stop |
            Select-Object -First 1
    }
    catch {
        throw "Go 1.25.12 or newer is required to build the Gateway sidecar."
    }
    return $command.Source
}

function Resolve-PnpmExecutable {
    try {
        $command = Get-Command $PnpmExecutable -ErrorAction Stop |
            Select-Object -First 1
    }
    catch {
        throw "pnpm is required to build the Gateway Web UI before packaging the sidecar."
    }
    return $command.Source
}

function Build-GatewayWebAssets {
    $webEntryPoint = Join-Path $gatewayWebDist "index.html"
    $resolvedPnpm = [string](Resolve-PnpmExecutable)
    Write-Host "Installing locked ArcForge Gateway Web UI dependencies..."
    Push-Location $gatewayWebRoot
    try {
        & $resolvedPnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install the Gateway Web UI dependencies."
        }

        Write-Host "Building ArcForge Gateway Web UI..."
        & $resolvedPnpm run build
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to build the Gateway Web UI."
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $webEntryPoint -PathType Leaf)) {
        throw "The Gateway Web UI build did not produce the expected file: $webEntryPoint"
    }
}

function Initialize-GoRoot {
    param([Parameter(Mandatory = $true)][string]$ResolvedGo)

    if ($env:GOROOT) {
        return
    }
    $goBinDirectory = Split-Path -Parent $ResolvedGo
    $goRootCandidate = Split-Path -Parent $goBinDirectory
    $candidates = @(
        $goRootCandidate,
        (Join-Path $goRootCandidate "go")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "src\runtime") -PathType Container) {
            $env:GOROOT = $candidate
            return
        }
    }
}

function Get-SourceFiles {
    $sourceFiles = @(
        Get-Item -LiteralPath (Join-Path $gatewayRoot "go.mod"), (Join-Path $gatewayRoot "go.sum"), $PSCommandPath
        Get-ChildItem -LiteralPath $gatewayRoot -File -Filter "*.go" |
            Where-Object { -not $_.Name.EndsWith("_test.go", [System.StringComparison]::OrdinalIgnoreCase) }
        Get-ChildItem -LiteralPath (Join-Path $gatewayRoot "cmd") -Recurse -File -Filter "*.go" |
            Where-Object { -not $_.Name.EndsWith("_test.go", [System.StringComparison]::OrdinalIgnoreCase) }
        Get-ChildItem -LiteralPath (Join-Path $gatewayRoot "internal") -Recurse -File -Filter "*.go" |
            Where-Object { -not $_.Name.EndsWith("_test.go", [System.StringComparison]::OrdinalIgnoreCase) }
        Get-ChildItem -LiteralPath $gatewayWebRoot -File |
            Where-Object { -not $_.Name.EndsWith(".tsbuildinfo", [System.StringComparison]::OrdinalIgnoreCase) }
        Get-ChildItem -LiteralPath (Join-Path $gatewayWebRoot "public") -Recurse -File
        Get-ChildItem -LiteralPath (Join-Path $gatewayWebRoot "src") -Recurse -File
    )
    return $sourceFiles | Sort-Object -Property FullName -Unique
}

function Get-SourceFingerprint {
    param([Parameter(Mandatory = $true)][string]$GoVersion)

    $parts = foreach ($file in Get-SourceFiles) {
        if (-not (Test-Path -LiteralPath $file.FullName -PathType Leaf)) {
            throw "Required Gateway source is missing: $($file.FullName)"
        }
        $label = $file.FullName
        if ($label.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $label = $label.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
        }
        "$($label.Replace('\', '/'))=$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
    }
    return Get-TextSha256 (($parts + $GoVersion + $TargetTriple + "CGO_ENABLED=0") -join "`n")
}

$resolvedGo = [string](Resolve-GoExecutable)
$previousGoRoot = $env:GOROOT
Initialize-GoRoot -ResolvedGo $resolvedGo
try {
    $goVersion = (& $resolvedGo version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to run the Go toolchain: $goVersion"
    }

    $sourceFingerprint = Get-SourceFingerprint -GoVersion $goVersion
    if (-not $Force -and (Test-Path -LiteralPath $binaryPath -PathType Leaf) -and (Test-Path -LiteralPath $binaryStamp -PathType Leaf)) {
        $existingFingerprint = (Get-Content -LiteralPath $binaryStamp -Raw).Trim()
        if ($existingFingerprint -eq $sourceFingerprint) {
            Write-Host "ArcForge Gateway sidecar is up to date: $binaryPath"
            return
        }
    }

    Build-GatewayWebAssets

    New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $workDirectory -Force | Out-Null

    $previousGoOs = $env:GOOS
    $previousGoArch = $env:GOARCH
    $previousCgoEnabled = $env:CGO_ENABLED
    $previousGoWork = $env:GOWORK
    try {
        $env:GOOS = "windows"
        $env:GOARCH = $goArchitecture
        $env:CGO_ENABLED = "0"
        $env:GOWORK = "off"

        Write-Host "Building ArcForge Gateway sidecar for $TargetTriple..."
        Push-Location $gatewayRoot
        try {
            & $resolvedGo build `
                -mod=readonly `
                -trimpath `
                -buildvcs=false `
                -ldflags "-s -w" `
                -o $builtBinary `
                ".\cmd\gateway"
            if ($LASTEXITCODE -ne 0) {
                throw "Go did not build the Gateway sidecar successfully."
            }
        }
        finally {
            Pop-Location
        }
    }
    finally {
        $env:GOOS = $previousGoOs
        $env:GOARCH = $previousGoArch
        $env:CGO_ENABLED = $previousCgoEnabled
        $env:GOWORK = $previousGoWork
    }

    if (-not (Test-Path -LiteralPath $builtBinary -PathType Leaf)) {
        throw "Go did not produce the expected Gateway executable."
    }

    Copy-Item -LiteralPath $builtBinary -Destination $binaryPath -Force
    Set-Content -LiteralPath $binaryStamp -Value $sourceFingerprint -Encoding ascii
    $binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Built ArcForge Gateway sidecar: $binaryPath"
    Write-Host "SHA-256: $binaryHash"
}
finally {
    $env:GOROOT = $previousGoRoot
}
