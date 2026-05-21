/**
 * Anonymization pipeline — Phase 3
 *
 * Layered detection:
 *   1. Emails, phone numbers, URLs, social handles  (regex — highest precision)
 *   2. compromise.js NER  (PERSON, PLACE, ORG)
 *   3. Custom entities from identity_facts  (DB-backed, cached 5 min)
 *   4. CamelCase/PascalCase proper nouns  (heuristic for product/project names)
 *
 * Token map lives in process memory only — never persisted.
 */
import nlp from 'compromise';
// ── Allowlist — well-known tech names that don't reveal user identity ─────────
const TECH_ALLOWLIST = new Set([
    // Languages
    'TypeScript', 'JavaScript', 'Python', 'Swift', 'Kotlin', 'Rust', 'Go', 'Java', 'Ruby',
    'Bash', 'Shell', 'SQL', 'HTML', 'CSS', 'JSON', 'YAML', 'Markdown',
    // Frameworks / tools
    'GitHub', 'Docker', 'Postgres', 'PostgreSQL', 'Redis', 'MongoDB', 'MySQL',
    'React', 'NextJS', 'Node', 'NodeJS', 'Vite', 'Webpack', 'Tailwind', 'Parcel',
    'Xcode', 'VSCode', 'Homebrew', 'Nix',
    // Platforms / OS
    'iOS', 'macOS', 'Ubuntu', 'Linux', 'Android', 'Windows', 'Sonoma', 'Sequoia',
    'MacBook', 'iPhone', 'iPad', 'AppleWatch', 'Silicon', 'Intel',
    // Common cloud/SaaS that everyone uses (don't reveal user-specific affiliation)
    'Apple', 'Google', 'Microsoft', 'Amazon', 'Meta', 'Netflix', 'Spotify',
    'Dropbox', 'iCloud', 'Drive', 'Gmail',
    'Discord', 'Slack', 'Notion', 'Obsidian', 'Jira', 'Linear',
    'YouTube', 'LinkedIn', 'Twitter', 'Reddit',
    // AI tools (generic)
    'Claude', 'ChatGPT', 'Copilot', 'Cursor', 'Gemini', 'OpenAI', 'Anthropic',
    'Ollama', 'LLMs', 'Llama', 'Sonnet', 'Haiku',
    // Protocols / acronyms
    'MCP', 'RRF', 'NER', 'HNSW', 'GIN', 'SSO', 'APIs', 'WiFi', 'VPN', 'VPNs',
    'IPsec', 'EMEA', 'APAC', 'HVAC',
    // Generic product nouns / roles that appear mid-sentence
    'Director', 'Manager', 'Engineer', 'Product', 'Corporate', 'Strategy',
    'Management', 'Marketing', 'Design', 'Finance', 'Operations',
    'FinTech', 'SaaS', 'PaaS', 'IaaS', 'B2B', 'B2C', 'API',
    // Common CLI commands (extracted from backticks in identity_facts)
    'ssh', 'curl', 'node', 'grep', 'tail', 'kill', 'launchctl', 'brew', 'git', 'npm',
    'ping', 'cat', 'ls', 'rm', 'cp', 'mv', 'sudo', 'chmod', 'chown',
    // Hardware identifiers
    'MBP', 'M1', 'M2', 'M3', 'M4',
    // Time
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'January', 'February', 'March', 'April', 'June', 'July', 'August',
    'September', 'October', 'November', 'December',
    // Common English words that get capitalised mid-sentence
    'English', 'Weather', 'Storm', 'Phase', 'Code', 'Push', 'Hand', 'Chip',
    'Store', 'Cloud', 'Vault', 'Volumes', 'Library', 'Logs', 'Users',
    'Maine', 'Coon', 'Ford', 'Sync', 'Drive', 'Finder', 'Bonjour',
]);
let _customEntityCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Extract entities from pre-fetched identity fact rows (used by StorageAdapter path) */
export function extractEntitiesFromFacts(rows) {
    const entities = [];
    const seen = new Set();
    for (const row of rows) {
        // 1. Backtick-quoted terms: `Threadline`, `OpenClaw`, `sci`
        // Skip: all-lowercase (CLI commands), common tools, path segments
        const backtick = row.content.match(/`([A-Za-z][a-zA-Z0-9._@/-]{2,})`/g) ?? [];
        backtick.forEach(q => {
            const raw = q.replace(/`/g, '');
            // Take first path segment, strip leading @ for scoped packages
            const term = raw.split('/')[0].replace(/^@/, '').replace(/^sci$/, ''); // skip 'sci' itself
            // Skip if all-lowercase (CLI command, variable, package) or too short or allowlisted
            if (term.length < 4 ||
                term === term.toLowerCase() || // all lowercase = CLI/variable
                TECH_ALLOWLIST.has(term) ||
                seen.has(term.toLowerCase()))
                return;
            seen.add(term.toLowerCase());
            entities.push({ text: term, type: 'PROJECT' });
        });
        // 2. Single/double-quoted proper nouns — max 2 words, must start with capital
        // Catches: 'Sci', 'Threadline', 'Serious Hobbyist'
        // Skips: 'SSO for AI', 'ATC for their AI soul', 'Push to Jira' (too many words / generic)
        const quoted = row.content.match(/['"]([A-Z][a-zA-Z0-9 ._-]{2,})['"]/g) ?? [];
        quoted.forEach(q => {
            const term = q.replace(/['"]/g, '').trim();
            const wordCount = term.split(' ').length;
            if (wordCount > 2 || // skip long phrases
                TECH_ALLOWLIST.has(term) ||
                seen.has(term.toLowerCase()))
                return;
            seen.add(term.toLowerCase());
            entities.push({ text: term, type: row.category === 'project' ? 'PROJECT' : 'ORG' });
        });
        // 3. TRUE compound CamelCase only (internal capital required)
        // Catches: OpenClaw, CrossTimbersFarm, ChaseArchive, BlueBubbles, ElevenLabs
        // Does NOT catch: Threadline, Obsidian (single-case — those come from quotes above)
        const camel = row.content.match(/\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b/g) ?? [];
        camel.forEach(term => {
            if (!TECH_ALLOWLIST.has(term) && !seen.has(term.toLowerCase())) {
                seen.add(term.toLowerCase());
                entities.push({ text: term, type: row.category === 'project' ? 'PROJECT' : 'ORG' });
            }
        });
        // 4. Emails in content
        const emails = row.content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? [];
        emails.forEach(e => {
            if (!seen.has(e.toLowerCase())) {
                seen.add(e.toLowerCase());
                entities.push({ text: e, type: 'EMAIL' });
            }
        });
    }
    return entities;
}
export async function loadCustomEntities(reader) {
    const now = Date.now();
    if (_customEntityCache && now - _customEntityCache.loadedAt < CACHE_TTL_MS) {
        return _customEntityCache.entities;
    }
    const { rows } = await reader.query(`SELECT content, category FROM identity_facts
     WHERE category IN ('project', 'context', 'skill', 'relationship')
     ORDER BY confidence DESC`);
    const entities = extractEntitiesFromFacts(rows);
    _customEntityCache = { entities, loadedAt: now };
    return entities;
}
/** Load custom entities via StorageAdapter (works with any backend) */
export async function loadCustomEntitiesFromAdapter(adapter) {
    const now = Date.now();
    if (_customEntityCache && now - _customEntityCache.loadedAt < CACHE_TTL_MS) {
        return _customEntityCache.entities;
    }
    const facts = await adapter.queryIdentityFacts({ limit: 500 });
    const rows = facts
        .filter(f => ['project', 'context', 'skill', 'relationship'].includes(f.category ?? ''))
        .map(f => ({ content: f.content, category: f.category ?? 'context' }));
    const entities = extractEntitiesFromFacts(rows);
    _customEntityCache = { entities, loadedAt: now };
    return entities;
}
export function invalidateCustomEntityCache() {
    _customEntityCache = null;
}
// ── NER passes ────────────────────────────────────────────────────────────────
function extractRegexEntities(text) {
    const entities = [];
    const seen = new Set();
    // Track which character positions are already consumed by a match
    const consumed = new Set();
    const add = (t, type, idx) => {
        const n = t.trim();
        if (n.length < 3 || seen.has(n.toLowerCase()))
            return;
        seen.add(n.toLowerCase());
        entities.push({ text: n, type });
        // Mark consumed positions to prevent sub-matches
        if (idx !== undefined) {
            for (let i = idx; i < idx + n.length; i++)
                consumed.add(i);
        }
    };
    // 1. Full URLs first (highest priority, most specific)
    let m;
    const urlRe = /https?:\/\/[^\s,)>'"]+/g;
    while ((m = urlRe.exec(text)) !== null)
        add(m[0], 'URL', m.index);
    // 2. Emails — before bare domains/handles to prevent partial re-matching
    const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    while ((m = emailRe.exec(text)) !== null)
        add(m[0], 'EMAIL', m.index);
    // 3. Bare domains — only when NOT preceded by @ or . (not part of an email)
    const domainRe = /(?<![.@a-zA-Z0-9])\b[a-zA-Z0-9-]{3,}\.(com|io|ai|dev|app|net|org|co)\b/g;
    while ((m = domainRe.exec(text)) !== null) {
        if (!consumed.has(m.index))
            add(m[0], 'URL', m.index);
    }
    // 4. Social handles — NOT preceded by alphanumeric or dot (not part of email)
    const handleRe = /(?<![a-zA-Z0-9.])@[a-zA-Z][a-zA-Z0-9_]{2,}/g;
    while ((m = handleRe.exec(text)) !== null) {
        if (!consumed.has(m.index))
            add(m[0], 'HANDLE', m.index);
    }
    // 5. US phone numbers
    const phoneRe = /\b(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
    while ((m = phoneRe.exec(text)) !== null)
        add(m[0], 'PHONE', m.index);
    return entities;
}
function extractNlpEntities(text) {
    const doc = nlp(text);
    const entities = [];
    const seen = new Set();
    const add = (t, type) => {
        const n = t.trim();
        if (n.length > 1 && !seen.has(n.toLowerCase())) {
            seen.add(n.toLowerCase());
            entities.push({ text: n, type });
        }
    };
    doc.people().forEach((p) => add(p.text(), 'PERSON'));
    doc.places().forEach((p) => add(p.text(), 'PLACE'));
    doc.organizations().forEach((o) => add(o.text(), 'ORG'));
    return entities;
}
function extractCamelCaseEntities(text, knownEntities) {
    // Only match TRUE compound CamelCase — requires at least one internal capital letter.
    // This catches: OpenClaw, CrossTimbersFarm, BlueBubbles, LinkedIn, RadarScope, Weatherfront
    // Does NOT catch: Email, Building, Casey, Tulsa (single-capital words)
    const matches = text.match(/\b[A-Z][a-z]{2,}[A-Z][a-zA-Z]+\b/g) ?? [];
    const entities = [];
    const seen = new Set();
    matches.forEach(term => {
        if (!TECH_ALLOWLIST.has(term) &&
            !knownEntities.has(term.toLowerCase()) &&
            !seen.has(term.toLowerCase())) {
            seen.add(term.toLowerCase());
            entities.push({ text: term, type: 'PROJECT' });
        }
    });
    return entities;
}
// ── Token substitution ────────────────────────────────────────────────────────
export function buildTokenMap(entities, existing) {
    const tokenMap = existing ?? {
        forward: new Map(),
        reverse: new Map(),
    };
    const counters = {};
    for (const token of tokenMap.reverse.keys()) {
        const m = token.match(/\[([A-Z]+)_(\d+)\]/);
        if (m)
            counters[m[1]] = Math.max(counters[m[1]] ?? 0, parseInt(m[2]));
    }
    for (const entity of entities) {
        if (tokenMap.forward.has(entity.text))
            continue;
        // Check case-insensitive match against existing forward map
        const existing = [...tokenMap.forward.entries()].find(([k]) => k.toLowerCase() === entity.text.toLowerCase());
        if (existing) {
            tokenMap.forward.set(entity.text, existing[1]);
            continue;
        }
        const n = (counters[entity.type] ?? 0) + 1;
        counters[entity.type] = n;
        const token = `[${entity.type}_${n}]`;
        tokenMap.forward.set(entity.text, token);
        tokenMap.reverse.set(token, entity.text);
    }
    return tokenMap;
}
// ── Code-region detection (SCI-198) ──────────────────────────────────────────
//
// Locates markdown code regions in text and returns their [start, end) byte
// ranges (sorted, non-overlapping). Mirrors the Rust sci-anonymizer
// code_regions module. Callers use these ranges to skip entity substitution
// inside code fences and inline backtick spans, preventing project names,
// variable identifiers, etc. from getting anonymized inside code snippets.
//
// Recognised:  triple-backtick fences (``` … ```), triple-tilde fences
//              (~~~ … ~~~), inline single-backtick spans (` … `).
// Not recognised: 4-space indented blocks (too many false positives).
function extractCodeRegions(text) {
    const regions = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        // Fenced block: ``` or ~~~
        if ((ch === '`' || ch === '~') && text[i + 1] === ch && text[i + 2] === ch) {
            const fence = ch;
            const start = i;
            i += 3;
            while (i < n && text[i] !== '\n')
                i++; // skip info string
            if (i < n)
                i++; // consume opening newline
            let closed = false;
            while (i < n) {
                if (text[i] === fence && text[i + 1] === fence && text[i + 2] === fence) {
                    i += 3;
                    while (i < n && text[i] !== '\n')
                        i++; // skip closing fence tail
                    if (i < n)
                        i++;
                    regions.push([start, i]);
                    closed = true;
                    break;
                }
                i++;
            }
            if (!closed) {
                regions.push([start, n]);
                break;
            }
            continue;
        }
        // Inline backtick span (line-scoped, escape-aware)
        if (ch === '`' && (i === 0 || text[i - 1] !== '\\')) {
            const start = i;
            i++;
            while (i < n && text[i] !== '`' && text[i] !== '\n')
                i++;
            if (i < n && text[i] === '`') {
                i++;
                regions.push([start, i]);
            }
            continue;
        }
        i++;
    }
    return regions;
}
function applyEntriesToSlice(text, entries) {
    let result = text;
    for (const [entity, token] of entries) {
        const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`(?<![\\w@/])${escaped}(?![\\w])`, 'gi'), token);
    }
    return result;
}
function applyTokenMap(text, tokenMap) {
    // Sort by entity length descending — replace longer matches first so
    // "Casey Zandbergen" becomes [PERSON_1] before "Casey" gets a shot.
    const entries = [...tokenMap.forward.entries()].sort((a, b) => b[0].length - a[0].length);
    const codeRegions = extractCodeRegions(text);
    if (codeRegions.length === 0) {
        return applyEntriesToSlice(text, entries);
    }
    // Interleave non-code (substituted) and code (verbatim) segments. SCI-198.
    let out = '';
    let pos = 0;
    for (const [rStart, rEnd] of codeRegions) {
        if (pos < rStart)
            out += applyEntriesToSlice(text.slice(pos, rStart), entries);
        out += text.slice(rStart, rEnd); // code region — verbatim
        pos = rEnd;
    }
    if (pos < text.length)
        out += applyEntriesToSlice(text.slice(pos), entries);
    return out;
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Synchronous anonymize — uses only regex + NLP (no DB).
 * Use anonymizeAsync for full coverage including custom entities.
 */
export function anonymize(text, existing) {
    const regexEntities = extractRegexEntities(text);
    const nlpEntities = extractNlpEntities(text);
    const knownSet = new Set([...regexEntities, ...nlpEntities].map(e => e.text.toLowerCase()));
    const camelEntities = extractCamelCaseEntities(text, knownSet);
    const allEntities = [...regexEntities, ...nlpEntities, ...camelEntities];
    const tokenMap = buildTokenMap(allEntities, existing);
    return {
        text: applyTokenMap(text, tokenMap),
        tokenMap,
        entityCount: allEntities.length,
        detected: allEntities,
    };
}
/**
 * Full anonymize with DB-loaded custom entities (project names, known orgs etc.)
 *
 * sessionEntities — entities seen in previous calls this session (item 1: feedback loop).
 * These are checked proactively even if NER/CamelCase wouldn't catch them this turn.
 */
export async function anonymizeAsync(text, readerOrAdapter, existing, sessionEntities) {
    const customEntities = 'backend' in readerOrAdapter
        ? await loadCustomEntitiesFromAdapter(readerOrAdapter)
        : await loadCustomEntities(readerOrAdapter);
    // Merge session feedback entities with DB custom entities — these are checked
    // as a proactive first pass before NER, ensuring entities seen before are
    // always caught even in new grammatical contexts.
    const feedbackEntities = [];
    if (sessionEntities && sessionEntities.length > 0) {
        const dbKeys = new Set(customEntities.map(e => e.text.toLowerCase()));
        for (const e of sessionEntities) {
            if (!dbKeys.has(e.text.toLowerCase()))
                feedbackEntities.push(e);
        }
    }
    const regexEntities = extractRegexEntities(text);
    const nlpEntities = extractNlpEntities(text);
    const knownSet = new Set([
        ...regexEntities,
        ...nlpEntities,
        ...customEntities,
        ...feedbackEntities,
    ].map(e => e.text.toLowerCase()));
    const camelEntities = extractCamelCaseEntities(text, knownSet);
    const allEntities = [
        ...regexEntities,
        ...nlpEntities,
        ...customEntities,
        ...feedbackEntities,
        ...camelEntities,
    ];
    // Progressive promotion: count entities that appear across multiple calls.
    // Track anything not already in identity_facts (DB custom) — including session
    // feedback entities, because their repeated appearance is what drives promotion.
    // Entities already in the DB don't need promotion — they're already known.
    const dbCustomKeys = new Set(customEntities.map(e => e.text.toLowerCase()));
    const promotionCandidates = [
        ...nlpEntities,
        ...camelEntities,
        ...feedbackEntities, // count repeated appearances from previous session calls
    ].filter(e => !dbCustomKeys.has(e.text.toLowerCase()) &&
        ['PROJECT', 'ORG', 'PLACE'].includes(e.type));
    _recordForPromotion(promotionCandidates);
    const tokenMap = buildTokenMap(allEntities, existing);
    return {
        text: applyTokenMap(text, tokenMap),
        tokenMap,
        entityCount: allEntities.length,
        detected: allEntities,
    };
}
export function deanonymize(text, tokenMap) {
    let result = text;
    const tokens = [...tokenMap.reverse.keys()].sort((a, b) => b.length - a.length);
    for (const token of tokens) {
        result = result.split(token).join(tokenMap.reverse.get(token));
    }
    return result;
}
const sessionStore = new Map();
export function createSession() {
    const id = crypto.randomUUID();
    sessionStore.set(id, {
        tokenMap: { forward: new Map(), reverse: new Map() },
        seenEntities: [],
    });
    return id;
}
export function getSession(id) {
    return sessionStore.get(id)?.tokenMap;
}
export function anonymizeWithSession(text, sessionId) {
    let session = sessionStore.get(sessionId);
    if (!session) {
        session = { tokenMap: { forward: new Map(), reverse: new Map() }, seenEntities: [] };
        sessionStore.set(sessionId, session);
    }
    const result = anonymize(text, session.tokenMap);
    _updateSession(session, result);
    return result;
}
export async function anonymizeWithSessionAsync(text, sessionId, reader) {
    let session = sessionStore.get(sessionId);
    if (!session) {
        session = { tokenMap: { forward: new Map(), reverse: new Map() }, seenEntities: [] };
        sessionStore.set(sessionId, session);
    }
    // Feed previously seen session entities back in as additional custom entities
    // This means: if "Threadline" was missed in call 1 but caught in call 2,
    // it will be proactively masked in all future calls this session.
    const result = await anonymizeAsync(text, reader, session.tokenMap, session.seenEntities);
    _updateSession(session, result);
    return result;
}
/** Merge newly detected entities back into the session for future calls */
function _updateSession(session, result) {
    const existingTexts = new Set(session.seenEntities.map(e => e.text.toLowerCase()));
    for (const entity of result.detected) {
        if (!existingTexts.has(entity.text.toLowerCase())) {
            session.seenEntities.push(entity);
            existingTexts.add(entity.text.toLowerCase());
        }
    }
    // Note: progressive promotion tracking is done in anonymizeAsync with filtered entities
}
export function deanonymizeWithSession(text, sessionId) {
    const session = sessionStore.get(sessionId);
    if (!session)
        return text;
    return deanonymize(text, session.tokenMap);
}
export function discardSession(sessionId) {
    sessionStore.delete(sessionId);
}
// ── Progressive entity promotion (item 3) ────────────────────────────────────
//
// Tracks how many distinct anonymize calls have seen each unknown proper noun.
// When a word appears in PROMOTION_THRESHOLD separate calls, it's flagged for
// promotion to identity_facts — the caller (MCP tool) handles the actual write.
//
// "Unknown" means: not in TECH_ALLOWLIST and not already in identity_facts.
// Type PROJECT is used as the default for all promoted entities.
const PROMOTION_THRESHOLD = 3;
// lowercase key → { count, originalText }
const promotionCounter = new Map();
const pendingPromotions = new Set(); // lowercase keys ready to promote
function _recordForPromotion(entities) {
    for (const entity of entities) {
        if (TECH_ALLOWLIST.has(entity.text))
            continue;
        const key = entity.text.toLowerCase();
        const existing = promotionCounter.get(key);
        const count = (existing?.count ?? 0) + 1;
        promotionCounter.set(key, { count, text: existing?.text ?? entity.text });
        if (count >= PROMOTION_THRESHOLD && !pendingPromotions.has(key)) {
            pendingPromotions.add(key);
        }
    }
}
/** Returns entities ready for promotion to identity_facts, then clears the queue */
export function drainPendingPromotions() {
    if (pendingPromotions.size === 0)
        return [];
    const results = [];
    for (const key of pendingPromotions) {
        const entry = promotionCounter.get(key);
        results.push({ text: entry?.text ?? key, type: 'PROJECT' });
    }
    pendingPromotions.clear();
    return results;
}
export function describeTokenMap(tokenMap) {
    if (tokenMap.forward.size === 0)
        return 'No entities detected';
    const lines = [...tokenMap.forward.entries()].map(([entity, token]) => `  ${token} → "${entity}"`);
    return `${tokenMap.forward.size} entities masked:\n${lines.join('\n')}`;
}
//# sourceMappingURL=anonymizer.js.map