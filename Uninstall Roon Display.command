#!/bin/bash
# Uninstall Roon Display.command
#
# Double-click this file in Finder to fully remove Roon Display:
#   - Stops and removes the background service (launchd)
#   - Restores display_ui.html/.js in Roon.app from the most recent backup
#     the installer made (if any), so Roon goes back to how it was before
#   - Removes /Applications/roon-local-services (backed up first, see below)
#   - Removes the LaunchAgent plist
#
# Nothing here needs the source folder this script came from -- it only
# touches what's already installed on this Mac.

set -u

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

echo "${BOLD}Roon Display -- uninstaller${RESET}"
echo ""
echo "This will:"
echo "  - Stop and remove the background proxy service"
echo "  - Restore Roon's display_ui.html/.js from the most recent backup (if one exists)"
echo "  - Delete $DEST_SERVICES (a timestamped backup is made first, see below)"
echo ""
read -p "Type UNINSTALL to continue, anything else to cancel: " CONFIRM
if [ "$CONFIRM" != "UNINSTALL" ]; then
    echo "Cancelled -- nothing was changed."
    read -p "Press Enter to close..."
    exit 0
fi

# ---------------------------------------------------------------------------
# 1. Stop the service FIRST -- otherwise launchd's KeepAlive just relaunches
#    it (recreating proxy.log/proxy-error.log) the moment the folder under
#    it disappears, which is exactly the confusing half-uninstalled state
#    this script exists to avoid.
# ---------------------------------------------------------------------------

heading "Stopping the background service"

if launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null; then
    ok "Service stopped"
else
    warn "Service wasn't running (or already stopped) -- continuing anyway"
fi

if [ -f "$PLIST_PATH" ]; then
    rm "$PLIST_PATH"
    ok "Removed $PLIST_PATH"
else
    warn "No LaunchAgent file found at $PLIST_PATH"
fi

sleep 1
if lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -q "$DEST_SERVICES/server.js" ; then
    warn "Something still looks like it's listening -- check 'lsof -nP -iTCP:3001 -sTCP:LISTEN' by hand if the next steps seem to fail."
fi

# ---------------------------------------------------------------------------
# 2. Restore display_ui.html/.js from the most recent backup, if any.
#    The installer always writes a display_ui.html.backup-TIMESTAMP /
#    display_ui.js.backup-TIMESTAMP pair before overwriting -- picking the
#    most recent by filename works because the timestamp format sorts
#    correctly as plain text (YYYYMMDD-HHMMSS).
# ---------------------------------------------------------------------------

heading "Restoring Roon's display_ui.html / display_ui.js"

if [ ! -d "$ROON_WEBROOT" ]; then
    warn "Roon.app not found at the expected path -- skipping this step."
else
    for f in display_ui.html display_ui.js; do
        LATEST_BACKUP="$(ls -1 "$ROON_WEBROOT/$f".backup-* 2>/dev/null | sort | tail -n 1)"
        if [ -n "$LATEST_BACKUP" ]; then
            cp "$LATEST_BACKUP" "$ROON_WEBROOT/$f"
            ok "Restored $f from $(basename "$LATEST_BACKUP")"
        else
            warn "No backup found for $f -- leaving it as-is (it'll still reference the now-removed proxy until you replace it by hand)"
        fi
    done
fi

# ---------------------------------------------------------------------------
# 3. Back up, then remove roon-local-services/
# ---------------------------------------------------------------------------

heading "Removing roon-local-services"

if [ -d "$DEST_SERVICES" ]; then
    BACKUP_DEST="$HOME/Desktop/roon-local-services-backup-$(date +%Y%m%d-%H%M%S)"
    cp -r "$DEST_SERVICES" "$BACKUP_DEST"
    ok "Backed up to $BACKUP_DEST (contains your .env with your API keys -- delete it yourself once you're sure you don't need it)"
    rm -rf "$DEST_SERVICES"
    ok "Removed $DEST_SERVICES"
else
    warn "$DEST_SERVICES doesn't exist -- nothing to remove"
fi

# ---------------------------------------------------------------------------
# 4. Summary
# ---------------------------------------------------------------------------

heading "Done"

echo "Roon Display has been uninstalled."
echo "A backup of your old roon-local-services/ (keys included) is on your Desktop."
echo "Remember to restart Roon Server so it picks up the restored display_ui.html/.js."
echo ""
read -p "Press Enter to close this window..."
