// Place search (cities, towns, villages, districts, landmarks) through OpenStreetMap's Nominatim, from the Windows host.
// Nominatim's public usage policy (https://operations.osmfoundation.org/policies/nominatim/): at most one request per
// second, an identifying User-Agent (set by the shared HTTPS client), results cached, no search-as-you-type, and
// "© OpenStreetMap contributors" shown with the results. Atlas searches only when the user presses Search or Enter.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
export const GEO_ATTRIBUTION = 'Place search © OpenStreetMap contributors (ODbL), via Nominatim';
const GAP_MS = 1100, TTL_MS = 24 * 3600 * 1000, CACHE_MAX = 500, LIMIT = 8;

const fail = (status, message) => Object.assign(new Error(message), { status });
const num = v => (v === '' || v == null ? NaN : Number(v));
const reason = e => (e?.name === 'TimeoutError' ? 'request timed out' : e?.message || String(e));

/** Nominatim jsonv2 rows → { id, name, type, region, lng, lat, bbox: [west, south, east, north] | null }. Broken rows are dropped. */
export function parsePlaces(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const lat = num(r?.lat), lng = num(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const parts = String(r.display_name || '').split(', ').filter(Boolean);
    const name = String(r.name || '').trim() || parts[0] || 'Unnamed place';
    const region = (parts[0] === name ? parts.slice(1) : parts).join(', ');
    const b = Array.isArray(r.boundingbox) ? r.boundingbox.map(num) : [];
    const bbox = b.length === 4 && b.every(Number.isFinite) ? [b[2], b[0], b[3], b[1]] : null; // [south, north, west, east] → [w, s, e, n]
    out.push({ id: `${r.osm_type || 'place'}/${r.osm_id ?? r.place_id ?? out.length}`, name, type: String(r.addresstype || r.type || r.category || 'place').replace(/[_:]/g, ' '), region, lng, lat, bbox });
  }
  return out;
}

export function createGeocoder({ fetchText, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.warn } = {}) {
  const cache = new Map();
  let chain = Promise.resolve(), lastAt = -Infinity;

  /** One search per call, spaced at least 1.1 s apart across all devices, answered from the cache when repeated. */
  function search(q) {
    const query = String(q ?? '').replace(/\s+/g, ' ').trim();
    if (query.length < 2 || query.length > 200) return Promise.reject(fail(400, 'Type 2 to 200 characters to search for a place.'));
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    const job = chain.then(async () => {
      const again = cache.get(key);
      if (again && again.expires > now()) return again.value;
      const wait = lastAt + GAP_MS - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      let r;
      try {
        r = await fetchText(`${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=${LIMIT}&accept-language=en`, { timeoutMs: 15000 });
      } catch (e) {
        log(`Place search "${query}": ${reason(e)}`);
        throw fail(502, `Could not reach the place search service: ${reason(e)}.`);
      }
      if (r.status === 429 || r.status === 403) throw fail(503, 'The place search service is busy. Try again in a minute.');
      if (r.status !== 200) throw fail(502, `The place search service returned HTTP ${r.status}.`);
      let rows;
      try { rows = JSON.parse(r.text); } catch { throw fail(502, 'The place search service sent an unreadable answer.'); }
      const value = { places: parsePlaces(rows), attribution: GEO_ATTRIBUTION };
      cache.set(key, { value, expires: now() + TTL_MS });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return value;
    });
    chain = job.catch(() => {});
    return job;
  }
  return { search };
}
