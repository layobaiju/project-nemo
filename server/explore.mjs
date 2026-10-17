// Explore: live look-ups in free public sources (Wikipedia, Wikidata, GDELT) for the Explore page.
// Every request goes through an injected fetchText, so parsing, caching and GDELT's rate limit are testable offline.
// Nothing here is written to data/: results live in a memory cache and are gone when the host restarts.

import https from 'node:https';
import zlib from 'node:zlib';

const UA = 'Atlas-Workspace/0.4 (self-hosted research tool)';
const ALLOWED_HOSTS = new Set(['en.wikipedia.org', 'www.wikidata.org', 'query.wikidata.org', 'api.gdeltproject.org', 'nominatim.openstreetmap.org']);
const WP_API = 'https://en.wikipedia.org/w/api.php';
const WD_API = 'https://www.wikidata.org/w/api.php';
const SPARQL = 'https://query.wikidata.org/sparql';
const GDELT = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DAY = 24 * 3600 * 1000, NEWS_TTL = 6 * 3600 * 1000, CACHE_MAX = 50 * 1024 * 1024;
const GDELT_GAP_MS = 5500, BACKOFF_S = [30, 60, 120];
const MAX_REFERENCES = 5000, VALUES_CHUNK = 300, SPARQL_PARALLEL = 4;
const PROPERTY_TTL = 7 * 24 * 3600 * 1000;
// Facts that read well first; everything else follows by label.
const FACT_ORDER = ['P31', 'P569', 'P19', 'P570', 'P20', 'P1196', 'P27', 'P463', 'P106', 'P39', 'P140', 'P793', 'P276', 'P585', 'P580', 'P582', 'P17', 'P131', 'P112', 'P710', 'P1344'];
export const ATTRIBUTION = 'Text from Wikipedia (CC BY-SA 4.0). Facts and links from Wikidata (CC0). News index from the GDELT Project.';

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- Search around ----------
// Incoming links are searched only through roles (who took part, who founded, who led, where it happened…), never
// "everything that mentions it", which is millions of items for a country.
const ROLE_PROPERTIES = ['P710', 'P8031', 'P8032', 'P533', 'P664', 'P112', 'P488', 'P35', 'P6', 'P463', 'P102', 'P108', 'P1037', 'P3342', 'P50', 'P3320', 'P749', 'P127', 'P276', 'P159'];
// Outgoing statements never offered as connections:
// - Wikipedia's own bookkeeping, not the world;
// - personal attributes that only clutter a link chart (eye or hair colour, handedness, names, languages);
// - protected characteristics (sex or gender, sexual orientation, ethnic group, religion), so the graph never links
//   people by who they are rather than by what they did.
const HOUSEKEEPING = new Set([
  'P31', 'P279', 'P910', 'P1343', 'P5008', 'P1424', 'P7867', 'P1792', 'P2354', 'P5125', 'P6104', 'P1151', 'P8989',
  'P1340', 'P1884', 'P552', 'P734', 'P735', 'P1412', 'P103', 'P1347',
  'P21', 'P91', 'P172', 'P140',
]);
const INCOMING_LIMIT = 300;
const words = list => new RegExp(`\\b(${list})\\b`, 'i');
const ORGANISATION = words('organi[sz]ations?|groups?|part(?:y|ies)|compan(?:y|ies)|agenc(?:y|ies)|militias?|movements?|arm(?:y|ies)|forces?|governments?|ministr(?:y|ies)|banks?|corporations?|institutions?|unions?|networks?');
const EVENT = words('wars?|battles?|attacks?|bombings?|conflicts?|operations?|events?|elections?|massacres?|incidents?|killings?|invasions?|revolutions?|sieges?|raids?');
const PLACE = words('cit(?:y|ies)|countr(?:y|ies)|states?|towns?|villages?|regions?|provinces?|districts?|buildings?|compounds?|capitals?|territor(?:y|ies)|islands?|mountains?|rivers?');
const SOURCE = words('books?|documents?|letters?|publications?|written works?|speech(?:es)?|manifestos?|films?|videos?');
/** Graph node kind for a Wikidata item; the first rule that matches wins. */
export function nodeKind({ isHuman = false, types = [], hasCoord = false, hasDate = false }) {
  const has = re => types.some(t => re.test(t));
  if (isHuman) return 'Actor';
  if (has(ORGANISATION)) return 'Organisation';
  if (hasDate || has(EVENT)) return 'Historical event';
  if (hasCoord || has(PLACE)) return 'Place';
  if (has(SOURCE)) return 'Source';
  return 'Note';
}
const reason = e => (e?.name === 'TimeoutError' ? 'request timed out' : e?.message || String(e));

// node:https rather than fetch(): fetch gives up connecting after a fixed 10 s, and GDELT's TLS handshake takes
// about 9.5 s from some networks. Kept-alive connections mean only the first request pays for the handshake.
const agent = new https.Agent({ keepAlive: true, maxSockets: 6 });
const MAX_RESPONSE = 25 * 1024 * 1024;
export function defaultFetchText(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) return Promise.reject(new Error(`Explore does not contact ${u.protocol === 'https:' ? u.hostname : u.origin}`));
  return new Promise((resolve, reject) => {
    let timer;
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    const req = https.request(u, {
      method, agent,
      headers: { 'user-agent': UA, 'accept-encoding': 'gzip', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers },
    }, res => {
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', c => { size += c.length; if (size > MAX_RESPONSE) { req.destroy(new Error('response too large')); return; } chunks.push(c); });
      stream.on('end', () => done(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', e => done(reject, e));
    });
    timer = setTimeout(() => req.destroy(Object.assign(new Error('request timed out'), { name: 'TimeoutError' })), timeoutMs);
    req.on('error', e => done(reject, e));
    req.end(body);
  });
}

/** Wikidata time → 'YYYY-MM-DD', 'YYYY-MM' or 'YYYY' following its precision (11 day, 10 month, ≤ 9 year). */
export function wikidataTime(v) {
  const m = String(v?.time ?? '').match(/^([+-]?)(\d+)-(\d\d)-(\d\d)T/);
  if (!m) return '';
  const year = `${m[1] === '-' ? '-' : ''}${m[2].length > 4 ? m[2].replace(/^0+/, '').padStart(4, '0') : m[2]}`;
  const p = Number(v.precision);
  return p >= 11 ? `${year}-${m[3]}-${m[4]}` : p === 10 ? `${year}-${m[3]}` : year;
}
/** 'Point(lng lat)' (SPARQL WKT) → [lng, lat]. */
export function parsePoint(wkt) {
  const m = String(wkt || '').match(/^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const formatterUrl = (fmt, id) => fmt.replace('$1', encodeURIComponent(id).replace(/%2F/gi, '/').replace(/%3A/gi, ':'));
export const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
const idOf = uri => String(uri || '').split('/').pop();
// Wikidata text is editable by anyone: only plain web addresses become links, never javascript:, data: and the like.
const isWebUrl = u => /^https?:\/\/\S+$/i.test(String(u || ''));
const gdeltStamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

function createCache(now) {
  const map = new Map();
  let bytes = 0;
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now()) { map.delete(key); bytes -= hit.bytes; return undefined; }
      return hit.value;
    },
    set(key, value, ttl) {
      const old = map.get(key);
      if (old) { map.delete(key); bytes -= old.bytes; }
      const size = JSON.stringify(value).length;
      map.set(key, { value, expires: now() + ttl, bytes: size });
      bytes += size;
      for (const [k, v] of map) { if (bytes <= CACHE_MAX) break; map.delete(k); bytes -= v.bytes; }
    },
  };
}

export function createExplore({ fetchText = defaultFetchText, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.warn } = {}) {
  const cache = createCache(now);
  async function getJson(url, init) {
    const r = await fetchText(url, init);
    if (r.status !== 200) throw new Error(`${new URL(url).hostname} returned HTTP ${r.status}`);
    return JSON.parse(r.text);
  }
  // Wikidata's query service allows 5 queries at a time per client; Atlas stays at 4. A finished query hands its
  // slot straight to the next waiting one.
  let sparqlActive = 0;
  const sparqlWaiting = [];
  async function sparql(query, timeoutMs = 30000) {
    if (sparqlActive < SPARQL_PARALLEL) sparqlActive++; else await new Promise(r => sparqlWaiting.push(r));
    try {
      const json = await getJson(SPARQL, {
        method: 'POST', body: `query=${encodeURIComponent(query)}`, timeoutMs,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json' },
      });
      return json.results?.bindings || [];
    } finally {
      const next = sparqlWaiting.shift();
      if (next) next(); else sparqlActive--;
    }
  }
  const LABELS = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }';

  // ---------- search ----------
  async function search(q) {
    const query = String(q || '').trim();
    if (/^Q\d{1,12}$/i.test(query)) return [{ id: query.toUpperCase(), label: query.toUpperCase(), description: '', wikipediaTitle: null }];
    const key = `search:${query.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const enc = encodeURIComponent(query);
    const [wp, wd] = await Promise.allSettled([
      getJson(`${WP_API}?action=query&generator=search&gsrsearch=${enc}&gsrlimit=10&prop=pageprops|description&ppprop=wikibase_item&format=json&formatversion=2`),
      getJson(`${WD_API}?action=wbsearchentities&search=${enc}&language=en&uselang=en&type=item&limit=10&format=json`),
    ]);
    if (wp.status === 'rejected' && wd.status === 'rejected') throw fail(502, `Explore could not reach Wikipedia or Wikidata: ${reason(wp.reason)}.`);
    const out = [], seen = new Set();
    const pages = wp.status === 'fulfilled' ? [...(wp.value.query?.pages || [])].sort((a, b) => a.index - b.index) : [];
    for (const p of pages) {
      const id = p.pageprops?.wikibase_item;
      if (id && !seen.has(id)) { seen.add(id); out.push({ id, label: p.title, description: p.description || '', wikipediaTitle: p.title }); }
    }
    for (const s of wd.status === 'fulfilled' ? wd.value.search || [] : []) {
      if (!seen.has(s.id)) { seen.add(s.id); out.push({ id: s.id, label: s.label || s.id, description: s.description || '', wikipediaTitle: null }); }
    }
    const result = out.slice(0, 10);
    cache.set(key, result, DAY);
    return result;
  }

  // ---------- topic ----------
  // Property names and link templates ("date of birth", VIAF's URL pattern) are the same for every topic, so they
  // are remembered for a week; a country uses hundreds of them.
  const knownProperties = new Map();
  async function propertyInfo(ids) {
    const info = new Map(), missing = [];
    for (const p of ids) { const known = knownProperties.get(p); if (known && known.expires > now()) info.set(p, known); else missing.push(p); }
    const batches = await Promise.all(chunk(missing, VALUES_CHUNK).map(part =>
      sparql(`SELECT ?p ?pLabel ?fmt WHERE { VALUES ?p { ${part.map(p => `wd:${p}`).join(' ')} } OPTIONAL { ?p wdt:P1630 ?fmt } ${LABELS} }`)));
    for (const b of batches.flat()) {
      const p = idOf(b.p.value);
      if (info.has(p)) continue;
      const entry = { label: b.pLabel?.value || p, fmt: b.fmt?.value || '', expires: now() + PROPERTY_TTL };
      info.set(p, entry);
      knownProperties.set(p, entry);
    }
    return info;
  }
  async function itemInfo(ids) {
    const info = new Map();
    const batches = await Promise.all(chunk(ids, VALUES_CHUNK).map(part =>
      sparql(`SELECT ?i ?iLabel ?coord WHERE { VALUES ?i { ${part.map(q => `wd:${q}`).join(' ')} } OPTIONAL { ?i wdt:P625 ?coord } ${LABELS} }`)));
    for (const b of batches.flat()) {
      const q = idOf(b.i.value), prev = info.get(q);
      info.set(q, { label: b.iLabel?.value || q, coord: prev?.coord || parsePoint(b.coord?.value) });
    }
    return info;
  }
  // Only properties that tie an event to the topic. "Every item that mentions the topic" is millions of items for a
  // country (every person born there, every town), which Wikidata cannot answer in time.
  const EVENT_LINKS = ['P710', 'P8031', 'P8032', 'P533', 'P664', 'P3342', 'P50', 'P8004', 'P1346', 'P726', 'P991', 'P276'];
  async function relatedEvents(qid) {
    const rows = await sparql(`SELECT ?item ?itemLabel ?date ?prec ?end ?endPrec ?coord ?pc ?placeLabel WHERE {
      { VALUES ?p { ${EVENT_LINKS.map(p => `wdt:${p}`).join(' ')} } ?item ?p wd:${qid} . } UNION { wd:${qid} wdt:P793|wdt:P1344|wdt:P607 ?item . }
      { ?item p:P585/psv:P585 [ wikibase:timeValue ?date ; wikibase:timePrecision ?prec ] } UNION { ?item p:P580/psv:P580 [ wikibase:timeValue ?date ; wikibase:timePrecision ?prec ] }
      OPTIONAL { ?item p:P582/psv:P582 [ wikibase:timeValue ?end ; wikibase:timePrecision ?endPrec ] }
      OPTIONAL { ?item wdt:P625 ?coord }
      OPTIONAL { ?item wdt:P276 ?place . OPTIONAL { ?place wdt:P625 ?pc } }
      ${LABELS} } LIMIT 600`, 45000);
    const byId = new Map();
    for (const b of rows) {
      const id = idOf(b.item?.value);
      const date = b.date?.type === 'literal' ? wikidataTime({ time: b.date.value, precision: b.prec?.value }) : '';
      if (!/^Q\d+$/.test(id) || id === qid || !date) continue;
      const coord = parsePoint(b.coord?.value) || parsePoint(b.pc?.value);
      const ev = { id, label: b.itemLabel?.value || id, date, endDate: b.end?.type === 'literal' ? wikidataTime({ time: b.end.value, precision: b.endPrec?.value }) : '', coord, place: b.placeLabel?.value || '' };
      const prev = byId.get(id);
      if (!prev || (!prev.coord && coord)) byId.set(id, ev);
    }
    return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  async function wikipediaSummary(title) {
    const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    return { title: s.title || title, url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`, extract: s.extract || '', thumbnail: s.thumbnail?.source || null };
  }
  async function wikipediaLinks(title) {
    const urls = new Set();
    let cont, first = true;
    for (let page = 0; page < 50 && urls.size < MAX_REFERENCES && (first || cont); page++) {
      first = false;
      const j = await getJson(`${WP_API}?action=query&prop=extlinks&titles=${encodeURIComponent(title)}&ellimit=max&format=json&formatversion=2${cont ? `&elcontinue=${encodeURIComponent(cont)}` : ''}`);
      for (const l of j.query?.pages?.[0]?.extlinks || []) {
        const url = String(l.url || '').replace(/^\/\//, 'https://');
        if (isWebUrl(url)) urls.add(url);
      }
      cont = j.continue?.elcontinue;
    }
    return [...urls].slice(0, MAX_REFERENCES);
  }

  /** `fresh` skips the cache read (watchlist checks); the answer is still cached for Explore. */
  async function topic(qid, { fresh = false } = {}) {
    const hit = fresh ? undefined : cache.get(`topic:${qid}`);
    if (hit) return hit;
    let entity;
    try {
      const all = (await getJson(`${WD_API}?action=wbgetentities&ids=${qid}&props=labels|descriptions|aliases|claims|sitelinks/urls&languages=en&format=json`)).entities || {};
      // A merged item comes back under the ID it now redirects to.
      entity = all[qid] || Object.values(all).find(e => e?.redirects?.from === qid);
    } catch (e) { throw fail(502, `Explore could not reach Wikidata: ${reason(e)}.`); }
    if (!entity || 'missing' in entity) throw fail(404, `Wikidata has no item ${qid}.`);

    const claims = Object.entries(entity.claims || {})
      .map(([p, list]) => [p, list.filter(c => c.rank !== 'deprecated' && c.mainsnak?.snaktype === 'value')])
      .filter(([, list]) => list.length);
    const items = new Set();
    for (const [, list] of claims) for (const c of list) {
      const v = c.mainsnak.datavalue?.value;
      if (v?.id) items.add(v.id);
      if (/\/Q\d+$/.test(v?.unit || '')) items.add(idOf(v.unit));
    }
    const enTitle = entity.sitelinks?.enwiki?.title || null;
    const errors = {};
    const soft = (section, p, empty) => p.catch(e => { errors[section] = reason(e); log(`Explore ${qid} ${section}: ${reason(e)}`); return empty; });
    const [props, labels, wikipedia, references] = await Promise.all([
      soft('labels', propertyInfo(claims.map(([p]) => p)), new Map()),
      soft('labels', itemInfo([...items]), new Map()),
      enTitle ? soft('wikipedia', wikipediaSummary(enTitle), null) : null,
      enTitle ? soft('references', wikipediaLinks(enTitle), []) : [],
    ]);

    const itemValue = id => { const i = labels.get(id); return i?.coord ? { text: i.label, id, coord: i.coord } : { text: i?.label || id, id }; };
    const valueOf = dv => {
      const v = dv?.value;
      switch (dv?.type) {
        case 'wikibase-entityid': return v?.id ? itemValue(v.id) : null;
        case 'time': { const d = wikidataTime(v); return d ? { text: d, date: d } : null; }
        case 'string': return { text: String(v) };
        case 'monolingualtext': return { text: `${v.text} (${v.language})` };
        case 'quantity': {
          const unit = /\/Q\d+$/.test(v.unit || '') ? labels.get(idOf(v.unit))?.label || idOf(v.unit) : '';
          return { text: `${String(v.amount).replace(/^\+/, '')}${unit ? ` ${unit}` : ''}` };
        }
        case 'globecoordinate': return { text: `${v.latitude}, ${v.longitude}`, coord: [v.longitude, v.latitude] };
        default: return v == null ? null : { text: typeof v === 'object' ? JSON.stringify(v) : String(v) };
      }
    };
    const facts = [];
    const databases = [];
    for (const [p, list] of claims) {
      const datatype = list[0].mainsnak.datatype, label = props.get(p)?.label || p;
      if (p === 'P856') {
        for (const c of list) if (isWebUrl(c.mainsnak.datavalue.value)) databases.unshift({ url: String(c.mainsnak.datavalue.value), label: props.get(p)?.label || 'official website', note: '' });
        continue;
      }
      if (datatype === 'external-id') {
        const fmt = props.get(p)?.fmt;
        if (fmt) for (const c of list) {
          const url = formatterUrl(fmt, String(c.mainsnak.datavalue.value));
          if (isWebUrl(url)) databases.push({ url, label, note: String(c.mainsnak.datavalue.value) });
        }
        continue;
      }
      // One value per distinct text: Wikidata keeps a statement per term or period (e.g. seven UN Security Council terms).
      const seen = new Set();
      const values = list.map(c => valueOf(c.mainsnak.datavalue)).filter(v => v && !seen.has(v.text) && seen.add(v.text));
      if (values.length) facts.push({ property: p, label, values });
    }
    const rank = p => { const i = FACT_ORDER.indexOf(p.property); return i < 0 ? FACT_ORDER.length : i; };
    facts.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

    const fact = p => facts.find(f => f.property === p)?.values || [];
    const firstDate = p => fact(p).find(v => v.date)?.date || '';
    const types = fact('P31').map(v => v.text);
    const isHuman = fact('P31').some(v => v.id === 'Q5');
    const coord = fact('P625').find(v => v.coord)?.coord || fact('P276').find(v => v.coord)?.coord || null;
    const dates = isHuman && (firstDate('P569') || firstDate('P570')) ? { start: firstDate('P569'), end: firstDate('P570'), kind: 'life' }
      : firstDate('P585') ? { start: firstDate('P585'), end: '', kind: 'event' }
      : firstDate('P580') ? { start: firstDate('P580'), end: firstDate('P582'), kind: 'event' }
      : { start: '', end: '', kind: '' };
    const languages = Object.values(entity.sitelinks || {}).filter(s => isWebUrl(s.url))
      .sort((a, b) => (b.site === 'enwiki') - (a.site === 'enwiki'))
      .map(s => ({ url: s.url, label: `${s.title} (${s.site})`, note: s.site }));

    const result = {
      id: qid, label: entity.labels?.en?.value || qid, description: entity.descriptions?.en?.value || '',
      aliases: (entity.aliases?.en || []).map(a => a.value), types, isHuman,
      wikipedia, facts, coord, dates,
      links: { references: references.map(url => ({ url, label: new URL(url).hostname, note: 'Source cited in the Wikipedia article' })), databases, languages },
      attribution: ATTRIBUTION, errors, fetchedAt: new Date(now()).toISOString(),
      ...(entity.id && entity.id !== qid ? { redirectedTo: entity.id } : {}),
    };
    // A topic with failed parts is cached briefly, so a retry a minute later can fill the gaps.
    cache.set(`topic:${qid}`, result, Object.keys(errors).length ? 60 * 1000 : DAY);
    return result;
  }

  // ---------- news (GDELT: one request at a time, ≥ 5.5 s apart, backing off after a refusal) ----------
  let newsChain = Promise.resolve(), lastNewsAt = -Infinity, blockedUntil = 0, backoff = 0;
  function news(q, before, { fresh = false } = {}) {
    const phrase = String(q || '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
    const query = phrase.includes(' ') ? `"${phrase}"` : phrase;
    const key = `news:${query.toLowerCase()}:${before || ''}`;
    const job = newsChain.then(async () => {
      const hit = fresh ? undefined : cache.get(key);
      if (hit) return hit;
      if (now() < blockedUntil) return { articles: [], busy: true, retryAfter: Math.ceil((blockedUntil - now()) / 1000) };
      const wait = lastNewsAt + GDELT_GAP_MS - now();
      if (wait > 0) await sleep(wait);
      lastNewsAt = now();
      let r;
      try {
        r = await fetchText(`${GDELT}?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=75&sort=datedesc&startdatetime=20170101000000&enddatetime=${before || gdeltStamp(now())}`, { timeoutMs: 35000 });
      } catch (e) { return { articles: [], error: `Could not reach GDELT: ${reason(e)}` }; }
      if (r.status === 429) {
        const secs = BACKOFF_S[Math.min(backoff, BACKOFF_S.length - 1)];
        backoff++;
        blockedUntil = now() + secs * 1000;
        return { articles: [], busy: true, retryAfter: secs };
      }
      if (r.status !== 200) return { articles: [], error: `GDELT returned HTTP ${r.status}` };
      let data;
      try { data = JSON.parse(r.text || '{}'); } catch { return { articles: [], error: String(r.text).trim().slice(0, 300) }; }
      backoff = 0;
      const articles = (data.articles || []).filter(a => /^https?:\/\//i.test(a.url || '')).map(a => ({
        title: a.title || a.url, url: a.url, domain: a.domain || '',
        date: /^\d{8}/.test(a.seendate || '') ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : '',
        language: a.language || '', country: a.sourcecountry || '',
      }));
      const result = { articles };
      cache.set(key, result, NEWS_TTL);
      return result;
    });
    newsChain = job.catch(() => {});
    return job;
  }

  /** Related dated events, looked up separately so a slow answer never holds up the topic page. */
  async function events(qid) {
    const hit = cache.get(`events:${qid}`);
    if (hit) return hit;
    let list;
    try { list = await relatedEvents(qid); } catch (e) { throw fail(502, `Wikidata did not return related events in time (${reason(e)}). Try again in a minute.`); }
    cache.set(`events:${qid}`, list, DAY);
    return list;
  }

  /**
   * Search around: what the topic points to (its own item-valued facts) and what points to it through roles, grouped
   * by relationship and direction, each neighbour typed for the graph.
   */
  async function neighbors(qid) {
    const hit = cache.get(`neighbors:${qid}`);
    if (hit) return hit;
    const t = await topic(qid);
    const errors = {};
    const groups = new Map();
    const add = (direction, property, relation, item) => {
      if (item.id === qid || !/^Q\d+$/.test(item.id)) return;
      const key = `${direction}:${property}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, property, relation, direction, items: [] });
      if (!g.items.some(x => x.id === item.id)) g.items.push(item);
    };
    for (const f of t.facts) {
      if (HOUSEKEEPING.has(f.property)) continue;
      for (const v of f.values) if (v.id) add('out', f.property, f.label, { id: v.id, label: v.text, description: '', kind: 'Note' });
    }
    let capped = false;
    try {
      const [rows, props] = await Promise.all([
        sparql(`#atlas:incoming\nSELECT ?item ?itemLabel ?itemDescription ?p WHERE { VALUES ?p { ${ROLE_PROPERTIES.map(p => `wdt:${p}`).join(' ')} } ?item ?p wd:${qid} . ${LABELS} } LIMIT ${INCOMING_LIMIT}`),
        propertyInfo(ROLE_PROPERTIES).catch(() => new Map()),
      ]);
      capped = rows.length >= INCOMING_LIMIT;
      for (const b of rows) {
        const id = idOf(b.item?.value), p = idOf(b.p?.value);
        add('in', p, props.get(p)?.label || p, { id, label: b.itemLabel?.value || id, description: b.itemDescription?.value || '', kind: 'Note' });
      }
    } catch (e) { errors.incoming = reason(e); }

    const ids = [...new Set([...groups.values()].flatMap(g => g.items.map(i => i.id)))];
    try {
      const batches = await Promise.all(chunk(ids, VALUES_CHUNK).map(part => sparql(`#atlas:neighbors\nSELECT ?i ?iDescription ?t ?tLabel ?coord ?date WHERE { VALUES ?i { ${part.map(q => `wd:${q}`).join(' ')} } OPTIONAL { ?i wdt:P31 ?t } OPTIONAL { ?i wdt:P625 ?coord } OPTIONAL { ?i wdt:P585|wdt:P580 ?date } ${LABELS} }`)));
      const info = new Map();
      for (const b of batches.flat()) {
        const id = idOf(b.i?.value);
        const x = info.get(id) || { description: '', types: [], isHuman: false, hasCoord: false, hasDate: false };
        if (b.iDescription?.value) x.description = b.iDescription.value;
        if (b.t) { if (idOf(b.t.value) === 'Q5') x.isHuman = true; if (b.tLabel?.value && !x.types.includes(b.tLabel.value)) x.types.push(b.tLabel.value); }
        if (b.coord) x.hasCoord = true;
        if (b.date) x.hasDate = true;
        info.set(id, x);
      }
      for (const g of groups.values()) for (const item of g.items) {
        const x = info.get(item.id);
        if (x) { item.description = item.description || x.description; item.kind = nodeKind(x); }
      }
    } catch (e) { errors.details = reason(e); }

    const all = [...groups.values()];
    const result = { id: qid, label: t.label, groups: [...all.filter(g => g.direction === 'out'), ...all.filter(g => g.direction === 'in').sort((a, b) => b.items.length - a.items.length)], capped, errors };
    cache.set(`neighbors:${qid}`, result, Object.keys(errors).length ? 60 * 1000 : DAY);
    return result;
  }

  return { search, topic, events, neighbors, news };
}
