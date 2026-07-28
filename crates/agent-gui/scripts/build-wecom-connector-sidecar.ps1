[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc",
    [string]$PythonExecutable = "python",
    [string]$Wheelhouse = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "ArcForge WeCom Connector packaging currently supports Windows only."
}

$supportedTargets = @(
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "i686-pc-windows-msvc"
)
if ($TargetTriple -notin $supportedTargets) {
    throw "Unsupported Windows target triple for the WeCom Connector sidecar: $TargetTriple"
}

$guiRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot = (Resolve-Path (Join-Path $guiRoot "..\..")).Path
$tauriRoot = Join-Path $guiRoot "src-tauri"
$connectorRoot = Join-Path $repoRoot "connectors\wecom_aibot"
$entryPoint = Join-Path $PSScriptRoot "wecom_connector_runtime.py"
$requirements = Join-Path $PSScriptRoot "wecom-connector-requirements.txt"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$binaryPath = Join-Path $binaryDirectory "arcforge-wecom-connector-$TargetTriple.exe"
$binaryStamp = "$binaryPath.source.sha256"
$venvDirectory = Join-Path $guiRoot ".wecom-connector-venv"
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"
$dependencyStamp = Join-Path $venvDirectory ".requirements.sha256"
$workDirectory = Join-Path $tauriRoot "target\wecom-connector"
$distDirectory = Join-Path $workDirectory "dist"
$pyinstallerWorkDirectory = Join-Path $workDirectory "build"
$specDirectory = Join-Path $workDirectory "spec"
$builtBinary = Join-Path $distDirectory "arcforge-wecom-connector.exe"

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

function Get-PythonDescription {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $description = (& $Executable -c "import platform, struct, sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}|{struct.calcsize(chr(80)) * 8}|{platform.machine()}')" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.10 or newer is required to build the WeCom Connector sidecar."
    }
    return $description
}

function Assert-PythonTargetCompatible {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Description
    )

    & $Executable -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)"
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.10 through 3.13 is required to build the WeCom Connector sidecar (found $Description)."
    }
    $expectedBits = if ($TargetTriple -eq "i686-pc-windows-msvc") { "32" } else { "64" }
    $actualBits = ($Description -split "\|")[1]
    if ($actualBits -ne $expectedBits) {
        throw "The selected Python architecture ($actualBits-bit) cannot build $TargetTriple."
    }
    if ($TargetTriple -eq "aarch64-pc-windows-msvc" -and $Description -notmatch "(?i)(arm64|aarch64)$") {
        throw "An ARM64 Python installation is required to build $TargetTriple."
    }
    if ($TargetTriple -eq "x86_64-pc-windows-msvc" -and $Description -match "(?i)(arm64|aarch64)$") {
        throw "An x64 Python installation is required to build $TargetTriple."
    }
}

function Get-SourceFingerprint {
    param([Parameter(Mandatory = $true)][string]$PythonDescription)

    $paths = @(
        Get-Item -LiteralPath $entryPoint, $requirements, $PSCommandPath
        Get-ChildItem -LiteralPath $connectorRoot -File -Filter "*.py"
    ) | Sort-Object -Property FullName -Unique
    $parts = foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path.FullName -PathType Leaf)) {
            throw "Required WeCom Connector source is missing: $($path.FullName)"
        }
        $label = $path.FullName
        if ($label.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $label = $label.Substring($repoRoot.Length).TrimStart([char[]]@('\', '/'))
        }
        "$($label.Replace('\', '/'))=$((Get-FileHash -LiteralPath $path.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
    }
    return Get-TextSha256 (($parts + $PythonDescription + $TargetTriple) -join "`n")
}

$pythonCommand = Get-Command $PythonExecutable -CommandType Application -ErrorAction Stop |
    Select-Object -First 1
$pythonDescription = Get-PythonDescription -Executable $pythonCommand.Source
Assert-PythonTargetCompatible -Executable $pythonCommand.Source -Description $pythonDescription
$sourceFingerprint = Get-SourceFingerprint -PythonDescription $pythonDescription

if (-not $Force -and (Test-Path -LiteralPath $binaryPath -PathType Leaf) -and (Test-Path -LiteralPath $binaryStamp -PathType Leaf)) {
    $existingFingerprint = (Get-Content -LiteralPath $binaryStamp -Raw).Trim()
    if ($existingFingerprint -eq $sourceFingerprint) {
        Write-Host "ArcForge WeCom Connector sidecar is up to date: $binaryPath"
        return
    }
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Write-Host "Creating isolated WeCom Connector build environment..."
    & $pythonCommand.Source -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the WeCom Connector Python environment."
    }
}

$venvDescription = Get-PythonDescription -Executable $venvPython
if ($venvDescription -ne $pythonDescription) {
    throw "The existing WeCom Connector build environment uses a different Python runtime. Remove '$venvDirectory' and build again."
}

$requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant()
$requirementsFingerprint = Get-TextSha256 ($requirementsHash + "`n" + $venvDescription)
$dependenciesReady = $false
if (Test-Path -LiteralPath $dependencyStamp -PathType Leaf) {
    $installedFingerprint = (Get-Content -LiteralPath $dependencyStamp -Raw).Trim()
    if ($installedFingerprint -eq $requirementsFingerprint) {
        & $venvPython -c "import PyInstaller, aibot, aiohttp, cryptography, google.protobuf, websockets"
        $dependenciesReady = $LASTEXITCODE -eq 0
    }
}

if (-not $dependenciesReady) {
    Write-Host "Installing pinned WeCom Connector build and runtime dependencies..."
    $pipArguments = @(
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--requirement",
        $requirements
    )
    if ($Wheelhouse.Trim()) {
        $resolvedWheelhouse = (Resolve-Path -LiteralPath $Wheelhouse).Path
        $pipArguments += @("--no-index", "--find-links", $resolvedWheelhouse)
        Write-Host "Using offline wheelhouse: $resolvedWheelhouse"
    }
    & $venvPython @pipArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install WeCom Connector build dependencies."
    }
    Set-Content -LiteralPath $dependencyStamp -Value $requirementsFingerprint -Encoding ascii
}

New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $pyinstallerWorkDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $specDirectory -Force | Out-Null

Write-Host "Building ArcForge WeCom Connector sidecar..."
& $venvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "arcforge-wecom-connector" `
    --distpath $distDirectory `
    --workpath $pyinstallerWorkDirectory `
    --specpath $specDirectory `
    --paths $repoRoot `
    --collect-all aibot `
    --copy-metadata wecom-aibot-python-sdk `
    $entryPoint
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $builtBinary -PathType Leaf)) {
    throw "PyInstaller did not produce the expected WeCom Connector executable."
}

$selfTestOutput = (& $builtBinary --self-test 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "The packaged WeCom Connector failed its self-test: $selfTestOutput"
}
$selfTest = $selfTestOutput | ConvertFrom-Json
if (-not $selfTest.frozen -or -not $selfTest.dependencies.aibot -or -not $selfTest.entrypoint) {
    throw "The packaged WeCom Connector self-test reported missing bundled dependencies."
}

Copy-Item -LiteralPath $builtBinary -Destination $binaryPath -Force
Set-Content -LiteralPath $binaryStamp -Value $sourceFingerprint -Encoding ascii
$binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Built ArcForge WeCom Connector sidecar: $binaryPath"
Write-Host "SHA-256: $binaryHash"
