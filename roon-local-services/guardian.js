// Protects display_ui.html and display_ui.js from being silently wiped out
// by a Roon Server update (Roon replaces both files with its own stock
// versions on update, discarding every customization in this project).
//
// How it tells "Roon overwrote it" from "Enrico dropped in a newer file by
// hand": Roon's own stock files NEVER contain our markers (window.
// DisplayConfig in display_ui.html, DISPLAY_UI_JS_VERSION in display_ui.js)
// -- those only exist because this project put them there. So:
//   - marker MISSING  -> assume a Roon update just happened -> restore our
//     last-known-good backup onto the live file immediately.
//   - marker PRESENT but content differs from the backup -> assume this is
//     our own file (either admin.js's own write, or Enrico manually
//     installing a newer version) -> adopt it as the new protected backup.
//   - marker present and content matches the backup -> nothing to do.
//
// Runs on a plain setInterval poll (not fs.watch) -- more reliable across
// however Roon's updater actually replaces the file on disk (in place,
// rename-swap, whole-directory replace, etc.), and a music display doesn't
// need sub-second reaction time.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BACKUP_DIR = path.join(__dirname, 'backups');
const HTML_BACKUP_PATH = path.join(BACKUP_DIR, 'display_ui.html');
const JS_BACKUP_PATH = path.join(BACKUP_DIR, 'display_ui.js');
const HTML_MARKER = /window\.DisplayConfig\s*=/;
const JS_MARKER = /DISPLAY_UI_JS_VERSION\s*=/;
const DEFAULT_INTERVAL_MS = 60000;

function getDisplayUiPath() {
    const p = process.env.ROON_DISPLAY_UI_PATH;
    return p && p.trim() ? p.trim() : null;
}

function ensureBackupDir() {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Fire-and-forget macOS notification. Must never throw/crash the guardian
// loop -- e.g. if this ever runs on a non-Mac box (a test sandbox), or
// osascript itself fails for some unrelated reason, the restore itself
// (the part that actually matters) has already happened by the time this
// runs.
function notify(message) {
    console.log('[guardian] ' + message);
    try {
        execFile('osascript', ['-e', 'display notification ' + JSON.stringify(message) + ' with title "Roon Display"'], function (err) {
            if (err) console.warn('[guardian] macOS notification failed (non-fatal): ' + err.message);
        });
    } catch (err) {
        console.warn('[guardian] macOS notification failed (non-fatal): ' + err.message);
    }
}

function checkFile(label, livePath, backupPath, marker) {
    let liveContent;
    try {
        liveContent = fs.readFileSync(livePath, 'utf8');
    } catch (err) {
        return; // file missing entirely right now -- try again next tick
    }

    let backupContent = null;
    try {
        backupContent = fs.readFileSync(backupPath, 'utf8');
    } catch (err) {
        // no backup yet -- fine, nothing to restore FROM until we've
        // adopted a good copy at least once
    }

    if (!marker.test(liveContent)) {
        if (backupContent !== null) {
            fs.writeFileSync(livePath, backupContent);
            notify(label + ' was reset by a Roon update -- restored your customized version.');
        } else {
            console.warn('[guardian] ' + label + ' has no customizations and no backup exists yet -- nothing to restore.');
        }
        return;
    }

    if (backupContent !== liveContent) {
        ensureBackupDir();
        fs.writeFileSync(backupPath, liveContent);
        console.log('[guardian] ' + label + ' backup updated (customized version on disk changed).');
    }
}

function tick() {
    const uiPath = getDisplayUiPath();
    if (!uiPath) return; // ROON_DISPLAY_UI_PATH not set yet -- nothing to guard
    const jsPath = path.join(path.dirname(uiPath), 'display_ui.js');
    checkFile('display_ui.html', uiPath, HTML_BACKUP_PATH, HTML_MARKER);
    checkFile('display_ui.js', jsPath, JS_BACKUP_PATH, JS_MARKER);
}

let intervalHandle = null;

// Idempotent -- safe to call once at boot from server.js.
function start(intervalMs) {
    if (intervalHandle) return;
    tick(); // catch an update that happened while the proxy was offline
    intervalHandle = setInterval(tick, intervalMs || DEFAULT_INTERVAL_MS);
}

// Called by admin.js right after IT writes to display_ui.html (Look and
// Feel/Data Sources/Logs saves, the PROXY_HOST sync), so the backup picks
// up that change within milliseconds instead of waiting up to a minute --
// closes the narrow window where a Roon update landing in that gap would
// otherwise revert Enrico's just-saved change back to the previous backup.
function refreshBackupFromLive() {
    tick();
}

module.exports = { start: start, refreshBackupFromLive: refreshBackupFromLive };
