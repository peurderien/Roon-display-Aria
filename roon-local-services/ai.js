// AI text generation for album reviews, composition info, and artist bios.
// Two providers (Claude, ChatGPT) called directly -- no extra abstraction
// layer, since server.js is a single file and this mirrors that style.
'use strict';

require('dotenv').config();
const fetch = require('node-fetch');
const cache = require('./cache.js');

// Moved here from server.js -- generateAIText below needs to parse the
// model's raw response itself now (to check for an ambiguous-response
// shape before deciding whether to cache it), so this can't stay
// server-js-only anymore. server.js's own three routes now call
// ai.stripJsonFences instead of keeping a second copy.
//
// Also extracts the outermost {...} object, discarding any prose the
// model wrote before or after it -- observed in practice from the
// cheapest tier of both families (claude-haiku-4-5, gpt-5.6-luna): a
// preamble like "Based on my research, I have clear and unambiguous
// information... I now have sufficient information to provide the
// requested JSON response" ahead of the actual ```json block, seemingly
// the model "thinking out loud" about the disambiguation instruction's
// ambiguity question before settling on an answer, even when it
// concludes there's no ambiguity. Just stripping ```/```json markers
// left that preamble in place, so the string never started with '{' and
// JSON.parse failed immediately regardless of what followed. Taking the
// first '{' through the last '}' instead works regardless of whatever
// surrounds it, without depending on the model changing this habit.
function stripJsonFences(text) {
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
    return cleaned;
}

const fs = require('fs');
const path = require('path');

const UPSTREAM_TIMEOUT_MS = 45000; // AI generation is slower than Discogs lookups -- raised twice from 15s: ChatGPT with reasoning_effort was still timing out at 30s in practice
// Web search adds a real search-and-read cycle on top of plain generation
// (sometimes several, up to webSearch.maxUses) -- doubled from the plain
// budget above as a starting point. Raise this if real usage shows it's
// still too tight, the same way UPSTREAM_TIMEOUT_MS itself was raised twice.
const WEB_SEARCH_TIMEOUT_MS = 90000;

const CONFIG_PATH = path.join(__dirname, 'config.json');

// Loaded once at process start -- same "restart required to pick up
// changes" model as .env, no hot-reload/file-watching. The admin panel
// (admin.js) writes this file directly; picking up its changes needs an
// explicit proxy restart (same as .env changes always have).
function loadAppConfig() {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
}
const appConfig = loadAppConfig();

// Defaults mirror config.json's own fresh-install shape -- only matters if
// an older config.json (from before this feature existed) is still in use
// and doesn't have this key at all yet.
const webSearchConfig = appConfig.webSearch || {
    mode: 'never',
    maxUses: 1,
    useDomainFilter: false,
    preferredDomains: [],
    fallbackIfEmpty: true
};

// Same reasoning as webSearchConfig above -- only matters for a
// config.json from before this feature existed. Empty array = today's
// plain normalizeForCacheKey output, unchanged, until a rule is added.
const keyNormalizationRules = appConfig.keyNormalizationRules || [];

// Everything that's genuinely secret stays in .env (never in config.json):
// only the API key env var name is looked up here, the key's actual value
// is read fresh from process.env at call time, never cached in this object.
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT' };
const PROVIDER_API_KEY_ENV = { claude: 'ANTHROPIC_API_KEY', chatgpt: 'OPENAI_API_KEY' };
const PROVIDER_CALL = { claude: callClaude, chatgpt: callChatGPT }; // function decls below are hoisted, fine to reference here

// Built from config.json's providerOrder/models/reasoningEffort.
// providerOrder's array order is what controls dropdown order and the
// default (first entry with a configured API key wins) -- same rule as
// before, just driven by config.json now instead of a hardcoded array.
const PROVIDER_DEFS = (appConfig.providerOrder || []).map(function (id) {
    return {
        id: id,
        label: PROVIDER_LABELS[id] || id,
        apiKeyEnv: PROVIDER_API_KEY_ENV[id],
        model: appConfig.models && appConfig.models[id],
        reasoningEffort: (appConfig.reasoningEffort && appConfig.reasoningEffort[id]) || null
    };
});

// Mirrors fetchDiscogs()'s timeout pattern in server.js.
function fetchWithTimeout(url, ms, options) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, ms);
    const opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
}

// "https://www.allmusic.com/album/xyz?foo=bar" -> "allmusic.com" -- the
// central info panel shows bare site names next to the AI source, not
// full URLs (per request: "elenco testuale, senza link cliccabile").
function extractDomain(url) {
    try {
        const hostname = new URL(url).hostname;
        return hostname.indexOf('www.') === 0 ? hostname.slice(4) : hostname;
    } catch (err) {
        return null;
    }
}

function dedupeDomains(domains) {
    const seen = {};
    const out = [];
    domains.forEach(function (d) {
        if (d && !seen[d]) { seen[d] = true; out.push(d); }
    });
    return out;
}

// ---------------------------------------------------------------------------
// Claude -- Messages API, unchanged endpoint for both search and non-search
// calls (only the `tools` array differs). Web search tool reference:
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
// Verified against that page's current examples on the day this was
// written; NOT live-tested against a real API key from this environment --
// confirm with a real curl call before trusting the source-extraction
// logic below in production.
// ---------------------------------------------------------------------------
async function callClaude(prompt, apiKey, model, reasoningEffort, searchOptions) {
    const useSearch = searchOptions && searchOptions.mode !== 'never';
    let effectivePrompt = prompt;
    const body = {
        model: model,
        max_tokens: 3000, // raised from 1400 to match ChatGPT's 3000-token budget -- Enrico observed Claude hitting "Content not available" (truncated/invalid JSON) more often than ChatGPT, and this was the leading suspect: a tighter output ceiling means more truncation risk on a naturally long response, especially one with web-search citations woven in
        messages: [{ role: 'user', content: effectivePrompt }]
    };

    if (useSearch) {
        if (searchOptions.mode === 'always') {
            // No confirmed way to hard-force Claude's server-side web_search
            // tool via tool_choice the same way client-side tools support --
            // a plain instruction is the reliable lever here instead. This
            // also covers 'whenUseful's escalation retry in generateAIText,
            // which runs this same code path with mode temporarily set to
            // 'always' -- see that function's own comment on why.
            effectivePrompt += ' Before writing your answer, you MUST perform at least one web search using the tool provided.';
            body.messages[0].content = effectivePrompt;
        }
        const tool = {
            type: 'web_search_20250305', // basic version: no allowed_callers complications, works across models -- see the file-level comment on why the newer dynamic-filtering versions were deliberately skipped
            name: 'web_search',
            max_uses: searchOptions.maxUses
        };
        if (searchOptions.useDomainFilter && searchOptions.preferredDomains && searchOptions.preferredDomains.length) {
            tool.allowed_domains = searchOptions.preferredDomains;
        }
        body.tools = [tool];
    }

    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', useSearch ? WEB_SEARCH_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const errBody = await res.text();
        throw new Error('Claude API ' + res.status + ': ' + errBody);
    }
    const data = await res.json();
    const content = data.content || [];

    // The final answer is every text block AFTER the last search/tool-use
    // block, concatenated -- NOT just the single last text block (that was
    // tried and was wrong: when Claude cites web sources inline, it often
    // splits its own final answer across several consecutive text blocks,
    // one per citation span, so taking only the last one silently drops
    // everything written before the final citation -- observed in practice
    // as JSON truncated partway through a value, not at a clean boundary).
    // Any preliminary text block BEFORE the first tool-use (e.g. "I'll
    // search for...") is still correctly excluded by this cutoff.
    let lastToolIndex = -1;
    content.forEach(function (b, i) {
        if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastToolIndex = i;
    });
    const textBlocks = content
        .slice(lastToolIndex + 1)
        .filter(function (b) { return b.type === 'text'; });
    if (!textBlocks.length) throw new Error('Claude API returned no text block');
    const text = textBlocks.map(function (b) { return b.text; }).join('');

    if (!useSearch) return { text: text, sources: [], searchAttempted: false, searchCount: 0 };

    const searchCount = content.filter(function (b) { return b.type === 'server_tool_use' && b.name === 'web_search'; }).length;
    const searchAttempted = searchCount > 0;
    const domains = [];
    content.filter(function (b) { return b.type === 'web_search_tool_result'; }).forEach(function (block) {
        (block.content || []).forEach(function (result) {
            if (result && result.url) domains.push(extractDomain(result.url));
        });
    });
    return { text: text, sources: dedupeDomains(domains), searchAttempted: searchAttempted, searchCount: searchCount };
}

// ---------------------------------------------------------------------------
// ChatGPT -- Chat Completions API when search is off (unchanged from
// before this feature existed, zero risk to the common case), Responses
// API when search is on. OpenAI's web_search tool is ONLY available via
// /v1/responses, not /v1/chat/completions -- confirmed in current docs.
// https://platform.openai.com/docs/guides/tools-web-search
// Verified against that page's current examples on the day this was
// written; NOT live-tested against a real API key from this environment --
// confirm with a real curl call before trusting the source-extraction
// logic below in production. In particular: unlike Claude, OpenAI's
// web_search tool has no documented per-request "max searches" cap --
// searchOptions.maxUses is NOT enforced for this provider, only used to
// decide 'auto' vs forced tool_choice. Real usage could involve several
// searches per generation with no hard ceiling on this provider's side.
// ---------------------------------------------------------------------------
async function callChatGPT(prompt, apiKey, model, reasoningEffort, searchOptions) {
    const useSearch = searchOptions && searchOptions.mode !== 'never';

    if (!useSearch) {
        const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', UPSTREAM_TIMEOUT_MS, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: model,
                // Reasoning models (gpt-5.6 and later) reject 'max_tokens' --
                // OpenAI requires 'max_completion_tokens' instead. Budget is
                // higher than Claude's (1400) because reasoning tokens are
                // spent from this same pool before any visible output text is
                // produced, on top of the review/composition/bio text itself.
                max_completion_tokens: 3000,
                reasoning_effort: reasoningEffort,
                messages: [{ role: 'user', content: prompt }]
            })
        });
        if (!res.ok) {
            const errBody = await res.text();
            throw new Error('OpenAI API ' + res.status + ': ' + errBody);
        }
        const data = await res.json();
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message || !choice.message.content) {
            throw new Error('OpenAI API returned no content');
        }
        return { text: choice.message.content, sources: [], searchAttempted: false, searchCount: 0 };
    }

    // --- Responses API path (search on) -------------------------------
    let effectivePrompt = prompt;
    const tool = { type: 'web_search' };
    if (searchOptions.useDomainFilter && searchOptions.preferredDomains && searchOptions.preferredDomains.length) {
        tool.filters = { allowed_domains: searchOptions.preferredDomains };
    }
    const body = {
        model: model,
        reasoning: { effort: reasoningEffort },
        max_output_tokens: 3000, // Responses API's equivalent of max_completion_tokens above
        tools: [tool],
        include: ['web_search_call.action.sources'], // full source list independent of whether the model inline-cites anything in a JSON-only answer
        input: effectivePrompt
    };
    if (searchOptions.mode === 'always') {
        body.tool_choice = { type: 'web_search' }; // forces at least one call, unlike Claude where this isn't confirmed to work for server-side tools
        body.input += ' Before writing your answer, you MUST perform at least one web search using the tool provided.';
    } else {
        body.tool_choice = 'auto';
    }

    const res = await fetchWithTimeout('https://api.openai.com/v1/responses', WEB_SEARCH_TIMEOUT_MS, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const errBody = await res.text();
        throw new Error('OpenAI API ' + res.status + ': ' + errBody);
    }
    const data = await res.json();

    // output_text is a documented convenience shortcut for "the final
    // message's text" -- falls back to manually finding it if a given
    // account/SDK version doesn't populate it.
    let text = data.output_text;
    if (!text) {
        const output = data.output || [];
        const messageItem = output.find(function (item) { return item.type === 'message'; });
        text = messageItem && messageItem.content && messageItem.content[0] && messageItem.content[0].text;
    }
    if (!text) throw new Error('OpenAI API returned no message text');

    const output = data.output || [];
    const searchCalls = output.filter(function (item) { return item.type === 'web_search_call'; });
    const domains = [];
    searchCalls.forEach(function (call) {
        const sources = call.action && call.action.sources;
        (sources || []).forEach(function (s) {
            const url = typeof s === 'string' ? s : s && s.url;
            if (url) domains.push(extractDomain(url));
        });
    });
    return { text: text, sources: dedupeDomains(domains), searchAttempted: searchCalls.length > 0, searchCount: searchCalls.length };
}

// Providers whose API key is actually set in .env, in config.json's
// providerOrder order. The client dropdown is built directly from this
// list; empty list means no provider configured (client disables the AI
// button entirely).
function getAvailableProviders() {
    return PROVIDER_DEFS
        .filter(function (p) { return !!process.env[p.apiKeyEnv]; })
        .map(function (p) {
            const entry = { id: p.id, label: p.label, model: p.model };
            if (p.reasoningEffort) entry.reasoningEffort = p.reasoningEffort;
            return entry;
        });
}

function getDefaultProviderId() {
    const available = getAvailableProviders();
    return available.length ? available[0].id : null;
}

// Word-count threshold below which a no-search first attempt's content
// field is treated as "essentially nothing to say" and worth escalating
// to a search-enabled retry. Arbitrary but deliberately low -- this is a
// last-resort trigger, not a quality bar; a properly answered request
// (textLengthWords is usually 150-250) landing under this is a clear
// outlier, not a borderline case worth debating.
const INADEQUATE_WORD_THRESHOLD = 20;

// contentField is which JSON field to check (review/text/bio -- one per
// route). Returns true (treat as inadequate, worth escalating) if the
// text isn't valid JSON at all, the field is missing/empty, or it's
// suspiciously short. Strips ```json fences the same way server.js's own
// stripJsonFences() does before parsing, so a model that wraps its JSON
// in markdown fences isn't mistaken for one that returned nothing useful.
function isInadequate(text, contentField) {
    if (!contentField) return false; // caller didn't ask for this check
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        return true;
    }
    const val = parsed[contentField];
    if (!val || typeof val !== 'string') return true;
    const wordCount = val.trim().split(/\s+/).filter(Boolean).length;
    return wordCount < INADEQUATE_WORD_THRESHOLD;
}

// Maps the three route "kinds" to their JSON content field (checked by
// isInadequate) and their config.json stylePrompts key (album's kind is
// called "review" everywhere else in this file, but its style prompt is
// stored under "album" -- this is the one place that mismatch needs
// reconciling).
const KIND_INFO = {
    review: { contentField: 'review', styleKey: 'album' },
    composition: { contentField: 'text', styleKey: 'composition' },
    artist: { contentField: 'bio', styleKey: 'artist' }
};

// Trim + lowercase for cache-key purposes only -- never applied to what's
// actually sent to the AI provider (that still uses the exact casing Roon
// reports), just to how two requests are compared for "is this the same
// thing". Matches what the OLD client-side cache key already did -- since
// removed (see the client-side cache removal further down/in
// display_ui.html), this is now the ONLY place this normalization
// happens, not two kept-in-sync copies.
function normalizeForCacheKey(s) {
    return (s || '').toString()
        .replace(/\s+/g, ' ')   // collapse runs of whitespace (double spaces, tabs, non-breaking spaces) to one normal space
        .trim()
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // strip accents/diacritics (café -> cafe, Björk -> bjork)
}

// Admin's "Key normalization" table (config.json's keyNormalizationRules,
// AI settings tab) -- applies AFTER normalizeForCacheKey above (so every
// symbol/containsAny comparison here happens on already-lowercased/accent-
// stripped text: writing "live" in the admin table catches "Live"/"LIVE"
// without needing separate case handling, and "remaster" as a containsAny
// value catches "remastered" too since it's a plain substring check).
// NEVER applied to artist -- only album ('review' kind) and track
// ('composition' kind), per field is the caller's job to gate (see the two
// call sites below). This REPLACES the old hardcoded bracket-stripping
// (used to strip "(...)"/"[...]" for artist/track, never album) -- that
// fixed shape covered fewer cases than a real rule table can, and this is
// deliberately more general even though it starts out empty (no rules
// configured = identical to today's plain normalizeForCacheKey output).
//
// Rules chain in table order: each row either cuts the text (if one of
// its symbols matches) or passes it through unchanged, then the NEXT row
// runs on whatever the previous row left behind -- this is not "first
// matching row wins", every row gets a turn. WITHIN one row, though, it
// IS "first matching symbol wins": symbols in that row's list are tried
// in the order written, and the first one whose cut point satisfies
// containsAny stops the search for that row (the row's remaining symbols
// are never tried once one has matched).
//
// A symbol's cut POINT depends on lastOccurrenceOnly: false (default) is
// the first place the symbol appears in the current text; true is the
// LAST place -- which resolves the "the symbol also appears earlier for
// an unrelated reason" case: e.g. symbol "-", text "devolva-me - live",
// lastOccurrenceOnly true finds the space-separated "-" before "live"
// (the last "-" in the string) rather than the one inside "devolva-me"
// (the first), giving "devolva-me" instead of incorrectly cutting at the
// word-internal hyphen and losing "me" too.
//
// Once a symbol's cut point is found, containsAny gates whether the cut
// actually happens: the text FROM that symbol onward (symbol included) is
// only removed if it contains at least one of containsAny's entries (or
// unconditionally, if containsAny is empty) -- e.g. symbols=["-"],
// containsAny=["live","remix"] only cuts "Track - Live" and "Track -
// Remix", not "Track - Extended Version".
function applyKeyNormalizationRules(text, field, rules) {
    let result = text;
    (rules || []).forEach(function (rule) {
        const appliesToThisField = field === 'album' ? rule.appliesToAlbum : rule.appliesToTrack;
        if (!appliesToThisField) return;
        const symbols = rule.symbols || [];
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            if (!symbol) continue;
            const idx = rule.lastOccurrenceOnly ? result.lastIndexOf(symbol) : result.indexOf(symbol);
            if (idx === -1) continue; // this symbol doesn't appear at all -- try the next one in this row
            const removedPart = result.slice(idx);
            const containsAny = rule.containsAny || [];
            const conditionMet = containsAny.length === 0 || containsAny.some(function (needle) {
                return needle && removedPart.indexOf(needle) !== -1;
            });
            if (conditionMet) {
                result = result.slice(0, idx);
                break; // first matching symbol in this row wins -- don't try this row's remaining symbols
            }
            // condition not met -- try the next symbol in this row (not a match, keep looking)
        }
    });
    return result.trim(); // final cleanup -- a cut can leave a trailing space (e.g. "kind of blue " before "(remastered)" was removed)
}

// One entry point for all three identity fields -- 'artist' always skips
// the rule table entirely (per request, the table never applies there);
// 'album'/'track' get normalizeForCacheKey then the rule table chained on
// top. Centralizing this (rather than repeating the field-gating logic at
// each of the four call sites below) means there's exactly one place that
// decides "does this field get rules", not four copies that could drift.
function normalizeIdentityField(s, field, rules) {
    const base = normalizeForCacheKey(s);
    if (field === 'artist') return base;
    return applyKeyNormalizationRules(base, field, rules);
}

// Throws if providerId is missing/unconfigured -- callers (server.js routes)
// are expected to catch and turn this into a 502, same as Discogs errors.
//
// contentField is the JSON field name (review/text/bio, one per route)
// checked on a 'whenUseful' first attempt to decide whether to escalate
// to a search-enabled retry -- see isInadequate() above.
//
// 'whenUseful' mode is a deterministic two-step here, NOT an instruction
// the model is asked to follow -- earlier attempts asking Claude/ChatGPT
// to "only search when genuinely needed" via the prompt were inconsistently
// followed in practice (observed: searching even for well-known content
// 'never' mode handled fine on its own). The first attempt now runs with
// the search tool NOT PROVIDED AT ALL (identical to 'never'), and only
// escalates to a forced search (same code path as 'always') if that first
// attempt's content field is missing, unparseable, or suspiciously short.
// Cheaper AND more reliable than the prompt-instruction approach: content
// the model already knows well never touches search at all, with no
// reliance on the model choosing correctly on its own.
//
// Also handles the "fall back to unfiltered search if empty" retry
// (applies to whichever attempt above actually searched, escalated or
// not): only triggers when a search was genuinely ATTEMPTED but came back
// with zero sources (the domain filter excluded everything relevant) --
// NOT when no search was attempted at all, which looks identical (empty
// sources) but isn't the failure case this fallback exists for. Doubles
// cost/latency for this one generation when it fires.
//
// Cached server-side (ai-cache.json, via cache.js) keyed on kind +
// normalized artist/album/track (see normalizeForCacheKey -- catches the
// "same album, slightly different capitalization/whitespace between two
// plays" case that hashing the exact prompt text missed) + every setting
// that actually changes the output: language, target length, the style
// prompt for this kind, provider, model, reasoningEffort, and web search
// settings (domain list order-independent, via .slice().sort()). This
// list is deliberately explicit rather than "hash the whole prompt" --
// past version relied on the prompt string already encoding everything,
// which was true in principle but too fragile: any incidental formatting
// difference in the assembled prompt (not just genuine content changes)
// produced a different hash and silently missed the cache. Two different
// AI agents (or the same agent before/after a settings change) still get
// separate entries, same as before, just via an explicit key instead of
// an implicit one. forceRefresh (the Refresh button's "Web" option) skips
// the cache READ but still WRITES the fresh result, replacing whatever
// was cached before.
//
// Changing this key's shape (as this update did) orphans every entry
// already in ai-cache.json -- they simply stop matching anything and sit
// unused rather than erroring, so no migration step is needed, but it
// does mean a one-time full cache reset in effect the first time this
// runs.
async function generateAIText(providerId, prompt, kind, identity, forceRefresh, forceWebSearch, promptParts) {
    const def = PROVIDER_DEFS.find(function (p) { return p.id === providerId; });
    if (!def) throw new Error('Unknown provider: ' + providerId);
    const apiKey = process.env[def.apiKeyEnv];
    if (!apiKey) throw new Error('Provider not configured: ' + providerId);
    const call = PROVIDER_CALL[def.id];
    if (!call) throw new Error('No call implementation for provider: ' + providerId);

    const kindInfo = KIND_INFO[kind] || {};

    // Cache key is ONLY kind + identity now -- deliberately NOT language,
    // length, style prompt, provider, model, reasoning effort, or web
    // search settings. Those used to all be part of the key, which meant
    // changing any of them silently triggered a real generation the next
    // time "Retrieve from cache" was used for something already cached --
    // technically correct (the old content genuinely didn't reflect the
    // new setting) but surprising, since that menu option's whole point
    // is "just retrieve, never generate." Trade-off accepted knowingly:
    // changing a setting now has NO effect on anything already cached --
    // it only takes effect for content that hasn't been generated yet, or
    // via an explicit "Generate..." refresh. This also means whichever
    // provider/model generated an item first "owns" that cache slot --
    // switching the AI Agent selection afterward shows the same cached
    // result (with its own honest Source line) until forced to regenerate,
    // not a fresh call to the newly selected provider.
    const cacheKey = cache.buildKey([
        kind,
        normalizeIdentityField(identity && identity.artist, 'artist', keyNormalizationRules),
        normalizeIdentityField(identity && identity.album, 'album', keyNormalizationRules),
        normalizeIdentityField(identity && identity.track, 'track', keyNormalizationRules)
    ]);

    // identityLog mirrors the key above -- since the key IS just kind+
    // identity now, this is only useful for spotting a genuine identity
    // difference (Roon reporting slightly different artist/album strings
    // between tracks, etc.), not settings mismatches (there are none left
    // to mismatch on).
    const identityLog = kind + '/' + normalizeIdentityField(identity && identity.artist, 'artist', keyNormalizationRules) +
        '/' + normalizeIdentityField(identity && identity.album, 'album', keyNormalizationRules) +
        '/' + normalizeIdentityField(identity && identity.track, 'track', keyNormalizationRules);

    if (!forceRefresh) {
        const cached = cache.get(cacheKey);
        if (cached) {
            console.log('[ai] cache hit -- ' + def.id + '/' + def.model + ' -- ' + identityLog);
            // fromCache is attached here, at return time, NOT stored in
            // ai-cache.json itself (cache.set below stores finalResult
            // without it) -- it describes how THIS call obtained the
            // result, not a property of the stored data.
            return Object.assign({}, cached, { fromCache: true });
        }
    }
    console.log('[ai] cache miss -- ' + def.id + '/' + def.model + (forceRefresh ? ' (forced refresh)' : '') + (forceWebSearch ? ' (forced web search)' : '') + ' -- ' + identityLog + ' -- generating...');

    // forceWebSearch (the Refresh dropdown's "Generate (at least 1 web
    // search)" option) overrides mode to 'always' for THIS call only --
    // maxUses/domain filter/fallback still come from the configured
    // webSearchConfig as normal, only 'mode' is forced, and even when the
    // global setting is 'never'. Deliberately does NOT change what goes
    // into the cache key above (still built from webSearchConfig.mode,
    // the global setting) -- the point confirmed with Enrico is that a
    // forced-search result should replace whatever's at the normal cache
    // slot for next time, not live in some separate "forced" slot.
    let options;
    if (forceWebSearch) {
        options = Object.assign({}, webSearchConfig, { mode: 'always' });
    } else {
        options = Object.assign({}, webSearchConfig, {
            mode: webSearchConfig.mode === 'whenUseful' ? 'never' : webSearchConfig.mode
        });
    }
    let result = await call(prompt, apiKey, def.model, def.reasoningEffort, options);
    // Every retry below fully REPLACES result (never merges/accumulates
    // it), so nothing survives about how many calls it took or how many
    // searches were spent across ALL of them (not just the last, visible
    // one) unless tracked separately here. totalAttempts is every call
    // made, retries included. totalSearchCount SUMS result.searchCount
    // across every one of those calls -- Enrico: "pago per tentativo e
    // per search" -- a discarded attempt's searches were still paid for,
    // even though its content never reaches the cache or the screen.
    // Both surfaced in the footnote as "Total cost: X attempts, Y
    // searches", grouped and moved to the end of the line -- separate
    // from "enriched with N searches" earlier in the same line, which
    // stays exactly what it always was: the LAST attempt's own search
    // count, describing the content actually shown, not the total spend.
    let totalAttempts = 1;
    let totalSearchCount = result.searchCount || 0;

    if (!forceWebSearch && webSearchConfig.mode === 'whenUseful' && isInadequate(result.text, kindInfo.contentField)) {
        options = Object.assign({}, webSearchConfig, { mode: 'always' });
        result = await call(prompt, apiKey, def.model, def.reasoningEffort, options);
        totalAttempts++;
        totalSearchCount += result.searchCount || 0;
    }

    const shouldRetryUnfiltered = options.mode !== 'never' &&
        webSearchConfig.useDomainFilter &&
        webSearchConfig.fallbackIfEmpty &&
        result.searchAttempted &&
        result.sources.length === 0;

    if (shouldRetryUnfiltered) {
        const unfilteredOptions = Object.assign({}, options, { useDomainFilter: false });
        result = await call(prompt, apiKey, def.model, def.reasoningEffort, unfilteredOptions);
        totalAttempts++;
        totalSearchCount += result.searchCount || 0;
    }

    const source = { provider: def.id, label: def.label, model: def.model };
    if (def.reasoningEffort) source.reasoningEffort = def.reasoningEffort;

    // Claude's web-search citations come back wrapped as
    // <cite index="2-5">...</cite> around the cited span -- meant for a
    // chat UI that renders citations specially, but this text goes
    // straight into a plain-text panel on a TV, so the raw tags would
    // otherwise show up verbatim (Enrico: literal <cite index="2-5">...
    // </cite> visible in the generated text, on a web-search-enriched
    // response). Strips just the tags, keeps the cited text itself in
    // place -- applied to the raw response BEFORE any JSON parsing below,
    // so both the ambiguity check and what ultimately gets cached/shown
    // are already clean. Only ever matters for a provider/mode that does
    // web search at all (unaffected text otherwise, nothing to strip).
    result.text = (result.text || '').replace(/<\/?cite[^>]*>/g, '');

    // Automatic retry when the model's response isn't valid JSON at all
    // (distinct from the ambiguous-response check just below, which needs
    // VALID JSON with an {ambiguous: true} shape -- this instead catches
    // genuinely broken output, e.g. a stray unescaped quote or a missing
    // brace). Previously this surfaced straight to the person as "Content
    // not available" and needed a manual Refresh, which usually succeeded
    // on the very next attempt anyway -- now that retry happens here
    // instead, silently. One retry only, same prompt/options as the last
    // attempt -- if it's STILL invalid after that, give up and let the
    // normal error path (server.js's own JSON.parse try/catch) handle it,
    // rather than retrying indefinitely.
    let parsedForAmbiguity;
    try {
        parsedForAmbiguity = JSON.parse(stripJsonFences(result.text));
    } catch (e) {
        parsedForAmbiguity = null;
    }
    if (parsedForAmbiguity === null) {
        console.log('[ai] invalid JSON response, retrying once -- ' + identityLog);
        result = await call(prompt, apiKey, def.model, def.reasoningEffort, options);
        totalAttempts++;
        totalSearchCount += result.searchCount || 0;
        result.text = (result.text || '').replace(/<\/?cite[^>]*>/g, ''); // same stripping as the first attempt above -- a retried result needs it too
        try {
            parsedForAmbiguity = JSON.parse(stripJsonFences(result.text));
        } catch (e) {
            parsedForAmbiguity = null; // still invalid after the retry -- give up, server.js's route will surface the error as before
        }
    }

    // Disambiguation check (admin's "Disambiguation during text
    // generation" checkboxes, server.js's disambiguationInstruction) --
    // only reachable when the prompt itself asked the model to consider
    // flagging ambiguity, which only happens on a FIRST request (no
    // disambiguationChoice yet) for a kind with its checkbox enabled.
    // Deliberately checked and returned BEFORE finalResult/cache.set
    // below -- an ambiguous response isn't real content, so caching it
    // would mean it gets served back verbatim on the next "Retrieve from
    // cache" instead of ever generating an actual answer. Not cached
    // means not counted as fromCache either, and nothing here touches
    // ai-cache.json at all for this call.
    if (parsedForAmbiguity && parsedForAmbiguity.ambiguous === true) {
        console.log('[ai] ambiguous response, not caching -- ' + identityLog);
        return {
            ambiguous: true,
            candidates: Array.isArray(parsedForAmbiguity.candidates) ? parsedForAmbiguity.candidates : []
        };
    }

    // prompt included here specifically so it survives into the cache
    // entry too (cache.set below stores this whole object) -- lets the
    // "show prompt used" button work identically for a fresh generation
    // and a cache hit. Entries cached before this field existed simply
    // won't have it (undefined) -- handled gracefully client-side.
    // promptBase/promptStyle stored alongside the combined prompt itself --
    // lets the client show the "Prompt used" view as base-then-style-
    // additions distinctly (see server.js's buildXPrompt functions, which
    // now return {base, style} instead of one flat string). Falls back to
    // empty strings if a caller doesn't pass promptParts (shouldn't
    // happen from server.js's three routes, but keeps this defensive).
    const finalResult = {
        text: result.text, source: source, sources: result.sources, searchCount: result.searchCount,
        totalAttempts: totalAttempts, totalSearchCount: totalSearchCount,
        prompt: prompt,
        promptBase: (promptParts && promptParts.base) || '',
        promptStyle: (promptParts && promptParts.style) || '',
        kind: kind // stored alongside the content -- lets admin's cache cleanup filter by kind without needing to decode the (one-way hashed) cache key
    };
    const stamped = cache.set(cacheKey, finalResult);
    return Object.assign({}, stamped, { fromCache: false });
}

// Writes a fixed placeholder straight to the cache, under the exact same
// key generateAIText would use for this kind+identity, with no AI call at
// all -- the Refresh dropdown's "Clear" option, for when the current text
// is nonsensical and regenerating risks producing the same nonsense again.
// source is deliberately null (not e.g. a fake "Manual" stub) so the
// client's existing "if (source) show a Source line" logic naturally
// shows no source line at all -- honest about the fact nothing actually
// generated this.
function clearToCachePlaceholder(kind, identity, message) {
    const kindInfo = KIND_INFO[kind] || {};
    const cacheKey = cache.buildKey([
        kind,
        normalizeIdentityField(identity && identity.artist, 'artist', keyNormalizationRules),
        normalizeIdentityField(identity && identity.album, 'album', keyNormalizationRules),
        normalizeIdentityField(identity && identity.track, 'track', keyNormalizationRules)
    ]);
    const placeholderJson = {};
    if (kindInfo.contentField) placeholderJson[kindInfo.contentField] = message;
    const finalResult = {
        text: JSON.stringify(placeholderJson),
        source: null,
        sources: [],
        searchCount: 0,
        totalAttempts: 0, totalSearchCount: 0, // no real call was ever made for a manually-cleared placeholder
        prompt: '',
        promptBase: '',
        promptStyle: '',
        kind: kind
    };
    const stamped = cache.set(cacheKey, finalResult);
    console.log('[ai] cleared to placeholder -- ' + kind + '/' +
        normalizeIdentityField(identity && identity.artist, 'artist', keyNormalizationRules) + '/' +
        normalizeIdentityField(identity && identity.album, 'album', keyNormalizationRules) + '/' +
        normalizeIdentityField(identity && identity.track, 'track', keyNormalizationRules));
    return Object.assign({}, stamped, { fromCache: false });
}

module.exports = {
    getAvailableProviders: getAvailableProviders,
    getDefaultProviderId: getDefaultProviderId,
    generateAIText: generateAIText,
    clearToCachePlaceholder: clearToCachePlaceholder,
    stripJsonFences: stripJsonFences,
    // Exposed for server.js (prompt language/length) and admin.js (reading
    // current values to populate the form, and as the shape to validate a
    // new config.json against before writing it).
    getAppConfig: function () { return appConfig; },
    CONFIG_PATH: CONFIG_PATH
};
