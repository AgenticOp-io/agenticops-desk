#!/bin/sh
# deb passes "remove" on removal; rpm passes 0 when the last copy is erased. Upgrades keep the service running.
if [ "$1" = remove ] || [ "$1" = 0 ]; then
  command -v systemctl >/dev/null 2>&1 && systemctl disable --now agenticops-agent 2>/dev/null || true
fi
