// Stand-in for Wikipedia, Wikidata and GDELT in tests: serves the trimmed fixtures in this folder by URL.
// The host loads it when ATLAS_EXPLORE_FAKE points here, so end-to-end tests never touch the network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => readFileSync(path.join(dir, `${name}.json`), 'utf8');
const ok = name => ({ status: 200, text: fixture(name) });

export default async function fakeFetch(url, init = {}) {
  const u = new URL(url), q = u.searchParams;
  const asked = `${q.get('gsrsearch') || ''} ${q.get('search') || ''} ${q.get('query') || ''}`;
  if (/offline/.test(asked)) throw new Error('getaddrinfo ENOTFOUND (fake offline)');
  if (u.hostname === 'en.wikipedia.org') {
    if (q.get('generator') === 'search') return ok('wp-search');
    if (q.get('prop') === 'extlinks') return ok(q.get('elcontinue') ? 'extlinks-2' : 'extlinks-1');
    if (u.pathname.includes('/page/summary/')) return ok('summary');
  }
  if (u.hostname === 'www.wikidata.org') {
    if (q.get('action') === 'wbsearchentities') return ok('wd-search');
    if (q.get('action') === 'wbgetentities') {
      const id = q.get('ids');
      return id === 'Q1317' || id === 'Q99' ? ok(`entity-${id}`) : { status: 200, text: JSON.stringify({ entities: { [id]: { id, missing: '' } } }) };
    }
  }
  if (u.hostname === 'query.wikidata.org') {
    const body = decodeURIComponent(String(init.body || '').replace(/^query=/, '').replace(/\+/g, ' '));
    if (body.startsWith('#atlas:incoming')) return ok('sparql-incoming');
    if (body.startsWith('#atlas:neighbors')) return ok('sparql-neighbors');
    if (body.includes('P1630')) return ok('sparql-props');
    if (body.includes('timePrecision')) return ok('sparql-events');
    return ok('sparql-items');
  }
  if (u.hostname === 'nominatim.openstreetmap.org') {
    return { status: 200, text: JSON.stringify([{ place_id: 1, osm_type: 'relation', osm_id: 1885, lat: '34.1688', lon: '73.2422', addresstype: 'city', name: 'Abbottabad', display_name: 'Abbottabad, Khyber Pakhtunkhwa, Pakistan', boundingbox: ['34.10', '34.25', '73.15', '73.30'] }]) };
  }
  if (u.hostname === 'api.gdeltproject.org') {
    if (/busy/.test(asked)) return { status: 429, text: 'Please limit requests to one every 5 seconds.' };
    return ok('gdelt');
  }
  return { status: 404, text: `fake: no fixture for ${url}` };
}
