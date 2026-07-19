[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MpvRoot,

    [Parameter(Mandatory = $true)]
    [string]$RedistributorRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-StrictMode -Version Latest

function Resolve-OrCreateDirectory([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    [System.IO.Directory]::CreateDirectory($full) | Out-Null
    return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar)
}

function Assert-ChildPath([string]$Child, [string]$Parent) {
    $childFull = [System.IO.Path]::GetFullPath($Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $prefix = $parentFull + [System.IO.Path]::DirectorySeparatorChar
    if (-not $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem operation outside expected root: $childFull"
    }
}

function Remove-ChildTree([string]$Path, [string]$Parent) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    Assert-ChildPath -Child $Path -Parent $Parent
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Get-RelativePath([string]$Base, [string]$Target) {
    return [System.IO.Path]::GetRelativePath($Base, $Target).Replace('\', '/')
}

function Get-SafeRelativeDirectory([string]$Relative) {
    return ($Relative -replace '[^A-Za-z0-9._/-]', '_' -replace '/', '__')
}

function Get-GitValue([string]$Repository, [string[]]$Arguments) {
    $previous = $PSNativeCommandUseErrorActionPreference
    $script:PSNativeCommandUseErrorActionPreference = $false
    try {
        $value = & git -C $Repository @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) {
            return $null
        }
        return (($value | Out-String).Trim())
    } finally {
        $script:PSNativeCommandUseErrorActionPreference = $previous
    }
}

function Copy-DirectoryTree([string]$Source, [string]$Destination, [string[]]$ExcludedDirectories = @()) {
    [System.IO.Directory]::CreateDirectory($Destination) | Out-Null
    $arguments = @(
        $Source,
        $Destination,
        '/E',
        '/COPY:DAT',
        '/DCOPY:DAT',
        '/R:2',
        '/W:1',
        '/XJ',
        '/NFL',
        '/NDL',
        '/NJH',
        '/NJS',
        '/NP'
    )
    if ($ExcludedDirectories.Count -gt 0) {
        $arguments += '/XD'
        $arguments += $ExcludedDirectories
    }

    # Copy-Item -Recurse can fail on otherwise valid third-party source trees
    # (SDL's Android project triggered this on the GitHub Windows runner).
    # Robocopy handles those trees and reports 0..7 for successful outcomes.
    $previous = $PSNativeCommandUseErrorActionPreference
    $script:PSNativeCommandUseErrorActionPreference = $false
    try {
        & robocopy.exe @arguments | Out-Host
        $code = $LASTEXITCODE
    } finally {
        $script:PSNativeCommandUseErrorActionPreference = $previous
    }
    if ($code -gt 7) {
        throw "Robocopy failed with exit code $code while copying $Source"
    }
}

function Copy-SourceTree([string]$Source, [string]$Destination) {
    Copy-DirectoryTree -Source $Source -Destination $Destination -ExcludedDirectories @(
        (Join-Path $Source '.git')
    )
}

$mpv = (Resolve-Path -LiteralPath $MpvRoot).Path.TrimEnd('\')
$redistributor = (Resolve-Path -LiteralPath $RedistributorRoot).Path.TrimEnd('\')
$output = Resolve-OrCreateDirectory -Path $OutputDir
$stageName = 'mpv-v0.41.0-complete-corresponding-source'
$stage = Join-Path $output $stageName
$binaryStage = Join-Path $output 'mpv-v0.41.0-windows-x64-gpl'

foreach ($requiredBinary in @('mpv.exe', 'mpv.com', 'mpv.pdb', 'vulkan-1.dll')) {
    $candidate = Join-Path $mpv "build/$requiredBinary"
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Missing expected build output: $candidate"
    }
}

Remove-ChildTree -Path $stage -Parent $output
Remove-ChildTree -Path $binaryStage -Parent $output
[System.IO.Directory]::CreateDirectory($stage) | Out-Null
[System.IO.Directory]::CreateDirectory($binaryStage) | Out-Null

Copy-DirectoryTree -Source $mpv -Destination $stage -ExcludedDirectories @(
    (Join-Path $mpv '.git'),
    (Join-Path $mpv 'build'),
    (Join-Path $mpv 'cmake'),
    (Join-Path $mpv '.ccache')
)

$repositoryRoots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $mpv -Force -Recurse -Filter '.git' | ForEach-Object {
    # Nested checkouts can expose either a real .git directory or a gitfile.
    $repositoryRoot = if ($_.PSIsContainer) { $_.Parent.FullName } else { $_.Directory.FullName }
    [void]$repositoryRoots.Add($repositoryRoot)
}
[void]$repositoryRoots.Add($mpv)

$repositories = @()
foreach ($repository in ($repositoryRoots | Sort-Object)) {
    $commit = Get-GitValue -Repository $repository -Arguments @('rev-parse', 'HEAD')
    if (-not $commit) {
        continue
    }
    $relative = if ($repository -eq $mpv) { '.' } else { Get-RelativePath -Base $mpv -Target $repository }
    $repositories += [ordered]@{
        path = $relative
        origin = Get-GitValue -Repository $repository -Arguments @('remote', 'get-url', 'origin')
        commit = $commit
        describe = Get-GitValue -Repository $repository -Arguments @('describe', '--always', '--dirty')
        status = Get-GitValue -Repository $repository -Arguments @('status', '--short', '--untracked-files=no')
    }

    if ($repository.StartsWith((Join-Path $mpv 'build') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $copyName = Get-SafeRelativeDirectory -Relative $relative
        $destination = Join-Path $stage "build-fetched-git/$copyName"
        Copy-SourceTree -Source $repository -Destination $destination
    }
}

$buildFetchedRoot = Join-Path $stage 'build-fetched-cmake'
$copiedFetchedSources = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath (Join-Path $mpv 'build') -Directory -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like '*-src' } |
    ForEach-Object {
        $source = $_.FullName
        $insideKnownRepository = $false
        foreach ($repository in $repositoryRoots) {
            if ($repository -ne $mpv -and $source.StartsWith($repository + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                $insideKnownRepository = $true
                break
            }
        }
        if (-not $insideKnownRepository -and $copiedFetchedSources.Add($source)) {
            $relative = Get-RelativePath -Base (Join-Path $mpv 'build') -Target $source
            $destination = Join-Path $buildFetchedRoot (Get-SafeRelativeDirectory -Relative $relative)
            Copy-SourceTree -Source $source -Destination $destination
        }
    }

$redistributorEvidence = Join-Path $stage 'redistributor-build'
[System.IO.Directory]::CreateDirectory((Join-Path $redistributorEvidence '.github/workflows')) | Out-Null
[System.IO.Directory]::CreateDirectory((Join-Path $redistributorEvidence 'scripts')) | Out-Null
Copy-Item -LiteralPath (Join-Path $redistributor '.github/workflows/mpv-gpl-bundle.yml') -Destination (Join-Path $redistributorEvidence '.github/workflows/mpv-gpl-bundle.yml')
Copy-Item -LiteralPath (Join-Path $redistributor 'scripts/package-mpv-corresponding-source.ps1') -Destination (Join-Path $redistributorEvidence 'scripts/package-mpv-corresponding-source.ps1')

$buildEvidence = Join-Path $stage 'build-evidence'
[System.IO.Directory]::CreateDirectory($buildEvidence) | Out-Null
foreach ($evidence in @(
    'build/meson-logs/meson-log.txt',
    'build/meson-info/intro-buildoptions.json',
    'build/meson-info/intro-dependencies.json'
)) {
    $source = Join-Path $mpv $evidence
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination $buildEvidence
    }
}

(& (Join-Path $mpv 'build/mpv.com') --version 2>&1 | Out-String).Trim() |
    Set-Content -LiteralPath (Join-Path $buildEvidence 'mpv-version.txt') -Encoding utf8
if (Get-Command dumpbin.exe -ErrorAction SilentlyContinue) {
    (& dumpbin.exe /dependents (Join-Path $mpv 'build/mpv.exe') 2>&1 | Out-String).Trim() |
        Set-Content -LiteralPath (Join-Path $buildEvidence 'mpv-dll-dependencies.txt') -Encoding utf8
}

$toolVersions = @(
    "git: $(& git --version)",
    "python: $(& python --version 2>&1)",
    "meson: $(& meson --version)",
    "cmake: $((& cmake --version | Select-Object -First 1))",
    "ninja: $(& ninja --version)",
    "nasm: $(& nasm -v)"
)
$toolVersions | Set-Content -LiteralPath (Join-Path $buildEvidence 'tool-versions.txt') -Encoding utf8

$readme = @'
# Complete corresponding source for the bundled mpv binary

This archive is the source snapshot captured by the same isolated job that built the accompanying Windows x64 mpv binary.

It includes:

- mpv source and its build scripts;
- all Meson wrap subprojects downloaded for the build;
- nested Git repositories and CMake-fetched source trees found after the build;
- the redistributor workflow and packaging script;
- exact Git revisions, dirty-state evidence, Meson options, dependency inventory and tool versions.

The binary is built with `-Dgpl=true`, `-Dffmpeg:gpl=enabled` and static fallback libraries. See `SOURCE-MANIFEST.json`, `build-evidence/` and `redistributor-build/`.
'@
$readme | Set-Content -LiteralPath (Join-Path $stage 'README-CORRESPONDING-SOURCE.md') -Encoding utf8

Get-ChildItem -LiteralPath $stage -Force -Recurse -Filter '.git' | ForEach-Object {
    Remove-ChildTree -Path $_.FullName -Parent $stage
}

$requiredSourcePaths = @(
    'LICENSE.GPL',
    'Copyright',
    'meson.build',
    'ci/build-win32.ps1',
    'subprojects/ffmpeg',
    'subprojects/libass',
    'subprojects/libplacebo',
    'redistributor-build/.github/workflows/mpv-gpl-bundle.yml'
)
foreach ($relative in $requiredSourcePaths) {
    if (-not (Test-Path -LiteralPath (Join-Path $stage $relative))) {
        throw "Corresponding-source closure is incomplete; missing $relative"
    }
}

$files = Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{
        path = Get-RelativePath -Base $stage -Target $_.FullName
        bytes = $_.Length
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
}
$sourceManifest = [ordered]@{
    schemaVersion = 1
    mpvCommit = Get-GitValue -Repository $mpv -Arguments @('rev-parse', 'HEAD')
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    requiredSourcePaths = $requiredSourcePaths
    repositories = $repositories
    files = $files
}
$sourceManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'SOURCE-MANIFEST.json') -Encoding utf8

foreach ($file in @('mpv.exe', 'mpv.com', 'mpv.pdb', 'vulkan-1.dll')) {
    Copy-Item -LiteralPath (Join-Path $mpv "build/$file") -Destination $binaryStage
}
foreach ($file in @('mpv-register.bat', 'mpv-unregister.bat')) {
    $source = Join-Path $mpv "build/$file"
    if (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination $binaryStage
    }
}
Copy-Item -LiteralPath (Join-Path $stage 'LICENSE.GPL') -Destination $binaryStage
Copy-Item -LiteralPath (Join-Path $stage 'Copyright') -Destination $binaryStage

$sourceArchive = Join-Path $output "$stageName.zip"
$binaryArchive = Join-Path $output 'mpv-v0.41.0-windows-x64-gpl.zip'
foreach ($archive in @($sourceArchive, $binaryArchive)) {
    if (Test-Path -LiteralPath $archive) {
        Remove-Item -LiteralPath $archive -Force
    }
}
$sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
Push-Location $output
try {
    & $sevenZip a -tzip -mm=Deflate -mx=9 $sourceArchive $stageName | Out-Host
    & $sevenZip a -tzip -mm=Deflate -mx=9 $binaryArchive (Split-Path -Leaf $binaryStage) | Out-Host
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) {
    throw "7-Zip failed with exit code $LASTEXITCODE"
}

$releaseManifest = [ordered]@{
    schemaVersion = 1
    mpvCommit = $sourceManifest.mpvCommit
    binaryArchive = [ordered]@{
        file = Split-Path -Leaf $binaryArchive
        bytes = (Get-Item -LiteralPath $binaryArchive).Length
        sha256 = (Get-FileHash -LiteralPath $binaryArchive -Algorithm SHA256).Hash
    }
    correspondingSourceArchive = [ordered]@{
        file = Split-Path -Leaf $sourceArchive
        bytes = (Get-Item -LiteralPath $sourceArchive).Length
        sha256 = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash
        fileCount = $files.Count + 1
        repositoryCount = $repositories.Count
    }
}
$releaseManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'GPL-BUNDLE-MANIFEST.json') -Encoding utf8
$releaseManifest | ConvertTo-Json -Depth 6
