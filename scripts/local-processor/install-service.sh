#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="tender-master-processor"
ENV_DIR="$HOME/.config/tender-master"
ENV_FILE="$ENV_DIR/env"

echo "=== Tender Master Local Processor Setup ==="

# Check prerequisites
if ! command -v claude &>/dev/null; then
  echo "Error: claude CLI not found. Install it first."
  exit 1
fi

if ! command -v npx &>/dev/null; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

# Setup env file with secret
mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  read -p "Enter CONVEX_LOCAL_PROCESSOR_SECRET: " SECRET
  echo "CONVEX_SECRET=$SECRET" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Saved secret to $ENV_FILE"
else
  echo "Using existing $ENV_FILE"
fi

# Install deps
echo "Installing dependencies..."
cd "$SCRIPT_DIR"
npm install

# Export profiles
echo "Exporting profiles..."
npx tsx export-profiles.ts

# Copy and enable service
mkdir -p "$HOME/.config/systemd/user"
cp "$SCRIPT_DIR/$SERVICE_NAME.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo ""
echo "=== Done! ==="
echo "View logs: journalctl --user -u $SERVICE_NAME -f"
echo "Stop: systemctl --user stop $SERVICE_NAME"
echo "Restart: systemctl --user restart $SERVICE_NAME"
