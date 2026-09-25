#!/bin/bash
# Install Roon Display.command
#
# Double-click this file in Finder to install or update everything:
#   - roon-local-services/ -> /Applications/roon-local-services/
#   - display_ui.html + display_ui.js -> Roon.app's own webroot
#
# Safe to re-run for updates: .env and config.json are NEVER overwritten if
# they already exist at the destination (they hold your keys/settings).
# Everything else is always replaced with what's in this folder.
#
# Expected folder layout (this file must stay next to these):
#   Install Roon Display.command   <- this file
#   roon-local-services/
#       server.js, ai.js, admin.js, admin.html, config.json, package.json
#   display_ui.html
#   display_ui.js

set -u  # unset variables are an error; deliberately NOT -e, since several
        # steps below are allowed to fail (permission checks, IP detection)
        # without aborting the whole install -- each is checked explicitly.

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_SERVICES="/Applications/roon-local-services"
PLIST_LABEL="local.roondisplay.proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/local_roondisplay_proxy.plist"
ROON_WEBROOT="/Applications/Roon.app/Contents/Resources/webroot"

BOLD=$(tput bold 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)
GREEN=$(tput setaf 2 2>/dev/null || true)
YELLOW=$(tput setaf 3 2>/dev/null || true)
RED=$(tput setaf 1 2>/dev/null || true)

heading() { echo ""; echo "${BOLD}== $1 ==${RESET}"; }
ok()      { echo "${GREEN}[ok]${RESET} $1"; }
warn()    { echo "${YELLOW}[!]${RESET} $1"; }
fail()    { echo "${RED}[error]${RESET} $1"; }

echo "${BOLD}Roon Display -- installer${RESET}"
echo "Source: $SOURCE_DIR"

# ---------------------------------------------------------------------------
# 1. Preliminary checks
# ---------------------------------------------------------------------------

heading "Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not found. Install it first (e.g. from nodejs.org or 'brew install node'), then run this again."
    read -p "Press Enter to close..."
    exit 1
fi
NODE_PATH="$(which node)"
ok "Node found at $NODE_PATH ($(node --version))"

if ! command -v npm >/dev/null 2>&1; then
    fail "npm not found (usually ships with Node -- something's off with your Node install)."
    read -p "Press Enter to close..."
    exit 1
fi
ok "npm found ($(npm --version))"

for f in server.js ai.js admin.js admin.html cache.js display-defaults.json config.json package.json deployment.md; do
    if [ ! -f "$SOURCE_DIR/roon-local-services/$f" ]; then
        fail "Missing $SOURCE_DIR/roon-local-services/$f -- is this folder complete?"
        read -p "Press Enter to close..."
        exit 1
    fi
done
if [ ! -f "$SOURCE_DIR/display_ui.html" ] || [ ! -f "$SOURCE_DIR/display_ui.js" ]; then
    fail "Missing display_ui.html or display_ui.js next to this installer."
    read -p "Press Enter to close..."
    exit 1
fi
ok "All expected source files found"

IS_UPDATE=false
if [ -f "$DEST_SERVICES/.env" ]; then
    IS_UPDATE=true
    ok "Existing installation detected at $DEST_SERVICES -- this will be an UPDATE (your .env and config.json are kept as-is)"
else
    echo "No existing installation found -- this will be a FRESH install."
fi

# ---------------------------------------------------------------------------
# 2. Copy roon-local-services/
# ---------------------------------------------------------------------------

heading "Installing roon-local-services"

mkdir -p "$DEST_SERVICES"

# Always overwritten -- these are code, not user data.
for f in server.js ai.js admin.js admin.html cache.js display-defaults.json package.json deployment.md; do
    cp "$SOURCE_DIR/roon-local-services/$f" "$DEST_SERVICES/$f"
done
ok "Copied server.js, ai.js, admin.js, admin.html, cache.js, display-defaults.json, package.json, deployment.md"

# Also stash a copy of the uninstaller here, so it's always somewhere
# findable even if the original downloaded package gets lost/deleted --
# it's self-contained (touches only what's already installed), so it works
# fine from this location too. Not a hard requirement: if it's missing
# from beside this installer for some reason, just skip it silently.
if [ -f "$SOURCE_DIR/Uninstall Roon Display.command" ]; then
    cp "$SOURCE_DIR/Uninstall Roon Display.command" "$DEST_SERVICES/Uninstall Roon Display.command"
    chmod +x "$DEST_SERVICES/Uninstall Roon Display.command"
    ok "Copied Uninstall Roon Display.command here too -- find it anytime in $DEST_SERVICES"
fi

# Never overwritten if already present -- these hold secrets/settings.
if [ -f "$DEST_SERVICES/config.json" ]; then
    warn "config.json already exists -- keeping yours, not overwriting"
else
    cp "$SOURCE_DIR/roon-local-services/config.json" "$DEST_SERVICES/config.json"
    ok "Installed default config.json"
fi

echo "Running npm install (this can take a minute)..."
( cd "$DEST_SERVICES" && npm install --no-audit --no-fund >/tmp/roon-display-npm-install.log 2>&1 )
if [ $? -eq 0 ]; then
    ok "Dependencies installed"
else
    fail "npm install failed -- see /tmp/roon-display-npm-install.log"
    read -p "Press Enter to close..."
    exit 1
fi

# ---------------------------------------------------------------------------
# 3. Network detection (used for .env defaults and the final summary)
# ---------------------------------------------------------------------------

heading "Detecting network"

ACTIVE_IFACE="$(route get default 2>/dev/null | awk '/interface:/{print $2}')"
DETECTED_IP=""
DETECTED_MAC=""
if [ -n "$ACTIVE_IFACE" ]; then
    DETECTED_IP="$(ipconfig getifaddr "$ACTIVE_IFACE" 2>/dev/null || true)"
    DETECTED_MAC="$(ifconfig "$ACTIVE_IFACE" 2>/dev/null | awk '/ether/{print $2}')"
fi

if [ -n "$DETECTED_IP" ]; then
    ok "Detected IP: $DETECTED_IP (interface $ACTIVE_IFACE)"
else
    warn "Could not auto-detect this Mac's IP -- you'll need to set it by hand in the admin panel"
    DETECTED_IP="192.168.1.100"
fi
if [ -n "$DETECTED_MAC" ]; then
    ok "Detected MAC address: $DETECTED_MAC"
fi

# ---------------------------------------------------------------------------
# 4. .env (only created if missing -- never touched on an update)
# ---------------------------------------------------------------------------

heading "Configuring .env"

if [ -f "$DEST_SERVICES/.env" ]; then
    ok "Keeping existing .env untouched"
else
    cat > "$DEST_SERVICES/.env" << EOF
DISCOGS_TOKEN=
PORT=3001
ALLOWED_ORIGIN=*
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
ADMIN_PASSWORD=admin
PROXY_HOST=$DETECTED_IP
ROON_DISPLAY_UI_PATH=$ROON_WEBROOT/display_ui.html
EOF
    ok "Created .env (API keys empty -- add them from the admin panel after install)"
fi

# ---------------------------------------------------------------------------
# 5. launchd service
# ---------------------------------------------------------------------------

heading "Installing the background service"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$DEST_SERVICES/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DEST_SERVICES</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$DEST_SERVICES/proxy.log</string>
  <key>StandardErrorPath</key>
  <string>$DEST_SERVICES/proxy-error.log</string>
</dict>
</plist>
EOF
ok "Wrote $PLIST_PATH (node: $NODE_PATH)"

# bootout first (ignore failure -- fine if it wasn't loaded yet), then
# bootstrap fresh. This is the reliable way to pick up a changed plist,
# same as the "if kickstart doesn't seem to work" fallback documented
# elsewhere -- using it unconditionally here avoids a stale process
# holding the port after an update.
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" >/dev/null 2>&1
sleep 1
if launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/tmp/roon-display-launchctl.log; then
    ok "Service loaded and started"
else
    fail "launchctl bootstrap failed -- see /tmp/roon-display-launchctl.log"
fi
sleep 2

PROXY_PORT="$(grep '^PORT=' "$DEST_SERVICES/.env" | cut -d= -f2)"
PROXY_PORT="${PROXY_PORT:-3001}"
if curl -s -o /dev/null "http://localhost:$PROXY_PORT/config"; then
    ok "Proxy responding on port $PROXY_PORT"
else
    warn "Proxy not responding yet on port $PROXY_PORT -- check $DEST_SERVICES/proxy-error.log if this persists"
fi

# ---------------------------------------------------------------------------
# 6. display_ui.html / display_ui.js -> Roon.app webroot
# ---------------------------------------------------------------------------

heading "Installing display_ui.html / display_ui.js"

if [ ! -d "$ROON_WEBROOT" ]; then
    warn "Roon.app not found at the expected path ($ROON_WEBROOT) -- skipping this step. Copy display_ui.html/.js there by hand once you locate it."
else
    TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
    for f in display_ui.html display_ui.js; do
        if [ -f "$ROON_WEBROOT/$f" ]; then
            cp "$ROON_WEBROOT/$f" "$ROON_WEBROOT/$f.backup-$TIMESTAMP"
            ok "Backed up existing $f -> $f.backup-$TIMESTAMP"
        fi
    done

    # Permission test: try writing before committing to the real copy, so a
    # macOS privacy restriction is caught with a clear next step instead of
    # a silent partial overwrite.
    TEST_FILE="$ROON_WEBROOT/.roon-display-install-test"
    if touch "$TEST_FILE" 2>/dev/null; then
        rm -f "$TEST_FILE"
        cp "$SOURCE_DIR/display_ui.html" "$ROON_WEBROOT/display_ui.html"
        cp "$SOURCE_DIR/display_ui.js" "$ROON_WEBROOT/display_ui.js"
        ok "Copied display_ui.html and display_ui.js into Roon.app"
    else
        fail "Cannot write to $ROON_WEBROOT -- macOS is blocking it (Full Disk Access needed)."
        echo ""
        echo "  1. Open System Settings -> Privacy & Security -> Full Disk Access"
        echo "  2. Click \"+\", press Cmd+Shift+G, paste this path, and add it:"
        echo "     ${BOLD}$NODE_PATH${RESET}"
        echo "  3. Also add Terminal.app the same way (this script runs inside it)."
        echo "  4. Run this installer again."
        echo ""
        echo "Opening the right System Settings pane for you now..."
        open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
    fi
fi

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------

heading "Done"

echo "Admin panel:  ${BOLD}http://$DETECTED_IP:$PROXY_PORT/config${RESET}"
if [ "$IS_UPDATE" = false ]; then
    echo "Password:     ${BOLD}admin${RESET} (you'll be asked to change it on first login)"
fi
echo ""
if [ -n "$DETECTED_MAC" ]; then
    echo "To keep this Mac's IP from ever changing, set a DHCP reservation (or"
    echo "static IP) in your router's settings for this network hardware address:"
    echo "  ${BOLD}$DETECTED_MAC${RESET} -> ${BOLD}$DETECTED_IP${RESET}"
    echo ""
fi
echo "Next steps:"
echo "  - Open the admin panel link above"
if [ "$IS_UPDATE" = false ]; then
    echo "  - Log in with 'admin', set a real password when asked"
    echo "  - Go to API Keys and add your Anthropic/OpenAI/Discogs keys"
fi
echo "  - Test on the actual TV, not just this Mac's browser"
echo ""
read -p "Press Enter to close this window..."
