/**
 * Exposure-services catalog — the curated list of AI-augmented services
 * used by the gateway's DNS matcher and the dashboard's "Exposure" tab.
 *
 * Source: packages/core/data/exposure-services.json. Edited as a flat
 * file (PRs welcome). Loaded once at process start; small enough that
 * the in-memory match map is trivial.
 *
 * Match rules:
 *   - exact match on a service's `domains` entries (e.g. notion.so)
 *   - suffix match on subdomains (e.g. foo.notion.so → notion.so)
 *
 * Unmatched hostnames are NEVER persisted — privacy-respecting by default.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
let _catalog = null;
let _domainIndex = null;
function findCatalogPath() {
    // Resolve relative to this compiled file. The data/ directory sits
    // alongside dist/ at packages/core/data/.
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/ is one level inside packages/core/
    return join(here, '..', 'data', 'exposure-services.json');
}
export function loadExposureCatalog() {
    if (_catalog)
        return _catalog;
    const overridePath = process.env['SCI_EXPOSURE_CATALOG_PATH'];
    const path = overridePath ?? findCatalogPath();
    const raw = readFileSync(path, 'utf-8');
    _catalog = JSON.parse(raw);
    // Build the domain → service index
    _domainIndex = new Map();
    for (const svc of _catalog.services) {
        for (const d of svc.domains) {
            _domainIndex.set(d.toLowerCase(), svc);
        }
    }
    return _catalog;
}
/**
 * Match a hostname against the catalog. Returns the matching service or
 * null. Performs exact match first, then walks up subdomain components
 * (e.g. `foo.bar.notion.so` → `bar.notion.so` → `notion.so` → match).
 */
export function matchHostname(hostname) {
    if (!_domainIndex)
        loadExposureCatalog();
    if (!_domainIndex)
        return null;
    const h = hostname.trim().toLowerCase().replace(/\.$/, ''); // trailing dot
    const direct = _domainIndex.get(h);
    if (direct)
        return direct;
    const parts = h.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const suffix = parts.slice(i).join('.');
        const hit = _domainIndex.get(suffix);
        if (hit)
            return hit;
    }
    return null;
}
/** All services, for the dashboard catalog view. */
export function listExposureServices() {
    return loadExposureCatalog().services;
}
/** Look up one service by id (e.g. for an event-detail expansion). */
export function getExposureService(id) {
    return loadExposureCatalog().services.find(s => s.id === id) ?? null;
}
//# sourceMappingURL=exposure-services.js.map