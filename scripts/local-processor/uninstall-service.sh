#!/bin/bash
set -e

SERVICE_NAME="tender-master-processor"

systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$SERVICE_NAME.service"
systemctl --user daemon-reload

echo "Service $SERVICE_NAME removed."
