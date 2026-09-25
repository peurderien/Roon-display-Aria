# Display Deployment — Quick Reference

> This file (`deployment.md`) lives inside `roon-local-services/`, right next to `server.js`. This folder is installed in `/Applications/roon-local-services/`, deliberately **outside** the directory Roon Server manages — so it's never touched, overwritten, or wiped by a Roon update. Commands below assume you're running them from inside this folder unless stated otherwise.

## Quick Start: the Installer

For a fresh install or an update, the easiest path is double-clicking **`Install Roon Display.command`** — no terminal typing required.

**First time you run either `.command` file:** macOS will likely say "cannot be opened because it is from an unidentified developer" — right-click (not double-click) the file → **Open** once to clear that; every run after works with a normal double-click. If Finder instead complains about permissions, the executable bit was lost in transit (common after a download/zip) — fix once from Terminal:
```bash
chmod +x "Install Roon Display.command" "Uninstall Roon Display.command"
```

### Installation Package Contents

What's inside the downloaded/prepared folder, before anything is installed:

```
roon-display-installer/                    <- any folder name, can live anywhere (Desktop, Downloads, ...)
├── Install Roon Display.command           <- double-click to install/update
├── Uninstall Roon Display.command         <- double-click to remove everything
├── roon-local-services/
│   ├── server.js                          <- local proxy: Discogs + AI routes, mounts the admin panel
│   ├── ai.js                              <- AI provider calls (Claude, ChatGPT), web search, caching logic
│   ├── cache.js                           <- ai-cache.json read/write/merge helpers, used by ai.js and the admin panel
│   ├── display-defaults.json              <- single reference for every Look and Feel field's key/block/prop/type/default -- read by admin.js (its own field table) and served to the admin panel (Restore defaults / per-field reset buttons)
│   ├── admin.js                           <- admin panel routes (auth, config read/write, cache management)
│   ├── admin.html                         <- the admin panel page itself
│   ├── guardian.js                        <- auto-restores display_ui.html/.js after a Roon update wipes them
│   ├── config.json                        <- default AI settings (language, length, models, web search, style prompts)
│   ├── package.json                       <- dependencies (express, cors, dotenv, node-fetch)
│   └── deployment.md                      <- this file
├── display_ui.html
└── display_ui.js
```

`Install Roon Display.command` needs everything in this layout present alongside it (it checks up front and stops with a clear error if something's missing or misplaced). `Uninstall Roon Display.command` is the one exception — it only touches what's already installed on the Mac, so it works standalone even if moved elsewhere by itself.

If you downloaded these files individually, you'll need to arrange them into this structure by hand first — a flat folder of loose files won't work.

Notably **absent** from this list on purpose: `.env` and `ai-cache.json`. Neither is a source file shipped in the package — both are generated at their destination the first time they're needed (`.env` by the installer on a fresh install, `ai-cache.json` by the proxy the first time anything gets cached) and are never touched by re-running the installer if they already exist. See "Post-Deployment Structure" below for where they end up.

### What "Install" Does

1. Checks Node/npm are installed
2. Detects whether this is a **fresh install** or an **update** by checking for an existing `.env` at `/Applications/roon-local-services/` — this single check drives every "always/only if missing" distinction below
3. Copies `server.js`, `ai.js`, `cache.js`, `display-defaults.json`, `admin.js`, `admin.html`, `package.json`, `deployment.md` to `/Applications/roon-local-services/` — **always** overwritten on both a fresh install and an update, since these are code/docs, never your data
4. `config.json`: created with defaults **only if missing**; left completely untouched on an update
5. `.env`: created **only if missing**, with empty API keys, `ADMIN_PASSWORD=admin`, and this Mac's detected IP already filled in as `PROXY_HOST`; left completely untouched on an update — your keys and settings survive every re-run
6. Runs `npm install`
7. Detects this Mac's IP and MAC address, writes/updates the `launchd` service (`local_roondisplay_proxy.plist`) with the correct Node path, loads it
8. Backs up any existing `display_ui.html`/`.js` in Roon's webroot (timestamped, e.g. `display_ui.html.backup-20260115-143000`), then copies the new ones in — this step runs **unconditionally**, fresh install or update, since these two files always need to be current
9. Tests that it can actually write to Roon's webroot — if macOS's Full Disk Access blocks it, prints the exact Node path to add and opens the right System Settings pane for you
10. Prints a summary: the admin panel URL, the DHCP reservation suggestion (IP + MAC), and (on a fresh install only) a reminder that the password is `admin` and needs changing on first login

Safe to re-run any time you want to push updated code — it's designed to be idempotent, not just a one-shot setup script.

**`ai-cache.json` is never mentioned anywhere in this process** — the installer doesn't create it, doesn't touch it, doesn't back it up. It simply doesn't exist until the proxy caches its first AI response, at which point `cache.js` creates it on the fly. On an update, whatever's already there (if anything) is left completely alone, same spirit as `.env`/`config.json`.

### Installing Over an Existing Installation

This is the **update** path from step 2 above, not a separate mode — worth spelling out since it surprises people expecting a "fresh install" every time:

- If `/Applications/roon-local-services/.env` exists, the installer treats the whole run as an update, **regardless of how old or customized that installation is**
- Your `.env` (API keys, admin password, network settings) and `config.json` (AI language/length/models/web search/style prompts/key normalization rules/disambiguation) are **never overwritten** — whatever you had stays exactly as it was
- `ai-cache.json`, if present, is equally untouched — your cached AI responses survive every update
- Every code file (`server.js`, `ai.js`, `cache.js`, `display-defaults.json`, `admin.js`, `admin.html`) and `display_ui.html`/`.js` on Roon's side **are** replaced with the new versions, unconditionally
- There is **no partial-update mode** and no prompt asking which parts to update — it's always "keep all data, replace all code," every time

If you actually want a genuine fresh install over an existing one (e.g. to reset settings back to defaults), you have to remove the old installation yourself first — the installer will never do this for you automatically:
```bash
launchctl bootout gui/$(id -u)/local.roondisplay.proxy   # stop it first, or it just relaunches itself (see Uninstalling below for why)
cp -r /Applications/roon-local-services /Applications/roon-local-services.backup   # optional safety net
rm -rf /Applications/roon-local-services
```
Only then will the next run of `Install Roon Display.command` see no `.env`, take the fresh-install path, and generate new defaults for everything. (`Uninstall Roon Display.command` does effectively this same thing for you, safely and with an automatic backup — see below — so that's usually the easier route to the same result.)

### Post-Deployment Structure

What's actually on disk after a successful install, on both sides of the two locations this project touches:

```
/Applications/roon-local-services/
├── server.js, ai.js, cache.js, display-defaults.json, admin.js, admin.html   <- from the package, always current
├── guardian.js                                         <- from the package, always current
├── package.json, deployment.md                        <- from the package, always current
├── node_modules/                                       <- created by npm install
├── config.json                                         <- from the package on first install, then yours forever
├── .env                                                <- generated on first install, then yours forever
├── ai-cache.json                                       <- does NOT exist until the first AI response is cached
├── backups/display_ui.html, backups/display_ui.js     <- created by guardian.js the first time it runs, see "When Roon Updates"
├── proxy.log, proxy-error.log                          <- created by launchd the first time the service runs
└── Uninstall Roon Display.command                      <- a copy the installer stashes here too, see below

~/Library/LaunchAgents/
└── local_roondisplay_proxy.plist                       <- generated fresh by the installer every run, correct Node path baked in

/Applications/Roon.app/Contents/Resources/webroot/
├── display_ui.html, display_ui.js                      <- always current, inside Roon's own bundle (see "When Roon Updates")
└── display_ui.html.backup-TIMESTAMP, display_ui.js.backup-TIMESTAMP   <- one pair per install/update run that found something already there
```

The installer also copies `Uninstall Roon Display.command` into `/Applications/roon-local-services/` itself (if it was present alongside the installer when run) — so it's always findable at a known location later, even if the original downloaded package folder is long gone. It's self-contained and works fine from there, since it only touches what's already installed, not anything relative to where it's run from.

### Uninstalling

Double-click **`Uninstall Roon Display.command`** (from the original package, or the copy left behind in `/Applications/roon-local-services/`, see above). Asks you to type `UNINSTALL` (the full word) before touching anything -- anything else cancels with no changes made. What it does, in order:

1. Stops the `launchd` service **first** -- doing this before removing files matters: `KeepAlive: true` means the service relaunches itself the moment it dies, which would otherwise recreate `proxy.log`/`proxy-error.log` under the folder you just deleted, making it look like the uninstall didn't work
2. Removes the LaunchAgent plist
3. Restores `display_ui.html`/`.js` in Roon's webroot from the most recent `.backup-*` file the installer made (if one exists) -- so Roon goes back to how it looked before this project touched it
4. Copies `roon-local-services/` in its entirety -- `.env` and its API keys, `config.json`, `ai-cache.json` if present, everything -- to a timestamped backup on your Desktop, then deletes the real one. Nothing is singled out or excluded; it's a whole-folder copy, so anything living in that folder is preserved this way without needing its own special case

Nothing is destroyed without a copy existing somewhere first -- re-running `Install Roon Display.command` afterward is a genuine fresh install (no `.env` left behind to make it think otherwise), not a recovery from a half-broken state.

## Files Involved and Their Status

-   **`display_ui.html`** — MODIFIED. Lives at `/Applications/Roon.app/Contents/Resources/webroot/display_ui.html` — inside Roon's own app bundle, so a **Roon update will overwrite it**; the Guardian (see "When Roon Updates" below) now restores it automatically within a minute, so this no longer needs a manual redeploy in normal use. Contains, at the top of the file, the entire `window.DisplayConfig` block (colors, spacing, button sizes, image filters, proxy URLs, matching thresholds, etc.) inside an inline `<script>` tag, followed by the stylesheet and the remote-control script. Search for `window.DisplayConfig = {` to find the parameters to tweak by hand — or use the Admin Panel below for the parameters it covers, which writes into this same file for you.
-   **`display_ui.js`** — the Cast/browser bootstrap script, same location as `display_ui.html`. Also carries the cache-busting for `display_ui.html` (see below). Not something this project's tooling edits automatically — its `?v=N` bump stays a manual, deliberate step on your end.
-   **`roon-local-services/`** (this folder) — lives at `/Applications/roon-local-services/`, entirely separate from Roon's directory. Survives every Roon update untouched — no restore, no reinstall needed on that front. Contains:
    -   `server.js` — local proxy: Discogs lookups (`/search`, `/release/:id`, replacing the old Cloudflare Worker), AI generation (`/ai/providers`, `/ai/review`, `/ai/composition`, `/ai/artist`), and mounts the admin panel's routes.
    -   `ai.js` — AI provider calls (Claude, ChatGPT), web search (see AI Features below), and the server-side response cache (via `cache.js`). Builds its provider list from `config.json` (order, models, reasoning effort) and `.env` (API keys — the only thing about a provider that stays secret). Also owns the identity-key normalization pipeline (spacing/case/accents, plus admin's configurable "Key normalization" symbol-cutting rules for album/track) and the disambiguation check (admin's three checkboxes) that inspects a response for `{ambiguous: true, candidates: [...]}` *before* it's cached, so an ambiguous answer never gets persisted as if it were real content.
    -   `cache.js` — reads/writes/merges `ai-cache.json`; stamps a `createdAt` timestamp on every write, unconditionally, so admin's cache-clearing (Network & Maintenance tab: Clear all / Clear artist / Clear album / Clear composition, each combinable with a date filter -- any date, on, before, or a range) has something to filter by. Entries written before this feature existed simply have no `createdAt` and are only ever matched by "any date". `ai.js` still decides what's cached and under what key -- this file's only real logic of its own is that timestamp and the date/kind filtering.
    -   `display-defaults.json` — single reference for every Look and Feel, Data Sources, and Logs field that has a plain-input default: key (the flat name used in the admin API's JSON), block/prop (where it lives inside `display_ui.html`), type, category (which of the three admin tabs it belongs to), and default value. `admin.js` loads this at startup, splits it by category into its own field tables (`DISPLAY_CONFIG_FIELDS.lookAndFeel`/`dataSources`/`logs`), and also serves the `default` values to each tab's "Restore defaults" button and per-field ↺/💾 (reset / save-current-as-default) buttons — one file instead of separate, driftable copies. `sourceOrder` (Data Sources' reorderable source-priority list) is deliberately NOT in this file -- it's a widget, not a plain input, so it's read/written normally but has no default/reset here. Doesn't affect `display_ui.html`'s own embedded defaults (what a *fresh install* actually starts with) -- those remain separate literals in that file; keep both in sync by hand when adding or changing a field, or use the 💾 buttons to pull the current live value back into this file instead.
    -   `admin.js` + `admin.html` — the local admin panel (see Admin Panel below). `admin.js` registers the routes and does all the file reading/writing; `admin.html` is the page itself (plain JS, runs in Safari only, never on the TV).
    -   `guardian.js` — watches `display_ui.html`/`.js` and auto-restores them after a Roon update; see "When Roon Updates" below for how it works. Keeps its own protected copies in `roon-local-services/backups/` (created automatically, not shipped).
    -   `config.json` — non-secret AI settings: response language, target text length, provider order/default, model names, reasoning effort, style prompts, web search settings, key normalization rules (the admin panel's "Key normalization" table), and disambiguation (the three artist/album/composition checkboxes). Editable by hand or via the Admin Panel's "AI" tab. **Not** a place for secrets — those stay in `.env`.
    -   `package.json` — dependencies (`express`, `cors`, `dotenv`, `node-fetch`).
    -   `deployment.md` — this file. Installed/updated automatically alongside the code by the installer.
    -   `ai-cache.json` — **not shipped, not present until first use**. Created by `cache.js` the first time any AI response gets cached; grows from there. See the Admin Panel's Network & Maintenance tab for clearing/exporting/importing it, and "Post-Deployment Structure" above for where it lives.
    -   `.env` — secrets and machine-specific values. `DISCOGS_TOKEN` missing no longer stops the proxy from starting at all -- only `/search` and `/release/:id` return 503 until it's set (this used to be a hard startup failure; changed because it created a chicken-and-egg problem with the installer's own fresh-install flow, which deliberately leaves keys blank for you to fill in from the admin panel afterward). Current keys:
        -   `DISCOGS_TOKEN` — Discogs API token
        -   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — AI provider keys (either or both; a provider with no key simply doesn't appear in the AI agent dropdown)
        -   `ADMIN_PASSWORD` — the admin panel's password. **If blank/unset, `admin` is the effective password** — this is the deliberate fresh-install/reset state, not a disabled state (there's no way to disable the panel entirely). Logging in with `admin` forces an immediate password change; `admin` itself can never be *set* as the password again once changed. See Admin Panel below.
        -   `PROXY_HOST` / `PORT` — this Mac's address, e.g. `192.168.2.11` / `3001`. Changing either here (via the Admin Panel) also rewrites `display_ui.html`'s `discogsProxyUrl`/`aiInfo.proxyBaseUrl` automatically, if `ROON_DISPLAY_UI_PATH` (below) is set.
        -   `ROON_DISPLAY_UI_PATH` — absolute path to the real `display_ui.html` (see above). Required for the Admin Panel's "Look and Feel" and "Data Sources" tabs, and for the Host/Port auto-sync, to work at all. The installer sets this automatically.
        -   `ALLOWED_ORIGIN` — CORS origin, `*` today.
    -   `local_roondisplay_proxy.plist` — macOS `launchd` autostart config, `Label: local.roondisplay.proxy`, `KeepAlive: true`. Installed separately in `~/Library/LaunchAgents/`, generated fresh by the installer each time (with the correct Node path baked in) rather than hand-edited. Logs to `proxy.log` / `proxy-error.log` in this same folder.

    Runs on the Mac, port 3001 by default. `display_ui.html`'s `discogsProxyUrl` and `aiInfo.proxyBaseUrl` both point to `http://<PROXY_HOST>:<PORT>` — that link, plus `ROON_DISPLAY_UI_PATH` pointing the other way, are the only connections between the two locations.

## AI Features (Album / Composition / Artist)

Three AI-generated info panels, opened from the control bar's second row (Album, Composition buttons; Artist button right after Queue):

-   **Album** — review of the recording/performance, plus Artists/Release Year/Genre-Style. Cached per album.
-   **Composition** — analysis of the track's compositional characteristics (not the recording), plus Composer/Year/Genre-Style. Cached per track.
-   **Artist** — bio plus Timeline (life or formation/dissolution span — labeled "Timeline" rather than "Active" since a birth year isn't the same as an active period)/Country. One or more artists parsed from Roon's own artist string; a picker dropdown appears when there's more than one. Cached per artist name (shared across every album/track by them).

All three call the local proxy only (`/ai/review`, `/ai/composition`, `/ai/artist`) — the TV never talks to Claude/ChatGPT directly, and no API key ever reaches the client. An AI agent dropdown (the sparkle icon, last button in row 2) lets you pick which provider generates the current text; the default is the first provider in `config.json`'s `providerOrder` that has a key set in `.env`.

Optional **style prompts** (one each for Album/Composition/Artist, in `config.json`'s `stylePrompts`, or the Admin Panel's "AI" tab) steer the tone of the generated text — write them in any language, the output still comes back in whatever `aiLanguage` is set to.

Tune language, text length, provider order/models/reasoning effort, style prompts in `config.json` (or the Admin Panel) — changes need a **proxy restart** to take effect, same as any other `.env`/`config.json` edit.

## Admin Panel

A local web UI for editing all of the above without hand-editing files.

-   **URL:** `http://<PROXY_HOST>:<PORT>/config` (e.g. `http://192.168.2.11:3001/config`)
-   **Login:** a real login screen inside the page itself (not a browser popup) — the page shell loads without a prompt, then asks for the password before showing any data.
-   **Must be opened as a URL, not a local file.** Double-clicking `admin.html` or dragging it into Safari loads it from `file://`, which can't reach the proxy's API and fails with a generic "Load failed" error. Always navigate to the `/config` URL above.

### First login / forgotten password

- `ADMIN_PASSWORD` unset in `.env` -> the effective password is **`admin`**. Logging in with it immediately shows a forced "set a new password" screen -- you can't dismiss it or use `admin` again as the new value.
- **Forgot your password?** Click "Forgot password?" on the login screen -> confirm -> this clears `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `DISCOGS_TOKEN`, resets `ADMIN_PASSWORD` back to the `admin` sentinel, and restarts the proxy automatically. Everything else (host/port/path, `config.json`) is untouched. No terminal needed, but also no confirmation beyond the one in-browser dialog -- anyone who can reach the login page on your network can trigger this, same trust model as the rest of this local-network-only setup.
- Voluntary password changes (not forced) live in the **Network & Maintenance** tab's Password Manager -- same rules (can't reuse `admin`).

### The six tabs

1.  **Look and Feel** -- colors, text-box opacity/brightness, album art size (including the "Opacity back" field controlling how much the front cover shows through the info overlay), image filters (album art / background artist / blurred background album, including hue rotation), AI text panel height and font size, the Three text lines section (independent show/hide checkboxes for the Album/Track/Artists now-playing lines -- hiding one leaves its space empty, no reflow), and the Clock section (enabled checkbox, font size, 12h/24h format). Writes directly into `display_ui.html` at `ROON_DISPLAY_UI_PATH` -- **requires that variable to be set first** (tab shows a warning banner and disables Save until it is). Changes need a **Roon Server restart** to show up on the TV.
2.  **Data Sources** -- Discogs/iTunes/Deezer source order (reorderable), debug overlay toggle, fuzzy-matching similarity thresholds. Same file, same restart requirement as above.
3.  **API Keys** -- Anthropic/OpenAI/Discogs keys (masked; leave a field blank to keep its current value, the real value is never sent back to the browser). Each has its own **Clear** button for explicit removal -- a blank field alone means "leave unchanged," not "delete."
4.  **AI (settings and prompts)** -- response language, text length, provider order/models/reasoning effort, and the three style prompts.
5.  **Network & Maintenance** -- proxy host/port/origin, `ROON_DISPLAY_UI_PATH`, a banner showing this Mac's currently-detected IP and MAC address (with a warning + one-click fix if the configured host has drifted from the actual current IP), the Password Manager, Export/Import of everything above except secrets, and the **Restart proxy** button (polls until it's back up -- `launchd`'s `KeepAlive: true` brings it back automatically after it exits).
6.  **Version** -- read-only, no save/reset. Shows three independent x.y version numbers: Display UI (HTML), Display UI (JS), and Admin (admin.js + admin.html count as one unit). See "Versioning" below for where these live and how they're bumped.

### Versioning

Three independent x.y numbers, starting at 1.0, one per component -- bumped only by hand, only when explicitly asked for, never automatically:

-   **Display UI (HTML)** -- `window.DISPLAY_UI_VERSION = '1.0';` near the top of `display_ui.html`, right before `window.DisplayConfig = {...}`.
-   **Display UI (JS)** -- `var DISPLAY_UI_JS_VERSION = '1.0';` inside `display_ui.js`, placed right before `applyDisplayConfig()` rather than at the top of the file -- everything above that point in `display_ui.js` is Roon's own original bundle, untouched by this project; that marker is where "our" code in that file starts.
-   **Admin** -- `const ADMIN_VERSION = '1.0';` near the top of `admin.js`. Covers `admin.js` + `admin.html` together as one unit, since they're never deployed separately.

`admin.js`'s `getVersions()` reads all three live off disk on every `/api/config` request (never cached): `display_ui.js`'s path is derived from `ROON_DISPLAY_UI_PATH`'s own directory (same folder, filename `display_ui.js` -- no separate `.env` setting needed), and each marker is picked out with a plain regex, not the block/prop mechanism `display-defaults.json` fields use (a version number isn't a tunable setting, so it's deliberately outside that reset/backup pipeline). Shown read-only in the Version tab.

### Re-baking Your Own Settings as the Shipped Defaults

If your live Look and Feel / AI settings should become what a **fresh install** or a brand-new install (a second Mac, say) starts with, three places need updating together, all with the SAME values:

1.  `config.json` (in the package) -- AI language, style prompts, web search, disambiguation, key normalization rules, etc. Only ever copied to `/Applications/roon-local-services/` on a fresh install (see "What Install Does" above), so editing the packaged copy never touches your live `.env`/`config.json`.
2.  `display-defaults.json`'s `default` field, for every Look and Feel/Data Sources/Logs key that changed -- what a field resets to via ↺/Restore Defaults, and what a fresh `display_ui.html` starts with before any admin save.
3.  The matching literal values inside `display_ui.html`'s own `window.DisplayConfig = {...}` block -- the actual values a brand-new copy of that file renders with, independent of `display-defaults.json` (which only governs the *reset* target once the file already exists). These two have to be kept in sync by hand (or via the 💾 save-as-default buttons, which only update `display-defaults.json`, not the file's own literals).

`env`/`.env` values (host, port, path) are intentionally left out of this -- they're already auto-detected or auto-defaulted by the installer (`PROXY_HOST` from this Mac's own IP, `ROON_DISPLAY_UI_PATH` from Roon's detected webroot) and contain nothing worth hand-baking. API keys, the Discogs token, and the admin password are never included in any of this either way.

## Manual Proxy Setup (if not using the installer)

1.  Copy the whole `roon-local-services/` folder to `/Applications/roon-local-services/`, then move into it:
    ```bash
    cd /Applications/roon-local-services
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create `.env` if it doesn't exist -- see the full key list above. At minimum `DISCOGS_TOKEN` is required to start at all. Leave `ADMIN_PASSWORD` unset for a fresh install (defaults to `admin`, forces a change on first login).
4.  Test manually before relying on autostart:
    ```bash
    node server.js
    ```
    You should see `Discogs + AI proxy listening on port 3001`, `[ai] configured providers: ...`, and `[admin] panel enabled at /config`. In another terminal:
    ```bash
    curl "http://localhost:3001/search?q=Radiohead+OK+Computer"
    ```
    Should return JSON with a `results` field. Then `Ctrl+C` to stop it.
5.  Find node's exact path (`which node`) and write `local_roondisplay_proxy.plist` by hand with that path and `/Applications/roon-local-services` baked into `ProgramArguments`/`WorkingDirectory` (or just run the installer once, which generates this file for you even if you did everything else by hand).
6.  Install and load the autostart config:
    ```bash
    cp local_roondisplay_proxy.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local_roondisplay_proxy.plist
    ```
7.  Confirm it's running, then reserve this Mac's IP in the router's DHCP settings (by MAC address) so it never changes -- the admin panel's Network & Maintenance tab shows both values.

## When Roon Updates

Since `roon-local-services/` lives outside Roon's own app bundle, a Roon update doesn't touch it at all -- no restore, no reinstall, `launchd` keeps the proxy running through the update uninterrupted.

`display_ui.html` and `display_ui.js`, however, live **inside** `Roon.app`'s own bundle and get overwritten by Roon's own stock versions on every update. **This is now handled automatically by the Guardian (`guardian.js`)** -- no manual redeploy needed:

- Every 60 seconds (and once immediately whenever the proxy starts, so a reboot-triggered update is caught right away), the proxy checks both files for our markers (`window.DisplayConfig` in `display_ui.html`, `DISPLAY_UI_JS_VERSION` in `display_ui.js`). Roon's own stock files never contain these.
- If a marker is **missing**, the Guardian assumes Roon just overwrote the file and immediately restores its own protected backup (kept in `roon-local-services/backups/`), then fires a macOS notification ("display_ui.html was reset by a Roon update -- restored your customized version.") and logs it.
- If a marker is **present** but the content differs from the backup, the Guardian assumes this is a legitimate new version (an admin save, or you manually installing a file I sent you) and quietly adopts it as the new protected backup -- no notification, just a log line.
- An admin save to Look and Feel/Data Sources/Logs (or the Network tab's PROXY_HOST sync) refreshes the backup immediately, not on the next 60s tick.

What this means in practice:
1.  After a Roon update, give it up to a minute (or just restart the proxy, which checks immediately) -- the customized `display_ui.html`/`.js` come back on their own.
2.  If you see the macOS notification, that confirms it happened -- no action needed unless the notification style is set to disappear too fast to notice (see below).
3.  Test on the actual TV, not just Safari -- same as always. If the display still looks like stock Roon after a minute, check `roon-local-services/backups/` exists and isn't empty, and check the proxy log for `[guardian]` lines.

**macOS notification persistence**: whether the notification stays on screen until dismissed or disappears after a few seconds is controlled by System Settings, not by the proxy. It appears under the app that runs `osascript` (usually "Script Editor" or "Terminal") in **System Settings → Notifications** -- set that app's style to **Alerts** if you want it to stay until you close it; **Banners** (the default) disappears on its own after a few seconds.

Manual fallback (Guardian down for some reason, or no backup yet exists): re-run the installer, or manually redeploy `display_ui.html`/`.js` to `/Applications/Roon.app/Contents/Resources/webroot/` from your own saved copies.

## When You Modify `display_ui.html` and/or `display_ui.js`

1.  If you modified `display_ui.html`, bump the `?v=N` number inside `display_ui.js`:
    ```js
    $("#uiParent").load('display_ui.html?v=N', ...)
    ```
    If you only modified `display_ui.js`, no need to touch the number.
2.  Copy the modified file(s) to `/Applications/Roon.app/Contents/Resources/webroot/` (or re-run the installer), and test.

This applies whether you edited the file by hand or it was written by the Admin Panel's Look and Feel/Data Sources tabs -- either way it's the same file, same cache-busting rule, same restart-Roon-Server-to-see-it requirement.

> **Note:** If you ever run into "ghost" behavior again (changes that don't show up, on either Safari or Google TV), the number-one suspect is always caching -- ensure you bumped `?v=N` above before assuming it's a code bug.

## When You Modify the Local Proxy (`server.js`, `ai.js`, `admin.js`, `config.json`, or `.env`)

1.  Edit the file(s) from inside this folder -- by hand, via the Admin Panel, or by re-running the installer with updated source files.
2.  Restart it. The routine way (works as long as the `launchd` job is already loaded):
    ```bash
    launchctl kickstart -k gui/$(id -u)/local.roondisplay.proxy
    ```
    Or use the Restart proxy button in the admin panel's Network & Maintenance tab, which does the same thing from the browser. If neither seems to take effect (stale process still holding the port -- check with `lsof -nP -iTCP:3001 -sTCP:LISTEN`), fall back to a full unload/reload:
    ```bash
    launchctl bootout gui/$(id -u)/local.roondisplay.proxy
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local_roondisplay_proxy.plist
    ```
3.  Re-test with `curl` before trusting it on the TV (see the AI Features section above for example `curl` commands against `/ai/review`, `/ai/composition`, `/ai/artist`).
4.  If you added dependencies to `package.json`, run `npm install` again before restarting.

## Rollback

If the local proxy causes problems, revert in `display_ui.html`:
```javascript
discogsProxyUrl: 'https://discogs-proxy.peurderien.workers.dev',
```
and redeploy.

To disable the AI features specifically without touching anything else, clear both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (their Clear buttons in the admin panel's API Keys tab, or blank them in `.env`) and restart the proxy -- `/ai/providers` returns an empty list, and the client shows "No AI agent configured" instead of erroring.

Locked out of the admin panel entirely? Use "Forgot password?" on the login screen (see Admin Panel above) -- no terminal needed.

## Useful Commands

```bash
# routine restart after a server.js/ai.js/admin.js/config.json/.env change
launchctl kickstart -k gui/$(id -u)/local.roondisplay.proxy

# full stop/start (only if kickstart doesn't seem to take effect)
launchctl bootout gui/$(id -u)/local.roondisplay.proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local_roondisplay_proxy.plist

# check nothing orphaned is still holding the port
lsof -nP -iTCP:3001 -sTCP:LISTEN

# tail logs
tail -f proxy.log
tail -f proxy-error.log
```
