// Local Discogs + AI proxy: replaces the Cloudflare Worker (discogs-proxy-worker.js)
// and adds AI-generated album review / composition info (Claude, ChatGPT).
// Same Discogs routes/response shape as before -- display_ui.html only
// needs discogsProxyUrl repointed here, no change to fuzzy-matching logic.
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // global fetch needs Node 18+; this works on Node 16 too
const ai = require('./ai');
const appConfig = ai.getAppConfig(); // aiLanguage/textLengthWords used by the three prompt builders below
const admin = require('./admin');
const guardian = require('./guardian');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const USER_AGENT = 'RoonDisplayAlbumInfo/1.0';
const DISCOGS_BASE = 'https://api.discogs.com';
const UPSTREAM_TIMEOUT_MS = 8000;

const EXPOSED_HEADERS = [
    'Retry-After',
    'X-Discogs-Ratelimit',
    'X-Discogs-Ratelimit-Used',
    'X-Discogs-Ratelimit-Remaining'
];

if (!DISCOGS_TOKEN) {
    console.warn('DISCOGS_TOKEN missing from .env -- /search and /release/:id will return 503 until it\'s set (e.g. from the admin panel\'s API Keys tab).');
}

if (ai.getAvailableProviders().length === 0) {
    console.warn('[ai] No AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY both missing) -- /ai/* routes will return 503.');
}

app.use(cors({
    origin: ALLOWED_ORIGIN,
    exposedHeaders: EXPOSED_HEADERS
}));

// ---------------------------------------------------------------------------
// Discogs routes (unchanged)
// ---------------------------------------------------------------------------

// Mirrors fetchWithTimeout() in display_ui.html: fails fast instead of
// hanging, so a stalled upstream request never looks like a frozen proxy.
function fetchDiscogs(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, UPSTREAM_TIMEOUT_MS);
    return fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Authorization': 'Discogs token=' + DISCOGS_TOKEN
        },
        signal: controller.signal
    }).finally(function () { clearTimeout(timer); });
}

// Passes through the real quota/backoff signals Discogs sent us, so
// logDiscogsRatelimit()/applyDiscogsBackoff() in display_ui.html keep
// working exactly as they did against the Worker.
function forwardDiscogsHeaders(discogsRes, res) {
    EXPOSED_HEADERS.forEach(function (h) {
        const v = discogsRes.headers.get(h);
        if (v) res.set(h, v);
    });
}

async function proxyToDiscogs(url, res, label) {
    try {
        const discogsRes = await fetchDiscogs(url);
        forwardDiscogsHeaders(discogsRes, res);
        const body = await discogsRes.json();
        res.status(discogsRes.status).json(body);
    } catch (err) {
        const isTimeout = err && err.name === 'AbortError';
        console.error('[discogs proxy] ' + label + ' failed:', isTimeout ? 'timeout' : (err && err.message));
        res.status(502).json({ error: isTimeout ? 'upstream timeout' : 'upstream request failed' });
    }
}

// GET /search?q=...  ->  Discogs /database/search?type=release&q=...
app.get('/search', function (req, res) {
    if (!DISCOGS_TOKEN) return res.status(503).json({ error: 'DISCOGS_TOKEN not configured' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'missing q' });
    const url = DISCOGS_BASE + '/database/search?type=release&q=' + encodeURIComponent(q);
    proxyToDiscogs(url, res, '/search');
});

// GET /release/:id  ->  Discogs /releases/:id
app.get('/release/:id', function (req, res) {
    if (!DISCOGS_TOKEN) return res.status(503).json({ error: 'DISCOGS_TOKEN not configured' });
    const url = DISCOGS_BASE + '/releases/' + encodeURIComponent(req.params.id);
    proxyToDiscogs(url, res, '/release/' + req.params.id);
});

// ---------------------------------------------------------------------------
// AI routes (review + composition)
// ---------------------------------------------------------------------------

// Strips markdown code fences some models wrap JSON in, despite instructions not to.
// stripJsonFences moved to ai.js (generateAIText needs it too now, to
// check for an ambiguous-response shape before caching) -- use
// ai.stripJsonFences instead of a second local copy here.

// Style prompts (config.json's stylePrompts.{album,composition,artist}) are
// optional and blank by default -- blank means the existing neutral
// behavior, unchanged. The person writing a style prompt can use any
// language they like; the OUTPUT language is still forced to
// appConfig.aiLanguage regardless, so the two are told apart explicitly
// here rather than trusting the model to infer it.
// Refresh dropdown's "Clear" option -- for when the current text is
// nonsensical and regenerating risks producing the same nonsense again.
// One shared message across all three kinds, kept short and neutral since
// it's shown directly in place of the actual review/bio/composition text.
const CLEARED_PLACEHOLDER_MESSAGE = 'Could not generate a meaningful summary for this.';

// One shared CRITICAL line, appended in all three prompt builders
// alongside the existing JSON-formatting CRITICAL instructions --
// accents/diacritics were previously only implied by "in [language]",
// with nothing telling the model they matter, easy to lose among all the
// OTHER formatting constraints (strict JSON shape, no double quotes, no
// raw line breaks, exact word count, disambiguation instructions...).
// Explicitly calls out ordinary grammatical apostrophes (contractions/
// elisions) too, and explicitly separates them from the single-quote-
// for-titles rule below -- a plain apostrophe inside a word is always
// perfectly safe in a JSON string (only " and \ actually need escaping),
// but the model dropping/avoiding them anyway, as if being overly
// cautious about the OTHER rule, is exactly the failure mode reported
// (Enrico: "mancano accenti e apostrofi").
function accentInstruction() {
    return ' CRITICAL: write in ' + appConfig.aiLanguage + ' using its correct accents, diacritics, and standard spelling in full -- never drop, simplify, or omit any accent mark or grammatically necessary apostrophe (e.g. Italian elisions like "l\'amore" or "c\'è" are entirely normal and safe inside a JSON string value, and must be kept exactly as they would be written normally -- this is unrelated to the single-quote-for-quoting-a-title rule elsewhere in these instructions, which only concerns quotation marks around a title, not everyday apostrophes).';
}

function styleInstruction(kind) {
    const stylePrompt = appConfig.stylePrompts && appConfig.stylePrompts[kind];
    if (!stylePrompt || !stylePrompt.trim()) return '';
    // Swap any double quotes for single ones -- this is prose embedded in
    // the instruction text (not a JSON value itself), but keeping it
    // quote-clean avoids visually confusing the model about where the
    // quoted guidance ends.
    const safeStylePrompt = stylePrompt.trim().replace(/"/g, "'");
    return ' Also follow this style guidance from the user as closely as you can (it may be written in any language -- interpret it, but your output text must still be entirely in ' + appConfig.aiLanguage + '): "' + safeStylePrompt + '".';
}

// Admin's "Disambiguation during text generation" checkboxes (config.json's
// disambiguation.{artist,album,composition}). Three distinct outcomes:
//   - disambiguationChoice is a real string: the user already picked one
//     of the proposed candidates on a prior request for this same item --
//     tell the model definitively which one, generate for real, and don't
//     ask again.
//   - disambiguationChoice === 'NONE': the user rejected every candidate
//     that was proposed -- force a real best-guess answer instead of
//     asking again (an infinite ambiguous loop would otherwise be
//     possible if the model just proposes the same candidates again).
//   - disambiguationChoice absent AND the checkbox is enabled for this
//     kind: this is potentially a FIRST request for this item -- ask the
//     model to flag genuine ambiguity instead of guessing silently.
//   - disambiguationChoice absent AND the checkbox is OFF: no instruction
//     at all, identical to before this feature existed.
// nounPhrase is just for natural-sounding prose ("album" / "track/song" /
// "artist or band") -- matches the vocabulary each prompt already uses.
function disambiguationInstruction(kind, nounPhrase, disambiguationChoice) {
    if (disambiguationChoice === 'NONE') {
        return ' None of the proposed candidates matched what the user meant -- just give your best single answer for the most well-known or likely ' + nounPhrase + ', do not ask for disambiguation again.';
    }
    if (disambiguationChoice) {
        return ' The user has confirmed this refers to: "' + disambiguationChoice + '". Generate the content specifically for that one, do not ask for disambiguation again.';
    }
    if (!appConfig.disambiguation || !appConfig.disambiguation[kind]) return '';
    return ' Before answering, consider whether this could plausibly refer to more than one genuinely different, unrelated ' + nounPhrase + ' -- not different reissues or minor variations of the same one, but truly distinct works or people that happen to share this exact name. If so, and you are not reasonably confident which one is meant, reply with ONLY this JSON shape instead of the normal one: {"ambiguous": true, "candidates": ["short distinguishing description of option 1", "short distinguishing description of option 2", "..."]} -- at most 4 candidates, each a brief phrase that helps tell them apart (era, genre, notable performer, etc.). Only do this when there is genuine, meaningful ambiguity -- most requests have one clear, well-known referent and should be answered normally.';
}

function buildReviewPrompt(artist, album, year, genre, disambiguationChoice) {
    let ctx = '"' + album + '" by ' + artist;
    if (year) ctx += ' (' + year + ')';
    if (genre) ctx += ', genre ' + genre;
    const base = 'Write a critical review of the RECORDING of the album ' + ctx +
        ' -- focus on the performances, sound/production, personnel, and its impact or reception. ' +
        'Do NOT analyze the compositional structure, harmony, or songwriting technique of the music itself (that is covered elsewhere). ' +
        'Reply with ONLY a valid JSON object, no markdown and no text outside the JSON, with this exact structure: ' +
        '{"year": "...", "style": "...", "review": "..."}. "year" is the album\'s original release year. ' +
        '"style" is a short genre/style description (a few words). ' +
        '"review" should be about ' + appConfig.textLengthWords + ' words, in ' + appConfig.aiLanguage + ', music journalism style, no titles or preamble. ' +
        'Split it into 2-3 paragraphs rather than one dense block, using \\n\\n between them. ' +
        'CRITICAL: inside the JSON string values, never use literal double-quote characters -- if you need to quote a song or album title within the text, use single quotes instead (e.g. \'So What\'), never ". ' +
        'CRITICAL: if you use paragraph breaks, use the JSON escape sequence \\n (backslash-n), never a literal raw line break -- a raw line break inside a JSON string is invalid and will break parsing. ' +
        'If a value cannot be determined, use an empty string for that field.' +
        accentInstruction() +
        disambiguationInstruction('album', 'album', disambiguationChoice);
    return { base: base, style: styleInstruction('album') };
}

function buildCompositionPrompt(track, artist, disambiguationChoice) {
    // Deliberately just the track title in the cache KEY -- no artist,
    // album, year, or genre. This is cached (see ai.js/generateAIText's
    // identity param) keyed on track title ALONE, precisely so the same
    // composition heard on two different albums/performers shares one
    // cache entry instead of regenerating per-recording (Enrico: "non mi
    // interessa l'interpretazione specifica ma la composizione").
    // Feeding a specific artist/album/year into the prompt AS THE SUBJECT
    // would have made the generated text describe THAT particular
    // recording, which would then get shown verbatim under a completely
    // different artist's album the next time the same title comes up --
    // a real mismatch. The artist tag IS passed into the prompt below
    // now, though, as an IDENTIFICATION HINT only (never into the cache
    // key) -- a generic track title shared by multiple unrelated songs
    // otherwise has nothing to disambiguate it (real example: "Escuta",
    // tagged with performers Ney Matogrosso e Ivon Curi in Roon, should
    // point the model at Ivon Curi's 1955 "Escuta" specifically, not some
    // other unrelated song of the same name -- previously this context
    // existed in the request but was silently unused). Always included
    // when available, independent of the "Disambiguation during text
    // generation" checkbox for Composition (Enrico: "sempre usato"),
    // which separately controls whether the model is ALSO asked to flag
    // remaining ambiguity when even this hint doesn't resolve it.
    const base = 'Describe the COMPOSITIONAL characteristics of the track/song titled "' + track + '" -- ' +
        'the musical structure and form, harmonic/melodic approach, compositional technique or innovations, ' +
        'and how the material was written or conceived. ' +
        (artist ? 'For IDENTIFICATION purposes only, Roon tags this track with performing artist(s) "' + artist + '" -- use this only to help determine which specific composition is meant if the title could refer to more than one; do NOT write about this performer or this specific recording, only about the composition itself, independent of any performance of it. ' : '') +
        'Do NOT review any particular recording, performance, personnel, sound/production quality, or critical reception (that is covered elsewhere) -- this is about the composition itself, independent of any specific performance of it. ' +
        'Reply with ONLY a valid JSON object, no markdown and no text outside the JSON, with this exact structure: ' +
        '{"composer": "...", "year": "...", "style": "...", "text": "..."}. ' +
        '"text" should be a paragraph of about ' + appConfig.textLengthWords + ' words, in ' + appConfig.aiLanguage + ', giving historical/musicological context about the composition itself. ' +
        'Split it into 2-3 paragraphs rather than one dense block, using \\n\\n between them. ' +
        'CRITICAL: inside the JSON string values, never use literal double-quote characters -- if you need to quote a song or album title within the text, use single quotes instead (e.g. \'So What\'), never ". ' +
        'CRITICAL: if you use paragraph breaks, use the JSON escape sequence \\n (backslash-n), never a literal raw line break -- a raw line break inside a JSON string is invalid and will break parsing. ' +
        'If a value cannot be determined, use an empty string for that field.' +
        accentInstruction() +
        disambiguationInstruction('composition', 'track/song', disambiguationChoice);
    return { base: base, style: styleInstruction('composition') };
}

function buildArtistPrompt(artistName, disambiguationChoice) {
    const base = 'Provide information about the artist "' + artistName + '" (a musician, band, or performing act). ' +
        'Reply with ONLY a valid JSON object, no markdown and no text outside the JSON, with this exact structure: ' +
        '{"active": "...", "country": "...", "bio": "..."}. ' +
        '"active" is the artist\'s life span if this is a solo performer (e.g. "1926-1991" or "born 1942"), ' +
        'or the group\'s formation/dissolution span if this is a band (e.g. "formed 1959" or "1959-1969"). ' +
        '"country" is the artist\'s (or band\'s) country of origin. ' +
        '"bio" should be about ' + appConfig.textLengthWords + ' words, in ' + appConfig.aiLanguage + ', biographical, no titles or preamble. ' +
        'Split it into 2-3 paragraphs rather than one dense block, using \\n\\n between them. ' +
        'CRITICAL: inside the JSON string values, never use literal double-quote characters -- if you need to quote a song or album title within the text, use single quotes instead (e.g. \'So What\'), never ". ' +
        'CRITICAL: if you use paragraph breaks, use the JSON escape sequence \\n (backslash-n), never a literal raw line break -- a raw line break inside a JSON string is invalid and will break parsing. ' +
        'If a value cannot be determined, use an empty string for that field.' +
        accentInstruction() +
        disambiguationInstruction('artist', 'artist or band', disambiguationChoice);
    return { base: base, style: styleInstruction('artist') };
}

// GET /ai/providers -> list of configured providers, in .env declaration order.
// Client builds the dropdown from this and treats index 0 as the default.
app.get('/ai/providers', function (req, res) {
    res.json({ providers: ai.getAvailableProviders() });
});

// POST /debug-log -> relays a debug message from the TV/display side into
// this proxy's own console output (proxy.log via launchd), since there's
// no practical way to open a browser console on the actual TV device.
// Deliberately NOT behind basicAuth -- the display itself calls this, not
// the admin panel, and it has no admin credentials to send. Only fires at
// all when DisplayConfig.debugLogging.toTerminal is on (off by default),
// see display_ui.html's remoteDebugLog(). Fire-and-forget on the client
// side, so this always responds quickly and never throws.
app.post('/debug-log', function (req, res) {
    const message = (req.body || {}).message;
    console.log('[display] ' + (typeof message === 'string' ? message : JSON.stringify(message)));
    res.json({ ok: true });
});

app.post('/ai/review', async function (req, res) {
    const body = req.body || {};
    const artist = body.artist;
    const album = body.album;
    if (!artist || !album) return res.status(400).json({ error: 'missing artist/album' });

    if (body.clear) {
        const result = ai.clearToCachePlaceholder('review', { artist: artist, album: album }, CLEARED_PLACEHOLDER_MESSAGE);
        return res.json({
            year: '', style: '', review: CLEARED_PLACEHOLDER_MESSAGE,
            source: result.source, sources: result.sources, searchCount: result.searchCount,
            fromCache: !!result.fromCache, promptBase: result.promptBase, promptStyle: result.promptStyle, createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    }

    const providerId = body.provider || ai.getDefaultProviderId();
    if (!providerId) return res.status(503).json({ error: 'no AI provider configured' });

    try {
        const promptParts = buildReviewPrompt(artist, album, body.year, body.genre, body.disambiguationChoice);
        const prompt = promptParts.base + (promptParts.style ? ' ' + promptParts.style : '');
        const result = await ai.generateAIText(providerId, prompt, 'review', { artist: artist, album: album }, !!body.forceRefresh, !!body.forceWebSearch, promptParts);
        // Not cached (see generateAIText's own comment) -- respond with
        // the candidates immediately, before attempting to parse .text
        // (an ambiguous result has no .text at all, just .candidates).
        if (result.ambiguous) {
            return res.json({ ambiguous: true, candidates: result.candidates });
        }
        let parsed;
        try {
            parsed = JSON.parse(ai.stripJsonFences(result.text));
        } catch (parseErr) {
            console.error('[ai] /ai/review: model did not return valid JSON:', result.text);
            return res.status(502).json({ error: 'AI response was not valid JSON' });
        }
        res.json({
            year: parsed.year || '',
            style: parsed.style || '',
            review: (parsed.review || '').trim(),
            source: result.source,
            sources: result.sources || [],
            searchCount: result.searchCount || 0,
            fromCache: !!result.fromCache,
            promptBase: result.promptBase || '',
            promptStyle: result.promptStyle || '',
            createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    } catch (err) {
        const isTimeout = err && err.name === 'AbortError';
        console.error('[ai] /ai/review failed:', isTimeout ? 'timeout' : (err && err.message));
        res.status(502).json({ error: isTimeout ? 'upstream timeout' : 'upstream request failed' });
    }
});

app.post('/ai/composition', async function (req, res) {
    const body = req.body || {};
    const track = body.track;
    // artist is used now, but only as an identification hint inside the
    // prompt (see buildCompositionPrompt's own comment) -- never part of
    // the cache key or a requirement to proceed, composition is still
    // cached purely by track title.
    const artist = body.artist;
    if (!track) return res.status(400).json({ error: 'missing track' });

    if (body.clear) {
        const result = ai.clearToCachePlaceholder('composition', { track: track }, CLEARED_PLACEHOLDER_MESSAGE);
        return res.json({
            composer: '', year: '', style: '', text: CLEARED_PLACEHOLDER_MESSAGE,
            source: result.source, sources: result.sources, searchCount: result.searchCount,
            fromCache: !!result.fromCache, promptBase: result.promptBase, promptStyle: result.promptStyle, createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    }

    const providerId = body.provider || ai.getDefaultProviderId();
    if (!providerId) return res.status(503).json({ error: 'no AI provider configured' });

    try {
        const promptParts = buildCompositionPrompt(track, artist, body.disambiguationChoice);
        const prompt = promptParts.base + (promptParts.style ? ' ' + promptParts.style : '');
        const result = await ai.generateAIText(providerId, prompt, 'composition', { track: track }, !!body.forceRefresh, !!body.forceWebSearch, promptParts);
        if (result.ambiguous) {
            return res.json({ ambiguous: true, candidates: result.candidates });
        }
        let parsed;
        try {
            parsed = JSON.parse(ai.stripJsonFences(result.text));
        } catch (parseErr) {
            console.error('[ai] /ai/composition: model did not return valid JSON:', result.text);
            return res.status(502).json({ error: 'AI response was not valid JSON' });
        }
        res.json({
            composer: parsed.composer || '',
            year: parsed.year || '',
            style: parsed.style || '',
            text: parsed.text || '',
            source: result.source,
            sources: result.sources || [],
            searchCount: result.searchCount || 0,
            fromCache: !!result.fromCache,
            promptBase: result.promptBase || '',
            promptStyle: result.promptStyle || '',
            createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    } catch (err) {
        const isTimeout = err && err.name === 'AbortError';
        console.error('[ai] /ai/composition failed:', isTimeout ? 'timeout' : (err && err.message));
        res.status(502).json({ error: isTimeout ? 'upstream timeout' : 'upstream request failed' });
    }
});

app.post('/ai/artist', async function (req, res) {
    const body = req.body || {};
    const artistName = body.artist;
    if (!artistName) return res.status(400).json({ error: 'missing artist' });

    if (body.clear) {
        const result = ai.clearToCachePlaceholder('artist', { artist: artistName }, CLEARED_PLACEHOLDER_MESSAGE);
        return res.json({
            active: '', country: '', bio: CLEARED_PLACEHOLDER_MESSAGE,
            source: result.source, sources: result.sources, searchCount: result.searchCount,
            fromCache: !!result.fromCache, promptBase: result.promptBase, promptStyle: result.promptStyle, createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    }

    const providerId = body.provider || ai.getDefaultProviderId();
    if (!providerId) return res.status(503).json({ error: 'no AI provider configured' });

    try {
        const promptParts = buildArtistPrompt(artistName, body.disambiguationChoice);
        const prompt = promptParts.base + (promptParts.style ? ' ' + promptParts.style : '');
        const result = await ai.generateAIText(providerId, prompt, 'artist', { artist: artistName }, !!body.forceRefresh, !!body.forceWebSearch, promptParts);
        if (result.ambiguous) {
            return res.json({ ambiguous: true, candidates: result.candidates });
        }
        let parsed;
        try {
            parsed = JSON.parse(ai.stripJsonFences(result.text));
        } catch (parseErr) {
            console.error('[ai] /ai/artist: model did not return valid JSON:', result.text);
            return res.status(502).json({ error: 'AI response was not valid JSON' });
        }
        res.json({
            active: parsed.active || '',
            country: parsed.country || '',
            bio: (parsed.bio || '').trim(),
            source: result.source,
            sources: result.sources || [],
            searchCount: result.searchCount || 0,
            fromCache: !!result.fromCache,
            promptBase: result.promptBase || '',
            promptStyle: result.promptStyle || '',
            createdAt: result.createdAt || null, totalAttempts: result.totalAttempts != null ? result.totalAttempts : 1, totalSearchCount: result.totalSearchCount || 0
        });
    } catch (err) {
        const isTimeout = err && err.name === 'AbortError';
        console.error('[ai] /ai/artist failed:', isTimeout ? 'timeout' : (err && err.message));
        res.status(502).json({ error: isTimeout ? 'upstream timeout' : 'upstream request failed' });
    }
});

admin.registerAdminRoutes(app);

app.listen(PORT, function () {
    console.log('Discogs + AI proxy listening on port ' + PORT);
    const providers = ai.getAvailableProviders();
    console.log('[ai] configured providers: ' + (providers.length ? providers.map(function (p) { return p.id; }).join(', ') : 'none'));
    console.log('[admin] panel enabled at /config' + (process.env.ADMIN_PASSWORD ? '' : ' (using default password "admin" -- change it on first login)'));
    guardian.start(); // watches display_ui.html/js, auto-restores them if a Roon update wipes out our customizations -- see guardian.js
    console.log('[guardian] watching display_ui.html/js for Roon updates (checks every 60s)');
});
