// Local admin panel: view/edit .env secrets and config.json (AI settings),
// trigger a proxy restart. Separate module from ai.js (different concern:
// this is file I/O + a small web UI, not AI provider calls) and from
// server.js (kept a thin mount point there, same pattern as ai.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const ai = require('./ai');
const cache = require('./cache');
const guardian = require('./guardian');

const ENV_PATH = path.join(__dirname, '.env');
const CONFIG_PATH = ai.CONFIG_PATH;
const DISPLAY_DEFAULTS_PATH = path.join(__dirname, 'display-defaults.json');

// Admin's own version (covers admin.js + admin.html as one unit -- they're
// never deployed separately). x.y, bumped by hand only when told to. Shown
// read-only in the Version tab, alongside display_ui.html's and
// display_ui.js's own version markers (see getVersions() below) -- none of
// these three go through display-defaults.json/reset-to-default, since
// they're not tunable settings.
const ADMIN_VERSION = '1.2';

// Reads display_ui.html's and display_ui.js's version markers straight off
// disk (never cached), same live-read philosophy as the rest of this file.
// display_ui.js lives in the same folder as display_ui.html (see
// deployment.md) -- no separate .env setting needed just to find it.
function getVersions() {
    const result = { admin: ADMIN_VERSION, displayUi: null, displayUiJs: null };
    const displayUiPath = getDisplayUiPath();
    if (!displayUiPath) return result;
    try {
        const html = fs.readFileSync(displayUiPath, 'utf8');
        const m = /DISPLAY_UI_VERSION\s*=\s*'([^']*)'/.exec(html);
        if (m) result.displayUi = m[1];
    } catch (e) { /* file missing/unreadable -- leave null */ }
    try {
        const jsPath = path.join(path.dirname(displayUiPath), 'display_ui.js');
        const js = fs.readFileSync(jsPath, 'utf8');
        const m = /DISPLAY_UI_JS_VERSION\s*=\s*'([^']*)'/.exec(js);
        if (m) result.displayUiJs = m[1];
    } catch (e) { /* file missing/unreadable -- leave null */ }
    return result;
}

// Keys the admin panel is allowed to read/write in .env. Anything else in
// that file (comments, blank lines, keys not listed here) is left
// completely untouched by writeEnvValues() below.
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DISCOGS_TOKEN', 'PROXY_HOST', 'PORT', 'ALLOWED_ORIGIN', 'ROON_DISPLAY_UI_PATH', 'ADMIN_PASSWORD'];
const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DISCOGS_TOKEN', 'ADMIN_PASSWORD'];

// ---- Basic Auth ---------------------------------------------------------
// Single shared password (ADMIN_PASSWORD in .env), no username check --
// this is a personal local-network tool, not a multi-user system. If the
// password isn't set at all, the panel refuses to serve anything rather
// than silently running unprotected.
// "admin" is ALWAYS the effective password when ADMIN_PASSWORD is unset in
// .env -- fresh installs and post-reset both land here, by design (see
// getEffectivePassword's own callers: POST /api/login tells the client
// when the supplied password literally was "admin", which is what
// triggers the client's forced password-change screen).
function getEffectivePassword() {
    return process.env.ADMIN_PASSWORD || 'admin';
}

function basicAuth(req, res, next) {
    const password = getEffectivePassword();
    const header = req.headers.authorization || '';
    const parts = header.split(' ');
    const scheme = parts[0];
    const encoded = parts[1];
    if (scheme !== 'Basic' || !encoded) {
        res.set('WWW-Authenticate', 'Basic realm="Roon Display Admin"');
        return res.status(401).send('Authentication required');
    }
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    const suppliedPassword = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : decoded;
    if (suppliedPassword !== password) {
        res.set('WWW-Authenticate', 'Basic realm="Roon Display Admin"');
        return res.status(401).send('Invalid credentials');
    }
    next();
}

// ---- .env read/write (ENV_KEYS only) ------------------------------------
function maskSecret(value) {
    if (!value) return '';
    if (value.length <= 4) return '*'.repeat(value.length);
    return '****' + value.slice(-4);
}

// Reads fresh from disk every time -- NOT process.env, which was captured
// at process start and won't reflect a save made through this panel until
// the proxy is restarted (same "changes need a restart" rule as always).
function parseEnvFile() {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const values = {};
    raw.split('\n').forEach(function (line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#') return;
        const eq = trimmed.indexOf('=');
        if (eq < 0) return;
        values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    });
    return values;
}

// Rewrites ONLY the given keys' values, preserving every other line
// (comments, blank lines, unrelated keys) byte-for-byte. Keys not already
// present are appended at the end.
function writeEnvValues(updates) {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const lines = raw.split('\n');
    const written = {};
    const newLines = lines.map(function (line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === '#') return line;
        const eq = trimmed.indexOf('=');
        if (eq < 0) return line;
        const key = trimmed.slice(0, eq).trim();
        if (Object.prototype.hasOwnProperty.call(updates, key)) {
            written[key] = true;
            return key + '=' + updates[key];
        }
        return line;
    });
    Object.keys(updates).forEach(function (key) {
        if (!written[key]) newLines.push(key + '=' + updates[key]);
    });
    fs.writeFileSync(ENV_PATH, newLines.join('\n'));
}

// ---- Local IP detection (for the Host field's default in the form) ------
function detectLocalIp() {
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
        for (const iface of ifaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.address;
        }
    }
    return null;
}

// Same interface as detectLocalIp() above (not a second lookup) -- the MAC
// is what a router's DHCP reservation is actually keyed on, shown next to
// the IP so there's no need to go find it separately (System Settings ->
// Network -> ... -> Advanced -> Hardware, on macOS).
function detectLocalMac() {
    const ifaces = os.networkInterfaces();
    for (const name in ifaces) {
        for (const iface of ifaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) return iface.mac;
        }
    }
    return null;
}

// ---- config.json read/write (non-secret AI settings) --------------------
function readAiConfigFile() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// Very light shape validation -- enough to catch a malformed save from the
// form before it corrupts the file the proxy reads on every restart.
// PROVIDER_LABELS' keys in ai.js are the only valid provider ids; kept
// duplicated here as a plain list rather than importing ai.js internals
// (those aren't exported, deliberately -- ai.js's exports are the provider
// API, not its config-shape internals).
const VALID_PROVIDER_IDS = ['claude', 'chatgpt'];
function validateAiConfig(candidate) {
    if (!candidate || typeof candidate !== 'object') return 'not an object';
    if (!Array.isArray(candidate.providerOrder) || candidate.providerOrder.length === 0) {
        return 'providerOrder must be a non-empty array';
    }
    for (const id of candidate.providerOrder) {
        if (VALID_PROVIDER_IDS.indexOf(id) === -1) return 'unknown provider id: ' + id;
    }
    if (typeof candidate.aiLanguage !== 'string' || !candidate.aiLanguage.trim()) {
        return 'aiLanguage must be a non-empty string';
    }
    if (typeof candidate.textLengthWords !== 'number' || candidate.textLengthWords <= 0) {
        return 'textLengthWords must be a positive number';
    }
    if (!candidate.models || typeof candidate.models !== 'object') return 'models must be an object';
    for (const id of candidate.providerOrder) {
        if (typeof candidate.models[id] !== 'string' || !candidate.models[id].trim()) {
            return 'models.' + id + ' must be a non-empty string';
        }
    }
    // stylePrompts is optional -- omitted or blank entries both mean
    // "neutral" (see styleInstruction() in server.js). Only type-checked
    // when present, since a missing key is fine.
    const STYLE_KINDS = ['album', 'composition', 'artist'];
    if (candidate.stylePrompts !== undefined) {
        if (typeof candidate.stylePrompts !== 'object' || candidate.stylePrompts === null) {
            return 'stylePrompts must be an object';
        }
        for (const kind of STYLE_KINDS) {
            if (Object.prototype.hasOwnProperty.call(candidate.stylePrompts, kind) && typeof candidate.stylePrompts[kind] !== 'string') {
                return 'stylePrompts.' + kind + ' must be a string';
            }
        }
    }
    // webSearch is optional (older config.json files predate this feature)
    // -- only type-checked when present.
    if (candidate.webSearch !== undefined) {
        const ws = candidate.webSearch;
        const VALID_WEB_SEARCH_MODES = ['never', 'whenUseful', 'always'];
        if (typeof ws !== 'object' || ws === null) return 'webSearch must be an object';
        if (VALID_WEB_SEARCH_MODES.indexOf(ws.mode) === -1) {
            return 'webSearch.mode must be one of: ' + VALID_WEB_SEARCH_MODES.join(', ');
        }
        if (typeof ws.maxUses !== 'number' || ws.maxUses < 1 || ws.maxUses > 3) {
            return 'webSearch.maxUses must be a number between 1 and 3';
        }
        if (typeof ws.useDomainFilter !== 'boolean') return 'webSearch.useDomainFilter must be a boolean';
        if (!Array.isArray(ws.preferredDomains)) return 'webSearch.preferredDomains must be an array';
        for (const d of ws.preferredDomains) {
            if (typeof d !== 'string') return 'webSearch.preferredDomains must contain only strings';
        }
        if (typeof ws.fallbackIfEmpty !== 'boolean') return 'webSearch.fallbackIfEmpty must be a boolean';
    }
    // keyNormalizationRules is optional (older config.json files predate
    // this feature) -- only type-checked when present. Each rule mirrors
    // one row of the admin panel's table.
    if (candidate.keyNormalizationRules !== undefined) {
        if (!Array.isArray(candidate.keyNormalizationRules)) return 'keyNormalizationRules must be an array';
        for (const rule of candidate.keyNormalizationRules) {
            if (!rule || typeof rule !== 'object') return 'keyNormalizationRules entries must be objects';
            if (!Array.isArray(rule.symbols) || rule.symbols.some(function (s) { return typeof s !== 'string'; })) {
                return 'keyNormalizationRules entries need a symbols array of strings';
            }
            if (rule.containsAny !== undefined && (!Array.isArray(rule.containsAny) || rule.containsAny.some(function (s) { return typeof s !== 'string'; }))) {
                return "keyNormalizationRules entries' containsAny must be an array of strings";
            }
            if (typeof rule.lastOccurrenceOnly !== 'boolean') return 'keyNormalizationRules entries need a boolean lastOccurrenceOnly';
            if (typeof rule.appliesToAlbum !== 'boolean') return 'keyNormalizationRules entries need a boolean appliesToAlbum';
            if (typeof rule.appliesToTrack !== 'boolean') return 'keyNormalizationRules entries need a boolean appliesToTrack';
        }
    }
    // disambiguation is optional (older config.json files predate this
    // feature) -- mirrors admin's three checkboxes (artist/album/
    // composition), each independently controls whether that kind's
    // prompt asks the model to flag genuine ambiguity instead of
    // guessing silently. All false is equivalent to not having the field
    // at all -- today's behavior, unchanged.
    if (candidate.disambiguation !== undefined) {
        if (typeof candidate.disambiguation !== 'object' || candidate.disambiguation === null) {
            return 'disambiguation must be an object';
        }
        const disambiguationKinds = ['artist', 'album', 'composition'];
        for (let i = 0; i < disambiguationKinds.length; i++) {
            const kind = disambiguationKinds[i];
            if (candidate.disambiguation[kind] !== undefined && typeof candidate.disambiguation[kind] !== 'boolean') {
                return 'disambiguation.' + kind + ' must be a boolean';
            }
        }
    }
    return null; // valid
}

function writeAiConfig(newConfig) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 4) + '\n');
}

// ---- display_ui.html targeted read/write --------------------------------
// display_ui.html lives in the Roon Server folder, NOT here -- its path is
// ROON_DISPLAY_UI_PATH in .env (empty until you set it). window.DisplayConfig
// there is a plain JS object literal, not JSON, so it can't be
// JSON.parse()'d/rewritten wholesale -- instead each field below is found
// and replaced by locating its containing block (by that block's own key
// name, e.g. "colors" or "albumArt") and doing a scoped regex replace only
// within that block's brace-matched span. This assumes each block key name
// in DISPLAY_CONFIG_FIELDS appears exactly once in the whole file --
// findBlock() below throws loudly if that assumption is ever violated,
// rather than silently editing the wrong occurrence.

function getDisplayUiPath() {
    const p = process.env.ROON_DISPLAY_UI_PATH;
    return p && p.trim() ? p.trim() : null;
}

// Finds `blockKey: {` and returns the span of its brace-matched contents
// (contentStart = index of the opening '{', end = index just after the
// matching closing '}'). Used as the search scope for a property replace/
// read, so identically-named properties in OTHER blocks (e.g. "contrast"
// appears in albumArt, artistArt, AND backgroundAlbumArt) never collide.
function findBlock(html, blockKey) {
    const keyRe = new RegExp('\\b' + blockKey + '\\s*:\\s*\\{');
    const m = keyRe.exec(html);
    if (!m) return null;
    const contentStart = html.indexOf('{', m.index);
    let depth = 0;
    for (let i = contentStart; i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
            depth--;
            if (depth === 0) return { contentStart: contentStart, end: i + 1 };
        }
    }
    return null; // unmatched braces -- shouldn't happen in a well-formed file
}

// One combined table drives both GET (read current values) and POST
// (write new ones) for both the Look and Feel and Data Sources tabs --
// keeps the two directions from drifting out of sync with each other.
// `key` is the flat name used in the admin API's JSON; `block`/`prop`
// locate it inside display_ui.html.
// Look and Feel field definitions (key, block, prop, type, default) live
// in display-defaults.json now -- the single reference both these three
// tables AND the admin panel's "Restore defaults"/per-field reset buttons
// read from, instead of each keeping their own separate copy that could
// drift out of sync. Covers all three categories (lookAndFeel/
// dataSources/logs, tagged via each entry's own `category`), not just
// Look and Feel anymore. `default` isn't used by extractField/
// writeDisplayUiFields below (they only look at block/prop/type) -- it's
// read out separately, see the GET /api/config route, to hand to the
// client for those reset buttons. Loaded once at startup, not per-
// request -- if this file is ever hand-edited while the proxy is
// running, restart it to pick up the change (same expectation as editing
// config.json/.env directly).
const DISPLAY_DEFAULT_FIELDS = JSON.parse(fs.readFileSync(DISPLAY_DEFAULTS_PATH, 'utf8'));

function fieldsByCategory(category) {
    return DISPLAY_DEFAULT_FIELDS.filter(function (f) { return f.category === category; });
}

// sourceOrder is deliberately excluded here too (not tagged with any
// category in display-defaults.json, see DISPLAY_CONFIG_FIELDS.dataSources'
// own comment) -- buildDefaultsMap('dataSources') naturally omits it.
function buildDefaultsMap(category) {
    return fieldsByCategory(category).reduce(function (acc, field) {
        acc[field.key] = field.default;
        return acc;
    }, {});
}

const DISPLAY_CONFIG_FIELDS = {
    lookAndFeel: fieldsByCategory('lookAndFeel'),
    dataSources: [
        // sourceOrder deliberately NOT in display-defaults.json -- it's a
        // reorderable list widget in the admin panel (#sourceOrderList),
        // not a plain input, so it doesn't fit the generic per-field
        // reset/save-as-default mechanism the other fields use. Still
        // read/written normally here, just outside the defaults system.
        { key: 'sourceOrder', block: 'albumInfo', prop: 'sourceOrder', type: 'array' }
    ].concat(fieldsByCategory('dataSources')),
    logs: fieldsByCategory('logs')
};

function escapeForSingleQuotedString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function extractField(html, field) {
    const block = findBlock(html, field.block);
    if (!block) return undefined;
    const sub = html.slice(block.contentStart, block.end);
    let re, m;
    switch (field.type) {
        case 'string':
            re = new RegExp('\\b' + field.prop + '\\s*:\\s*\'([^\']*)\'');
            m = re.exec(sub);
            return m ? m[1] : undefined;
        case 'number':
            // Also matches a literal `null` (used by centralInfoPanel.heightVh
            // for "auto-calculate" -- see applyFieldUpdate's own comment).
            re = new RegExp('\\b' + field.prop + '\\s*:\\s*(null|-?[\\d.]+)');
            m = re.exec(sub);
            if (!m) return undefined;
            return m[1] === 'null' ? null : parseFloat(m[1]);
        case 'bool':
            re = new RegExp('\\b' + field.prop + '\\s*:\\s*(true|false)');
            m = re.exec(sub);
            return m ? m[1] === 'true' : undefined;
        case 'array':
            re = new RegExp('\\b' + field.prop + '\\s*:\\s*\\[([^\\]]*)\\]');
            m = re.exec(sub);
            if (!m) return undefined;
            return m[1].split(',')
                .map(function (s) { return s.trim().replace(/^'|'$/g, ''); })
                .filter(function (s) { return s.length > 0; });
        default:
            return undefined;
    }
}

// Replaces field.prop's value within field.block's brace-matched span.
// Re-locates the block fresh on the CURRENT html each call (rather than
// reusing an index computed before an earlier replace in the same batch),
// so a batch of replacements never operates on stale offsets after an
// earlier one changed the string's length.
function applyFieldUpdate(html, field, newValue) {
    const block = findBlock(html, field.block);
    if (!block) throw new Error('block not found in display_ui.html: ' + field.block);
    const sub = html.slice(block.contentStart, block.end);
    let re, replacement;
    switch (field.type) {
        case 'string':
            re = new RegExp('(\\b' + field.prop + '\\s*:\\s*)\'[^\']*\'');
            replacement = "$1'" + escapeForSingleQuotedString(newValue) + "'";
            break;
        case 'number':
            // Matches an existing `null` too (see extractField) so this
            // stays reversible: write a number over it, or write `null`
            // back over a number to return to auto-calculate (only
            // meaningful for centralInfoPanel.heightVh today, but generic
            // here since no other 'number' field ever legitimately
            // receives null from the form -- their inputs always produce
            // a real number).
            re = new RegExp('(\\b' + field.prop + '\\s*:\\s*)(?:null|-?[\\d.]+)');
            replacement = '$1' + (newValue === null || newValue === undefined ? 'null' : Number(newValue));
            break;
        case 'bool':
            re = new RegExp('(\\b' + field.prop + '\\s*:\\s*)(?:true|false)');
            replacement = '$1' + (newValue ? 'true' : 'false');
            break;
        case 'array':
            re = new RegExp('(\\b' + field.prop + '\\s*:\\s*)\\[[^\\]]*\\]');
            replacement = '$1[' + newValue.map(function (s) { return "'" + escapeForSingleQuotedString(s) + "'"; }).join(', ') + ']';
            break;
        default:
            throw new Error('unknown field type: ' + field.type);
    }
    if (!re.test(sub)) throw new Error('property not found in display_ui.html: ' + field.block + '.' + field.prop);
    const newSub = sub.replace(re, replacement);
    return html.slice(0, block.contentStart) + newSub + html.slice(block.end);
}

// Reads every field in `fields` from display_ui.html at ROON_DISPLAY_UI_PATH.
// Returns null (not an object) if that path isn't set/readable, so the
// caller can distinguish "not configured yet" from "configured but empty".
function readDisplayUiFields(fields) {
    const uiPath = getDisplayUiPath();
    if (!uiPath) return null;
    let html;
    try {
        html = fs.readFileSync(uiPath, 'utf8');
    } catch (err) {
        return null;
    }
    const out = {};
    fields.forEach(function (field) {
        out[field.key] = extractField(html, field);
    });
    return out;
}

// Writes `updates` (a flat { key: value } object matching a subset of
// `fields`) into display_ui.html at ROON_DISPLAY_UI_PATH, one field at a
// time via applyFieldUpdate(). Throws (caller turns it into a 4xx/5xx) if
// the path isn't set, unreadable, or any field can't be found/written --
// deliberately fails the WHOLE batch rather than writing some fields and
// silently skipping others, so a save is never partially applied.
function writeDisplayUiFields(fields, updates) {
    const uiPath = getDisplayUiPath();
    if (!uiPath) throw new Error('ROON_DISPLAY_UI_PATH is not set in .env');
    let html = fs.readFileSync(uiPath, 'utf8');
    fields.forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(updates, field.key)) {
            html = applyFieldUpdate(html, field, updates[field.key]);
        }
    });
    fs.writeFileSync(uiPath, html);
    // Refresh guardian's protected backup immediately (see guardian.js) --
    // otherwise it'd wait up to a minute for its next poll to notice this
    // legitimate change, a window in which a Roon update landing first
    // would cause a revert to the previous (now stale) backup.
    guardian.refreshBackupFromLive();
}

// ---- Route registration ---------------------------------------------------
// Called from server.js as: require('./admin').registerAdminRoutes(app);
// Mirrors how ai.js's routes are wired directly into server.js rather than
// this module owning its own Express app -- one process, one port, same as
// the Discogs/AI routes.
function registerAdminRoutes(app) {
    // Deliberately NOT behind basicAuth: this route only serves the static
    // HTML shell (empty form fields, no data) -- every real value comes
    // from /api/config, which IS protected. Two separate native browser
    // Basic Auth prompts for one page load was confusing and one of them
    // (the page-level one) was protecting nothing of substance anyway.
    app.get('/config', function (req, res) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    });

    // No basicAuth here on purpose -- this route's entire job IS credential
    // checking, so it can't require credentials to be called. It doesn't
    // create a session; the client still attaches Basic Auth on every
    // subsequent request as before. This just tells the login screen
    // whether the password that was just typed was the "admin" sentinel,
    // which is what triggers the forced password-change screen.
    app.post('/api/login', function (req, res) {
        const supplied = (req.body || {}).password || '';
        const effective = getEffectivePassword();
        if (supplied !== effective) {
            return res.status(401).json({ ok: false });
        }
        res.json({ ok: true, mustChangePassword: supplied === 'admin' });
    });

    // ---- Connection tests ---------------------------------------------------
    // Each tests whatever key is CURRENTLY SAVED in .env -- not a value
    // from the request body, since the admin panel's key fields are
    // always shown blank (see maskSecret) and there's nothing meaningful
    // to test from an empty field. All three use a lightweight, free
    // endpoint (list models / identity) rather than a real generation
    // call, so testing a key never costs money or counts against usage.
    async function testAnthropicKey(key) {
        const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        });
        if (res.ok) return { ok: true, message: 'Key is valid.' };
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'Key was rejected (invalid or revoked).' };
        return { ok: false, error: 'Unexpected response: HTTP ' + res.status };
    }
    async function testOpenAIKey(key) {
        const res = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': 'Bearer ' + key }
        });
        if (res.ok) return { ok: true, message: 'Key is valid.' };
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'Key was rejected (invalid or revoked).' };
        return { ok: false, error: 'Unexpected response: HTTP ' + res.status };
    }
    async function testDiscogsToken(token) {
        const res = await fetch('https://api.discogs.com/oauth/identity', {
            headers: { 'Authorization': 'Discogs token=' + token, 'User-Agent': 'RoonDisplay/1.0' }
        });
        if (res.ok) {
            const data = await res.json();
            return { ok: true, message: 'Token is valid (user: ' + (data.username || 'unknown') + ').' };
        }
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'Token was rejected (invalid or revoked).' };
        return { ok: false, error: 'Unexpected response: HTTP ' + res.status };
    }
    const CONNECTION_TESTS = {
        anthropic: { envKey: 'ANTHROPIC_API_KEY', run: testAnthropicKey },
        openai: { envKey: 'OPENAI_API_KEY', run: testOpenAIKey },
        discogs: { envKey: 'DISCOGS_TOKEN', run: testDiscogsToken }
    };
    app.post('/api/config/test/:provider', basicAuth, async function (req, res) {
        const test = CONNECTION_TESTS[req.params.provider];
        if (!test) return res.status(404).json({ error: 'unknown provider: ' + req.params.provider });
        const envValues = parseEnvFile();
        const key = envValues[test.envKey];
        if (!key) return res.status(400).json({ error: 'no key set' });
        try {
            const result = await test.run(key);
            res.json(result);
        } catch (err) {
            res.json({ ok: false, error: 'Request failed: ' + err.message });
        }
    });

    // No basicAuth here EITHER, and deliberately so -- this is the "forgot
    // password" escape hatch, reachable from the login screen without
    // knowing the current password. It clears the three API keys and
    // resets ADMIN_PASSWORD to the "admin" sentinel, then restarts itself.
    // Everything else in .env (.env host/port/path) and config.json is
    // left untouched. See the client's confirm-dialog before calling this
    // -- there is no server-side confirmation step, this endpoint does
    // exactly what it's told the moment it's called.
    app.post('/api/config/reset-access', function (req, res) {
        try {
            writeEnvValues({
                ANTHROPIC_API_KEY: '',
                OPENAI_API_KEY: '',
                DISCOGS_TOKEN: '',
                ADMIN_PASSWORD: 'admin'
            });
        } catch (err) {
            return res.status(500).json({ error: 'could not write .env: ' + err.message });
        }
        res.json({ ok: true });
        setTimeout(function () { process.exit(0); }, 300);
    });

    app.get('/api/config', basicAuth, function (req, res) {
        const envValues = parseEnvFile();
        const envOut = {};
        ENV_KEYS.forEach(function (key) {
            const val = envValues[key] || '';
            envOut[key] = SECRET_KEYS.indexOf(key) !== -1 ? maskSecret(val) : val;
        });
        let aiConfig;
        try {
            aiConfig = readAiConfigFile();
        } catch (err) {
            return res.status(500).json({ error: 'could not read config.json: ' + err.message });
        }
        const displayUiPath = getDisplayUiPath();
        res.json({
            env: envOut,
            aiConfig: aiConfig,
            detectedIp: detectLocalIp(),
            detectedMac: detectLocalMac(),
            aiCacheCount: cache.count(),
            displayUiConfigured: !!displayUiPath,
            lookAndFeel: readDisplayUiFields(DISPLAY_CONFIG_FIELDS.lookAndFeel),
            dataSources: readDisplayUiFields(DISPLAY_CONFIG_FIELDS.dataSources),
            logs: readDisplayUiFields(DISPLAY_CONFIG_FIELDS.logs),
            // Flat {key: default} maps for each tab's "Restore defaults"
            // and per-field reset buttons -- built from the same
            // DISPLAY_DEFAULT_FIELDS (filtered by category) this route's
            // own lookAndFeel/dataSources/logs reads above use, so none of
            // the three can ever disagree on which fields exist.
            lookAndFeelDefaults: buildDefaultsMap('lookAndFeel'),
            dataSourcesDefaults: buildDefaultsMap('dataSources'),
            logsDefaults: buildDefaultsMap('logs'),
            versions: getVersions()
        });
    });

    // Rebuilds http://PROXY_HOST:PORT from .env (freshly re-read, so this
    // reflects whatever writeEnvValues() just wrote, not stale process.env)
    // and pushes it into BOTH places display_ui.html keeps a copy of it --
    // aiInfo.proxyBaseUrl and albumInfo.discogsProxyUrl. Silently does
    // nothing if ROON_DISPLAY_UI_PATH isn't set -- this is a convenience
    // sync, not a required step, and the caller already knows from
    // displayUiConfigured whether to expect it to have run.
    function syncProxyUrlToDisplayUi() {
        if (!getDisplayUiPath()) return false;
        const envValues = parseEnvFile();
        const host = envValues.PROXY_HOST;
        const port = envValues.PORT;
        if (!host || !port) return false;
        const url = 'http://' + host + ':' + port;
        writeDisplayUiFields(
            [
                { key: 'proxyBaseUrl', block: 'aiInfo', prop: 'proxyBaseUrl', type: 'string' },
                { key: 'discogsProxyUrl', block: 'albumInfo', prop: 'discogsProxyUrl', type: 'string' }
            ],
            { proxyBaseUrl: url, discogsProxyUrl: url }
        );
        return true;
    }

    // Body: { ANTHROPIC_API_KEY?, OPENAI_API_KEY?, DISCOGS_TOKEN?,
    // PROXY_HOST?, PORT?, ALLOWED_ORIGIN? } -- only keys actually present
    // in the body are written; the client is expected to omit a secret
    // field entirely when the user left its masked placeholder untouched
    // (never send the mask back as if it were a real value).
    // Body: { ANTHROPIC_API_KEY?, OPENAI_API_KEY?, DISCOGS_TOKEN?,
    // PROXY_HOST?, PORT?, ALLOWED_ORIGIN?, ROON_DISPLAY_UI_PATH?,
    // ADMIN_PASSWORD?, clear?: string[] } -- a key is written only if its
    // value is non-empty, UNLESS it's also named in `clear`, in which case
    // it's written as an empty string regardless (this is the explicit
    // "Clear" button path -- a blank field alone still means "leave
    // unchanged", same as always).
    app.post('/api/config/env', basicAuth, function (req, res) {
        const body = req.body || {};
        const updates = {};
        ENV_KEYS.forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== '') {
                updates[key] = String(body[key]);
            }
        });
        (body.clear || []).forEach(function (key) {
            if (ENV_KEYS.indexOf(key) !== -1) updates[key] = '';
        });
        if (Object.prototype.hasOwnProperty.call(updates, 'ADMIN_PASSWORD') && updates.ADMIN_PASSWORD === 'admin') {
            return res.status(400).json({ error: '"admin" cannot be used as the password -- it\'s the reset sentinel value.' });
        }
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'no recognized fields in body' });
        }
        try {
            writeEnvValues(updates);
        } catch (err) {
            return res.status(500).json({ error: 'could not write .env: ' + err.message });
        }
        let displayUiSynced = false;
        if (Object.prototype.hasOwnProperty.call(updates, 'PROXY_HOST') || Object.prototype.hasOwnProperty.call(updates, 'PORT')) {
            try {
                displayUiSynced = syncProxyUrlToDisplayUi();
            } catch (err) {
                // .env write already succeeded -- report the sync failure
                // separately rather than making the whole request look failed.
                return res.json({ written: Object.keys(updates), restartRequired: true, displayUiSynced: false, displayUiSyncError: err.message });
            }
        }
        res.json({ written: Object.keys(updates), restartRequired: true, displayUiSynced: displayUiSynced });
    });

    app.post('/api/config/aiconfig', basicAuth, function (req, res) {
        const candidate = req.body;
        const validationError = validateAiConfig(candidate);
        if (validationError) {
            return res.status(400).json({ error: 'invalid config: ' + validationError });
        }
        try {
            writeAiConfig(candidate);
        } catch (err) {
            return res.status(500).json({ error: 'could not write config.json: ' + err.message });
        }
        res.json({ written: true, restartRequired: true });
    });

    // Body: a flat object with any subset of DISPLAY_CONFIG_FIELDS.lookAndFeel's
    // keys (accentColor, queuePanelOpacity, albumArtBrightness, etc.) --
    // see that table above for the full list and their types.
    // EPERM/EACCES here almost always means macOS's own privacy protections
    // (Full Disk Access, or "App Management" on Sonoma+) are blocking this
    // Node process from writing into another app's bundle (Roon.app) --
    // not a bug, and not something this process can grant itself (by
    // design: a process can't self-approve a TCC permission, or the
    // protection would be meaningless). The best this endpoint can do is
    // hand back exactly where to go fix it.
    function sendDisplayUiWriteError(res, err) {
        const isPermissionIssue = err.code === 'EPERM' || err.code === 'EACCES';
        if (!isPermissionIssue) {
            return res.status(500).json({ error: 'could not write display_ui.html: ' + err.message });
        }
        res.status(500).json({
            error: 'could not write display_ui.html: ' + err.message,
            permissionIssue: true,
            // process.execPath is the ACTUAL binary this running process was
            // launched from -- not whatever `which node` resolves to in an
            // interactive shell, which can be a different install entirely.
            nodePath: process.execPath,
            instructions: [
                'Open System Settings -> Privacy & Security -> Full Disk Access.',
                'Click the "+" button.',
                'Press Cmd+Shift+G and paste this Node executable\'s path: ' + process.execPath,
                'Select that file and click Add/Open, then make sure its toggle is switched on.',
                'Restart the proxy (button in the "Proxy Process" section below, or `launchctl kickstart -k gui/$(id -u)/local.roondisplay.proxy`).'
            ]
        });
    }

    app.post('/api/config/lookfeel', basicAuth, function (req, res) {
        if (!getDisplayUiPath()) {
            return res.status(400).json({ error: 'ROON_DISPLAY_UI_PATH is not set in .env -- set it first' });
        }
        try {
            writeDisplayUiFields(DISPLAY_CONFIG_FIELDS.lookAndFeel, req.body || {});
        } catch (err) {
            return sendDisplayUiWriteError(res, err);
        }
        res.json({ written: true, restartRequired: 'roon-server' });
    });

    function writeDisplayDefaultsFile() {
        fs.writeFileSync(DISPLAY_DEFAULTS_PATH, JSON.stringify(DISPLAY_DEFAULT_FIELDS, null, 4) + '\n');
    }

    // Body: { key }. Deliberately does NOT accept a value from the client
    // -- reads the CURRENTLY ACTIVE value straight out of display_ui.html
    // itself (same extractField() the GET /api/config route already uses
    // to populate the form), so what becomes the new default is always
    // genuinely the live setting, never a stale or mistaken value the
    // browser happened to be holding. Works across all three categories
    // (key is unique across the whole file) -- the caller doesn't need to
    // say which tab it's on. Updates DISPLAY_DEFAULT_FIELDS in memory too
    // (not just the file on disk) -- the very next GET /api/config's
    // *Defaults maps reflect it immediately, no restart needed.
    app.post('/api/config/save-default', basicAuth, function (req, res) {
        const key = (req.body || {}).key;
        const fieldDef = DISPLAY_DEFAULT_FIELDS.find(function (f) { return f.key === key; });
        if (!fieldDef) return res.status(400).json({ error: 'unknown field: ' + key });
        const displayUiPath = getDisplayUiPath();
        if (!displayUiPath) return res.status(400).json({ error: 'ROON_DISPLAY_UI_PATH is not set in .env -- set it first' });
        let html;
        try {
            html = fs.readFileSync(displayUiPath, 'utf8');
        } catch (err) {
            return res.status(500).json({ error: 'could not read display_ui.html: ' + err.message });
        }
        fieldDef.default = extractField(html, fieldDef);
        try {
            writeDisplayDefaultsFile();
        } catch (err) {
            return res.status(500).json({ error: 'could not write display-defaults.json: ' + err.message });
        }
        res.json({ ok: true, key: key, newDefault: fieldDef.default });
    });

    // Body: { category: 'lookAndFeel'|'dataSources'|'logs' }. Same idea as
    // save-default above, for every field IN THAT ONE CATEGORY at once --
    // scoped by category (not every field in the whole file) so Data
    // Sources' own "Save all as defaults" button can't reach into Look
    // and Feel's fields or vice versa, matching how each tab's own Save
    // button already only ever touches its own fields.
    app.post('/api/config/save-all-defaults', basicAuth, function (req, res) {
        const category = (req.body || {}).category;
        const fields = fieldsByCategory(category);
        if (fields.length === 0) return res.status(400).json({ error: 'unknown or empty category: ' + category });
        const displayUiPath = getDisplayUiPath();
        if (!displayUiPath) return res.status(400).json({ error: 'ROON_DISPLAY_UI_PATH is not set in .env -- set it first' });
        let html;
        try {
            html = fs.readFileSync(displayUiPath, 'utf8');
        } catch (err) {
            return res.status(500).json({ error: 'could not read display_ui.html: ' + err.message });
        }
        fields.forEach(function (fieldDef) {
            fieldDef.default = extractField(html, fieldDef);
        });
        try {
            writeDisplayDefaultsFile();
        } catch (err) {
            return res.status(500).json({ error: 'could not write display-defaults.json: ' + err.message });
        }
        res.json({ ok: true, count: fields.length });
    });

    // Body: a flat object with any subset of DISPLAY_CONFIG_FIELDS.dataSources's
    // keys (sourceOrder, debug, minArtistSimilarity, minTitleSimilarity).
    app.post('/api/config/datasources', basicAuth, function (req, res) {
        if (!getDisplayUiPath()) {
            return res.status(400).json({ error: 'ROON_DISPLAY_UI_PATH is not set in .env -- set it first' });
        }
        const body = req.body || {};
        if (Object.prototype.hasOwnProperty.call(body, 'sourceOrder')) {
            const validSources = ['discogs', 'itunes', 'deezer'];
            const bad = (body.sourceOrder || []).filter(function (s) { return validSources.indexOf(s) === -1; });
            if (bad.length) {
                return res.status(400).json({ error: 'unknown source(s) in sourceOrder: ' + bad.join(', ') });
            }
        }
        try {
            writeDisplayUiFields(DISPLAY_CONFIG_FIELDS.dataSources, body);
        } catch (err) {
            return sendDisplayUiWriteError(res, err);
        }
        res.json({ written: true, restartRequired: 'roon-server' });
    });

    // Body: { logsToTerminal?, logsToScreen? } -- see DISPLAY_CONFIG_FIELDS.logs.
    app.post('/api/config/logs', basicAuth, function (req, res) {
        if (!getDisplayUiPath()) {
            return res.status(400).json({ error: 'ROON_DISPLAY_UI_PATH is not set in .env -- set it first' });
        }
        try {
            writeDisplayUiFields(DISPLAY_CONFIG_FIELDS.logs, req.body || {});
        } catch (err) {
            return sendDisplayUiWriteError(res, err);
        }
        res.json({ written: true, restartRequired: 'roon-server' });
    });

    // Responds first, then exits after a short delay so the response
    // actually reaches the browser -- launchd's KeepAlive:true in the
    // .plist restarts the process automatically, same effect as running
    // `launchctl kickstart` by hand.
    app.post('/api/config/restart-proxy', basicAuth, function (req, res) {
        res.json({ restarting: true });
        setTimeout(function () { process.exit(0); }, 300);
    });

    // ---- AI cache (ai-cache.json, see cache.js) --------------------------
    // Clearing/exporting/importing here never touches .env or config.json
    // -- this is generated data (past AI responses), not settings, and
    // doesn't need a proxy restart to take effect either (ai.js reads the
    // cache file fresh on every request already).
    // Body: { kind?: 'all'|'review'|'composition'|'artist', dateFilter?: {
    // mode: 'any'|'on'|'before'|'range', date, startDate, endDate } }. Both
    // default to "everything" if omitted, so this stays a drop-in
    // replacement for the old unconditional clear-everything behavior.
    app.post('/api/config/clear-ai-cache', basicAuth, function (req, res) {
        const body = req.body || {};
        const result = cache.clearFiltered(body.kind || 'all', body.dateFilter || { mode: 'any' });
        res.json({ ok: true, count: result.remainingCount, deleted: result.deletedCount });
    });

    app.get('/api/config/export-ai-cache', basicAuth, function (req, res) {
        res.json({ exportedAt: new Date().toISOString(), entries: cache.getAll() });
    });

    // Body: { entries: { <key>: <cached value>, ... } } -- same shape
    // export-ai-cache produces. Merges by key (see cache.js's merge()):
    // entries already cached under a key NOT present in the imported file
    // are left untouched, not wiped.
    app.post('/api/config/import-ai-cache', basicAuth, function (req, res) {
        const entries = (req.body || {}).entries;
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
            return res.status(400).json({ error: 'body must be { entries: {...} }, as produced by export-ai-cache' });
        }
        const merged = cache.merge(entries);
        res.json({ ok: true, merged: merged, total: cache.count() });
    });
}

module.exports = { registerAdminRoutes: registerAdminRoutes };
