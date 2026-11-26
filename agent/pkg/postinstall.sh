#!/bin/sh
set -e
id agenticops-agent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/agenticops-agent --shell /usr/sbin/nologin agenticops-agent
mkdir -p /var/lib/agenticops-agent
chown agenticops-agent: /var/lib/agenticops-agent
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  if systemctl is-enabled --quiet agenticops-agent 2>/dev/null; then systemctl restart agenticops-agent || true; fi
fi
echo "AgenticOps agent installed. Fill in /etc/agenticops-agent/agent.env, then: sudo systemctl enable --now agenticops-agent"
