[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc",
    [string]$Wheelhouse = "",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "ArcForge Office Runtime packaging currently supports Windows only."
}

$guiRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tauriRoot = Join-Path $guiRoot "src-tauri"
$entryPoint = Join-Path $PSScriptRoot "office_runtime.py"
$requirements = Join-Path $PSScriptRoot "office-runtime-requirements.txt"
$spreadsheetScripts = Join-Path $tauriRoot "prompt\skills\arcforge-spreadsheets\scripts"
$presentationScripts = Join-Path $tauriRoot "prompt\skills\arcforge-slides\scripts"
$binaryDirectory = Join-Path $tauriRoot "binaries"
$binaryPath = Join-Path $binaryDirectory "arcforge-office-runtime-$TargetTriple.exe"
$binaryStamp = "$binaryPath.source.sha256"
$venvDirectory = Join-Path $guiRoot ".office-runtime-venv"
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"
$dependencyStamp = Join-Path $venvDirectory ".requirements.sha256"
$workDirectory = Join-Path $tauriRoot "target\office-runtime"
$distDirectory = Join-Path $workDirectory "dist"
$pyinstallerWorkDirectory = Join-Path $workDirectory "build"
$specDirectory = Join-Path $workDirectory "spec"
$builtBinary = Join-Path $distDirectory "arcforge-office-runtime.exe"

function Get-TextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash)).Replace("-", "").ToLowerInvariant()
}

function Get-SourceFingerprint {
    $paths = @(
        $entryPoint,
        $requirements,
        (Join-Path $spreadsheetScripts "spreadsheet.py"),
        (Join-Path $presentationScripts "presentation.py")
    )
    $parts = foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required Office Runtime source is missing: $path"
        }
        "$path=$((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)"
    }
    $pythonVersion = (& python --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Python 3.10 or newer is required to build the Office Runtime sidecar."
    }
    return Get-TextSha256 (($parts + $pythonVersion + $TargetTriple) -join "`n")
}

$sourceFingerprint = Get-SourceFingerprint
if (-not $Force -and (Test-Path -LiteralPath $binaryPath -PathType Leaf) -and (Test-Path -LiteralPath $binaryStamp -PathType Leaf)) {
    $existingFingerprint = (Get-Content -LiteralPath $binaryStamp -Raw).Trim()
    if ($existingFingerprint -eq $sourceFingerprint) {
        Write-Host "ArcForge Office Runtime is up to date: $binaryPath"
        return
    }
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Write-Host "Creating isolated Office Runtime build environment..."
    & python -m venv $venvDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create the Office Runtime Python environment."
    }
}

$requirementsFingerprint = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant()
$dependenciesReady = $false
if (Test-Path -LiteralPath $dependencyStamp -PathType Leaf) {
    $installedFingerprint = (Get-Content -LiteralPath $dependencyStamp -Raw).Trim()
    if ($installedFingerprint -eq $requirementsFingerprint) {
        & $venvPython -c "import PyInstaller, openpyxl, pptx, PIL, lxml, xlsxwriter"
        $dependenciesReady = $LASTEXITCODE -eq 0
    }
}

if (-not $dependenciesReady) {
    Write-Host "Installing pinned Office Runtime build dependencies..."
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
        throw "Failed to install Office Runtime build dependencies."
    }
    Set-Content -LiteralPath $dependencyStamp -Value $requirementsFingerprint -Encoding ascii
}

New-Item -ItemType Directory -Path $binaryDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $pyinstallerWorkDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $specDirectory -Force | Out-Null

Write-Host "Building ArcForge Office Runtime sidecar..."
& $venvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --console `
    --name "arcforge-office-runtime" `
    --distpath $distDirectory `
    --workpath $pyinstallerWorkDirectory `
    --specpath $specDirectory `
    --paths $spreadsheetScripts `
    --paths $presentationScripts `
    --collect-all openpyxl `
    --collect-all pptx `
    --collect-all PIL `
    --collect-all lxml `
    --copy-metadata openpyxl `
    --copy-metadata python-pptx `
    --copy-metadata Pillow `
    $entryPoint
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $builtBinary -PathType Leaf)) {
    throw "PyInstaller did not produce the expected Office Runtime executable."
}

$doctorOutput = (& $builtBinary doctor | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "The packaged Office Runtime failed its doctor check."
}
$doctor = $doctorOutput | ConvertFrom-Json
if (-not $doctor.frozen -or -not $doctor.dependencies.openpyxl -or -not $doctor.dependencies.'python-pptx') {
    throw "The packaged Office Runtime doctor check reported missing bundled dependencies."
}

Copy-Item -LiteralPath $builtBinary -Destination $binaryPath -Force
Set-Content -LiteralPath $binaryStamp -Value $sourceFingerprint -Encoding ascii
$binaryHash = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Built ArcForge Office Runtime: $binaryPath"
Write-Host "SHA-256: $binaryHash"
