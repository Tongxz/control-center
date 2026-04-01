#!/bin/bash
#
# install-launchagent.sh
# Generates and installs com.openclaw.control-center.plist for LaunchAgent auto-start.
#
set -euo pipefail

LABEL="com.openclaw.control-center"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Determine node path
NODE_PATH="$(command -v node 2>/dev/null || echo '/usr/local/bin/node')"

echo "=== OpenClaw Control Center — LaunchAgent Installer ==="
echo

# Validate project dir exists
if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "ERROR: Project directory not found: $PROJECT_DIR" >&2
  exit 1
fi

# Validate server.js exists
if [[ ! -f "$PROJECT_DIR/server.js" ]]; then
  echo "ERROR: server.js not found in $PROJECT_DIR" >&2
  exit 1
fi

echo "Project dir : $PROJECT_DIR"
echo "Node path   : $NODE_PATH"
echo "Plist path  : $PLIST_PATH"
echo

# Unload existing service if already loaded (ignore errors)
if launchctl list | grep -q "^${LABEL} "; then
  echo "Stopping existing service..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create ~/Library/LaunchAgents if it doesn't exist
mkdir -p "$HOME/Library/LaunchAgents"

# Generate plist
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_DIR}/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/runtime/launchagent.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/runtime/launchagent.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

echo "Generated: $PLIST_PATH"

# Load the service
launchctl load "$PLIST_PATH"
echo "Service loaded."

echo
echo "=== Done ==="
echo "Service will auto-start on next login / reboot."
echo "To start manually  : launchctl start ${LABEL}"
echo "To stop           : launchctl stop ${LABEL}"
echo "To unload         : launchctl unload ${LABEL}"
echo "To remove entirely: ./scripts/uninstall-launchagent.sh"
echo
