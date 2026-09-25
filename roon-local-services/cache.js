// Server-side cache for AI-generated text (review/composition/artist bio),
// so listening to the same album again later -- across proxy restarts,
// Roon updates, TV reloads -- doesn't re-pay for a fresh generation.
// Plain JSON file, no database, consistent with the rest of this project.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_PATH = path.join(__dirname, 'ai-cache.json');

// Read-modify-write on every call rather than an in-memory copy kept in
// sync -- simpler, and at personal-music-library scale (hundreds to a
// few thousand entries) the JSON parse/stringify cost is trivial. If this
// ever needs to scale further, that's the first thing to change.
function loadCache() {
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (err) {
        return {}; // missing file (first run) or corrupt -- start fresh rather than crashing the whole proxy over a cache file
    }
}

function saveCache(cache) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// parts.join with a NUL separator (never appears in normal text) instead
// of e.g. '::' -- avoids two different inputs accidentally hashing the
// same if a part happens to contain the literal separator string.
function buildKey(parts) {
    return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

function get(key) {
    const cache = loadCache();
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
}

// createdAt is stamped here, unconditionally, on every write -- not left
// to callers to remember -- so it's never possible to end up with a
// cache.set() call that forgets it. Overwritten (not preserved) on every
// write to the same key, including a regeneration: the timestamp
// describes when THIS content was created, and a regenerated entry is
// genuinely new content replacing the old. Returns the stamped value (not
// just void) so a caller that wants to report createdAt back to its own
// caller (ai.js, for the "generated on" footnote) doesn't have to
// duplicate Date.now() separately and risk a few-millisecond mismatch
// between what's stored and what's reported.
function set(key, value) {
    const cache = loadCache();
    const stamped = Object.assign({}, value, { createdAt: Date.now() });
    cache[key] = stamped;
    saveCache(cache);
    return stamped;
}

function clearAll() {
    saveCache({});
}

// Deletes entries matching BOTH kindFilter and dateFilter, keeps the
// rest. kindFilter is 'all' or a specific kind ('review'/'composition'/
// 'artist') -- matched against each entry's own stored `kind` (added
// alongside createdAt, see ai.js's generateAIText/clearToCachePlaceholder).
// dateFilter is { mode: 'any' | 'on' | 'before' | 'range', date, startDate,
// endDate } -- date strings are 'YYYY-MM-DD' (from an HTML date input),
// interpreted as whole local-time days. An entry with no createdAt at all
// (from before this feature existed) is EXCLUDED from every mode except
// 'any' -- we genuinely don't know its age, so a specific-date filter
// should never touch it (Enrico, explicit choice).
function clearFiltered(kindFilter, dateFilter) {
    const cache = loadCache();
    const df = dateFilter || { mode: 'any' };

    function dayBounds(dateStr) {
        const start = new Date(dateStr + 'T00:00:00');
        const end = new Date(dateStr + 'T23:59:59.999');
        return { start: start.getTime(), end: end.getTime() };
    }

    function matchesDate(createdAt) {
        if (df.mode === 'any') return true;
        if (!createdAt) return false; // no timestamp -- never matched by a specific-date filter
        if (df.mode === 'on') {
            const b = dayBounds(df.date);
            return createdAt >= b.start && createdAt <= b.end;
        }
        if (df.mode === 'before') {
            const b = dayBounds(df.date);
            return createdAt <= b.end;
        }
        if (df.mode === 'range') {
            const startB = dayBounds(df.startDate);
            const endB = dayBounds(df.endDate);
            return createdAt >= startB.start && createdAt <= endB.end;
        }
        return false;
    }

    let deletedCount = 0;
    Object.keys(cache).forEach(function (key) {
        const entry = cache[key];
        const kindMatches = kindFilter === 'all' || entry.kind === kindFilter;
        if (kindMatches && matchesDate(entry.createdAt)) {
            delete cache[key];
            deletedCount++;
        }
    });
    saveCache(cache);
    return { deletedCount: deletedCount, remainingCount: Object.keys(cache).length };
}

function count() {
    return Object.keys(loadCache()).length;
}

// For export -- the raw stored shape (no fromCache field, see ai.js's own
// comment on why that's attached only at return time, never persisted).
function getAll() {
    return loadCache();
}

// For import -- merges by key (added/updated entries win, anything
// already cached under a key NOT in `entries` is left untouched). Returns
// how many keys were actually written, for the caller to report back.
function merge(entries) {
    const cache = loadCache();
    const keys = Object.keys(entries || {});
    keys.forEach(function (key) {
        cache[key] = entries[key];
    });
    saveCache(cache);
    return keys.length;
}

module.exports = {
    buildKey: buildKey,
    get: get,
    set: set,
    clearAll: clearAll,
    clearFiltered: clearFiltered,
    count: count,
    getAll: getAll,
    merge: merge
};
