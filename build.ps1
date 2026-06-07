# Builds store-ready zips for Chrome/Edge and Firefox into ./dist.
#
#   Chrome/Edge -> dist/reel-it-quick-chrome.zip   (uses manifest.json)
#   Firefox     -> dist/reel-it-quick-firefox.zip  (uses manifest.firefox.json)
#
# Each zip has manifest.json + src/ at its root (what the stores expect).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$dist = Join-Path $root "dist"

# Files/folders that ship inside every package.
$payload = @("src")
# Add icons if/when they exist.
if (Test-Path (Join-Path $root "icons")) { $payload += "icons" }

function Build-Target($name, $manifestFile) {
    $stage = Join-Path $dist $name
    if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
    New-Item -ItemType Directory -Path $stage | Out-Null

    # manifest.json at the package root.
    Copy-Item (Join-Path $root $manifestFile) (Join-Path $stage "manifest.json")
    foreach ($item in $payload) {
        Copy-Item (Join-Path $root $item) (Join-Path $stage $item) -Recurse
    }

    $zip = Join-Path $dist "reel-it-quick-$name.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }

    # Build the zip manually so entry paths use forward slashes (ZIP-spec
    # compliant). Compress-Archive uses backslashes, which AMO can reject.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open(
        $zip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $stageFull = (Resolve-Path $stage).Path.TrimEnd('\') + '\'
        Get-ChildItem $stage -Recurse -File | ForEach-Object {
            $rel = $_.FullName.Substring($stageFull.Length).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $_.FullName, $rel,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $archive.Dispose()
    }
    Write-Host "Built $zip"
}

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory -Path $dist | Out-Null

Build-Target "chrome"  "manifest.json"
Build-Target "firefox" "manifest.firefox.json"

Write-Host "Done. Upload the zips from the dist/ folder to each store."
