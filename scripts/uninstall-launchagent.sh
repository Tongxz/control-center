#!/bin/bash
#
# uninstall-launchagent.sh
# Stops and removes the LaunchAgent plist for OpenClaw Control Center.
#
set -euo pipefail

LABEL="com.openclaw.control-center"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

echo "=== OpenClaw Control Center — LaunchAgent Uninstaller ==="
echo

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Plist not found: $PLIST_PATH"
  echo "Nothing to uninstall."
  exit 0
fi

# Unload first
if launchctl list | grep -q "^${LABEL} "; then
  echo "Stopping and unloading service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
  echo "Service stopped."
else
  echo "Service not loaded (no running process found)."
fi

# Remove plist
rm -f "$PLIST_PATH"
echo "Removed: $PLIST_PATH"

echo
echo "=== Done ==="
echo "LaunchAgent has been removed. To re-install, run:"
echo "  ./scripts/install-launchagent.sh"
echo
