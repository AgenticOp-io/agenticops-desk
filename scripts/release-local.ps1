# Builds and publishes a release on this computer instead of GitHub Actions: Windows here, Linux in WSL.
# macOS cannot be built off a Mac: run the Release workflow with only=mac for those files.
# Windows, plus the Android APK when the Android SDK is installed; Linux too with -Linux.
# Usage: pwsh scripts/release-local.ps1 [-Tag v0.1.43] [-Linux]   (default: the version in package.json)
# Needs: the tag already pushed, `gh` signed in, WSL Ubuntu with Node in ~/.local/node (and ruby + fpm for .deb),
# and the patch signing key in $env:PATCH_SIGNING_KEY or the file ~/.agenticops-patch-key.
param([string]$Tag, [switch]$Linux)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$here = Split-Path -Parent $PSScriptRoot
if (-not $Tag) { $Tag = "v" + (Get-Content "$here/package.json" -Raw | ConvertFrom-Json).version }
$gitDir = (Resolve-Path (git -C $here rev-parse --git-common-dir)).Path
Push-Location $here; $repo = gh repo view --json nameWithOwner --jq .nameWithOwner; Pop-Location
git -C $here rev-parse --verify --quiet "refs/tags/$Tag" | Out-Null

if (-not $env:PATCH_SIGNING_KEY) {
  $keyFile = Join-Path $HOME ".agenticops-patch-key"
  if (-not (Test-Path $keyFile)) { throw "Set PATCH_SIGNING_KEY or put the key in $keyFile" }
  $env:PATCH_SIGNING_KEY = Get-Content $keyFile -Raw
}

# Build from a clean clone at the tag, like CI, so local edits never ship.
$work = Join-Path $env:TEMP "desk-release"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
git clone --quiet --depth 1 --branch $Tag "file://$($gitDir -replace '\\','/')" $work
Push-Location $work
try {
  # Installed copies update only to a higher version, so an installer must carry its tag's number and be newer than what is out.
  $version = (Get-Content "$work/package.json" -Raw | ConvertFrom-Json).version
  if ("v$version" -ne $Tag) { throw "package.json at $Tag says $version. Bump it to $($Tag -replace '^v') and re-tag." }
  $latest = gh release list --repo $repo --limit 20 --json tagName,isDraft --jq '.[] | select(.isDraft | not) | .tagName' |
    Where-Object { $_ -ne $Tag } | Sort-Object { [version]($_ -replace '^v', '') } -Descending | Select-Object -First 1
  if ($latest -and [version]$version -le [version]($latest -replace '^v', '')) { throw "$Tag is not newer than the published $latest; installed copies would not update." }

  npm ci --no-audit --no-fund
  npx tsc --noEmit
  npm test
  $env:NODE_OPTIONS = "--max-old-space-size=6144"
  npx vite build
  $env:NODE_OPTIONS = $null
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
  npx electron-builder --win --x64 --arm64 --publish never
  node scripts/make-patch.mjs

  if ($Linux) {
  $toWsl = { param($p) wsl -d Ubuntu -- wslpath -a ($p -replace '\\', '/') }
  wsl -d Ubuntu -- bash (& $toWsl "$work/scripts/build-linux-wsl.sh") (& $toWsl $gitDir) $Tag (& $toWsl "$work/release")
  }

  # The phone app, when this computer has the Android SDK. Debug-signed: sideload only, not for the Play Store.
  if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = [Environment]::GetEnvironmentVariable("ANDROID_HOME", "User"); $env:JAVA_HOME = [Environment]::GetEnvironmentVariable("JAVA_HOME", "User") }
  if ($env:ANDROID_HOME) {
    npx vite build --config mobile/vite.config.ts
    npx cap sync android
    # --no-daemon: a Gradle daemon keeps the pipe open after the build and the script never returns.
    Push-Location android; try { ./gradlew.bat assembleDebug --no-daemon -q } finally { Pop-Location }
    Copy-Item android/app/build/outputs/apk/debug/AgenticOps-Remote-*-debug.apk "release/AgenticOps-Remote-$Tag.apk"
  }

  $files = Get-ChildItem release -File | Where-Object { $_.Name -match '\.(exe|AppImage|deb|apk)$|^patch' } | ForEach-Object FullName
  if (-not $files) { throw "Nothing was built" }

  try { gh release view $Tag --repo $repo *> $null }
  catch {
    gh release create $Tag --repo $repo --draft --prerelease --title "AgenticOps Desk $Tag beta" --notes "Beta, built locally: Windows. Installed copies check the git tags of this private repository."
  }
  gh release upload $Tag @files --repo $repo --clobber
  gh release edit $Tag --repo $repo --draft=false --prerelease

  # Same rule as the workflow: keep the three newest published releases; git tags stay.
  gh release list --repo $repo --limit 200 --json tagName,isDraft --jq '.[] | select(.isDraft | not) | .tagName' |
    Sort-Object { [version]($_ -replace '^v', '') } -Descending | Select-Object -Skip 3 |
    ForEach-Object { gh release delete $_ --repo $repo --yes }
} finally {
  Pop-Location
}
