#!/usr/bin/env bash
# Builds the cloud agent's .deb and .rpm (arch-independent) into release/. Run in WSL or Linux from the repo root.
set -euo pipefail
NFPM_VERSION=2.49.0
version="$(node -p 'require("./package.json").version' 2>/dev/null || sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)"
case "$(uname -m)" in aarch64|arm64) a=arm64 ;; *) a=x86_64 ;; esac
tools="$HOME/.cache/nfpm-$NFPM_VERSION"
if [ ! -x "$tools/nfpm" ]; then
  mkdir -p "$tools"
  base="https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION"
  tar="nfpm_${NFPM_VERSION}_Linux_$a.tar.gz"
  curl -fsSL -o "$tools/$tar" "$base/$tar"
  curl -fsSL -o "$tools/checksums.txt" "$base/checksums.txt"
  (cd "$tools" && grep " $tar\$" checksums.txt | sha256sum -c -)
  tar -xzf "$tools/$tar" -C "$tools" nfpm
fi
mkdir -p release
out="$PWD/release"
cd agent/pkg
for p in deb rpm; do VERSION="$version" "$tools/nfpm" pkg -f nfpm.yaml -p "$p" -t "$out/"; done
