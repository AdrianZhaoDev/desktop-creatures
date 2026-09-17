param([Parameter(Mandatory = $true)][string] $RustToolchainRoot,
      [Parameter(Mandatory = $true)][string] $NodeExecutable)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
# Invoked only by build-native-candidate.mjs with a filtered environment. Never
# dot-source this into the caller's shell or inherit an existing developer shell.
$vswherePath = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) { throw 'MSVC vswhere.exe missing' }
$installationJson = & $vswherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8
if ($LASTEXITCODE -ne 0) { throw 'MSVC vswhere query failed' }
$installations = @($installationJson | ConvertFrom-Json)
if ($installations.Count -ne 1) { throw 'Exactly one selected MSVC installation is required' }
$installation = $installations[0]
$devShellPath = Join-Path $installation.installationPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $devShellPath
$null = Enter-VsDevShell -VsInstallPath $installation.installationPath -SkipAutomaticLocation -DevCmdArguments '-arch=amd64 -host_arch=amd64'
if ($env:VSCMD_ARG_TGT_ARCH -ne 'x64' -or $env:VSCMD_ARG_HOST_ARCH -ne 'x64') { throw 'MSVC bootstrap did not select host/target x64' }
$toolPaths = @{}
foreach ($name in @('cl.exe', 'link.exe', 'lib.exe', 'rc.exe', 'mt.exe')) {
    $toolPaths[$name] = (Get-Command $name -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$msvcBin = Split-Path -Parent $toolPaths['cl.exe']
$sdkBin = Split-Path -Parent $toolPaths['rc.exe']
$filtered = @{}
foreach ($name in @('INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'VCToolsVersion', 'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'UCRTVersion', 'VSCMD_ARG_TGT_ARCH', 'VSCMD_ARG_HOST_ARCH')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing developer environment variable: $name" }
    $filtered[$name] = $value
}
$filtered['PATH'] = (@((Join-Path $RustToolchainRoot 'bin'), (Split-Path -Parent $NodeExecutable), $msvcBin, $sdkBin, (Join-Path $env:SystemRoot 'System32')) -join ';')
$versions = @{}
foreach ($entry in $toolPaths.GetEnumerator()) { $versions[$entry.Key] = (Get-Item -LiteralPath $entry.Value).VersionInfo.FileVersion }
@{
    schemaVersion = 1
    kind = 'controlled-msvc-environment'
    installationPath = $installation.installationPath
    installationVersion = $installation.installationVersion
    bootstrapFiles = @($vswherePath, $devShellPath)
    tools = $toolPaths
    versions = $versions
    environment = $filtered
} | ConvertTo-Json -Depth 8 -Compress
