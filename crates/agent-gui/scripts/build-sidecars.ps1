[CmdletBinding()]
param(
    [string]$TargetTriple = "x86_64-pc-windows-msvc",
    [string]$Wheelhouse = "",
    [switch]$Force,
    [switch]$SkipOffice,
    [switch]$SkipGateway,
    [switch]$SkipWecomConnector
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-SidecarBuilder {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [hashtable]$Arguments = @{}
    )

    & $Script @Arguments
}

$commonArguments = @{
    TargetTriple = $TargetTriple
    Force = [bool]$Force
}

if (-not $SkipOffice) {
    $arguments = $commonArguments.Clone()
    if ($Wheelhouse.Trim()) {
        $arguments["Wheelhouse"] = $Wheelhouse
    }
    Invoke-SidecarBuilder -Script (Join-Path $PSScriptRoot "build-office-sidecar.ps1") -Arguments $arguments
}

if (-not $SkipGateway) {
    Invoke-SidecarBuilder -Script (Join-Path $PSScriptRoot "build-gateway-sidecar.ps1") -Arguments $commonArguments
}

if (-not $SkipWecomConnector) {
    $arguments = $commonArguments.Clone()
    if ($Wheelhouse.Trim()) {
        $arguments["Wheelhouse"] = $Wheelhouse
    }
    Invoke-SidecarBuilder -Script (Join-Path $PSScriptRoot "build-wecom-connector-sidecar.ps1") -Arguments $arguments
}

Write-Host "ArcForge sidecars are ready for $TargetTriple."
