#!/usr/bin/env bash
# Builds the Linux installers inside WSL from a clean clone of <repo> at <tag>, then copies them to <out>.
# Usage: build-linux-wsl.sh <repo path in WSL> <tag> <out dir in WSL>
set -euo pipefail
repo="$1"; tag="$2"; out="$3"
export PATH="$HOME/.local/node/bin:$PATH"
work="$HOME/desk-build"
rm -rf "$work"
git clone --quiet --depth 1 --branch "$tag" "file://$repo" "$work"
cd "$work"
npm ci --no-audit --no-fund
NODE_OPTIONS=--max-old-space-size=6144 npx vite build
# shortcut: AppImage only; .deb needs fpm (sudo apt install ruby, gem install fpm) on this arm64 host.
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --linux AppImage --x64 --arm64 --publish never
mkdir -p "$out"
cp release/*.AppImage "$out"/
