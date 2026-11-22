// Protects display_ui.html and display_ui.js from being silently wiped out
// by a Roon Server update (Roon replaces both files with its own stock
// versions on update, discarding every customization in this project).
//
// It also keeps Roon's own burn-in drift OFF in cast.js (see
// checkCastPatch() below). Unlike the two files above, cast.js is Roon's
// file and is NOT backed up/restored wholesale -- Roon's updates to it
// (keep-alive fixes, etc.) must keep flowing through. Instead a tiny patch
// is appended to whatever cast.js Roon currently ships, and re-appended
// after every update that replaces it.
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

// ---- cast.js patch: disable Roon's burn-in drift ------------------------
// Roon (since ~Nov 2026) moves #uiParent by up to 12 px every minute and
// enlarges it ~2.4% (applyBurnIn in cast.js), which crops the display
// edges on the TV. This project already protects the panel itself (image
// rotation, background dimming), so the drift is switched off.
//
// The patch is appended at the END of cast.js, in the same script scope,
// and simply re-assigns applyBurnIn to a function that keeps the page
// un-transformed. Nothing in Roon's code is edited. If a future Roon
// release renames applyBurnIn the patch becomes a harmless no-op and the
// guardian logs a warning.
const CAST_PATCH_MARKER = 'ROON-DISPLAY-NO-BURNIN-DRIFT';
const CAST_MARKER_RE = /ROON-DISPLAY-NO-BURNIN-DRIFT/;
const CAST_PATCH = [
    '',
    '// ' + CAST_PATCH_MARKER + ' -- appended by roon-local-services/guardian.js.',
    '// Disables Roon\'s burn-in drift (position shift + ~2.4% zoom + dimming) that crops the TV edges.',
    '// Panel protection is handled by display_ui (image rotation / background dimming).',
    'try {',
    '    if (typeof applyBurnIn === \'function\') {',
    '        applyBurnIn = function() {',
    '            $(\'#uiParent\').css({ transform: \'none\', filter: \'none\' });',
    '        };',
    '        $(\'#uiParent\').css({ transform: \'none\', filter: \'none\' });',
    '    }',
    '} catch (e) { console.log(\'burn-in drift patch failed: \' + e); }',
    ''
].join('\n');

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

// cast.js: keep Roon's burn-in drift disabled. Marker missing -> a Roon
// update just replaced the file (or this is the first run) -> append the
// patch. Roon's own code is left untouched; the original is saved once per
// version under backups/ so the change is easy to inspect or undo.
function checkCastPatch(castPath) {
    let live;
    try {
        live = fs.readFileSync(castPath, 'utf8');
    } catch (err) {
        return; // not there right now -- try again next tick
    }
    if (CAST_MARKER_RE.test(live)) return; // already patched

    if (!/applyBurnIn/.test(live)) {
        // Roon's cast.js has no burn-in code (older version, or renamed in a
        // newer one): nothing to switch off, and appending would be pointless.
        if (!checkCastPatch.warned) {
            console.log('[guardian] cast.js has no applyBurnIn -- nothing to patch.');
            checkCastPatch.warned = true;
        }
        return;
    }

    try {
        ensureBackupDir();
        fs.writeFileSync(path.join(BACKUP_DIR, 'cast.original.js'), live);
        const tmp = castPath + '.guardian.tmp';
        fs.writeFileSync(tmp, live + (live.endsWith('\n') ? '' : '\n') + CAST_PATCH);
        fs.renameSync(tmp, castPath);
        checkCastPatch.warned = false;
        notify('cast.js had Roon\'s burn-in drift enabled -- switched it off (display edges no longer cropped).');
    } catch (err) {
        console.warn('[guardian] could not patch cast.js (non-fatal): ' + err.message);
    }
}

function tick() {
    const uiPath = getDisplayUiPath();
    if (!uiPath) return; // ROON_DISPLAY_UI_PATH not set yet -- nothing to guard
    const jsPath = path.join(path.dirname(uiPath), 'display_ui.js');
    checkFile('display_ui.html', uiPath, HTML_BACKUP_PATH, HTML_MARKER);
    checkFile('display_ui.js', jsPath, JS_BACKUP_PATH, JS_MARKER);
    checkCastPatch(path.join(path.dirname(uiPath), 'cast.js'));
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
