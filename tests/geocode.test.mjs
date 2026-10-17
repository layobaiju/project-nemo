// Place search (OpenStreetMap Nominatim, through the host): parsing, spacing, cache, validation and failures. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeocoder, parsePlaces } from '../server/geocode.mjs';

const ABBOTTABAD = {
  place_id: 1, osm_type: 'relation', osm_id: 1885, lat: '34.1688', lon: '73.2422', category: 'boundary', type: 'administrative', addresstype: 'city',
  name: 'Abbottabad', display_name: 'Abbottabad, Abbottabad District, Hazara Division, Khyber Pakhtunkhwa, Pakistan', boundingbox: ['34.10', '34.25', '73.15', '73.30'],
};
const VILLAGE = { place_id: 2, osm_type: 'node', osm_id: 77, lat: '29.95', lon: '70.30', category: 'place', type: 'village', addresstype: 'village', name: 'Kot Addu Village', display_name: 'Kot Addu Village, Punjab, Pakistan' };

function clock(start = Date.UTC(2026, 9, 17)) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async ms => { c.slept.push(ms); c.t += ms; };
  return c;
}
function fakeFetch(answer = () => ({ status: 200, text: JSON.stringify([ABBOTTABAD, VILLAGE]) })) {
  const calls = [];
  const fetchText = async (url, init) => { calls.push(url); return answer(url, init); };
  return { calls, fetchText };
}
const statusOf = async p => { try { await p; return 200; } catch (e) { return e.status; } };

test('places are parsed and broken rows dropped', () => {
  assert.deepEqual(parsePlaces([ABBOTTABAD, VILLAGE, { osm_type: 'node', osm_id: 5, lat: 'x', lon: '1', name: 'Broken' }, null]), [
    { id: 'relation/1885', name: 'Abbottabad', type: 'city', region: 'Abbottabad District, Hazara Division, Khyber Pakhtunkhwa, Pakistan', lng: 73.2422, lat: 34.1688, bbox: [73.15, 34.1, 73.3, 34.25] },
    { id: 'node/77', name: 'Kot Addu Village', type: 'village', region: 'Punjab, Pakistan', lng: 70.3, lat: 29.95, bbox: null },
  ]);
  assert.deepEqual(parsePlaces({ error: 'x' }), []);
  assert.equal(parsePlaces([{ ...VILLAGE, name: '' }])[0].name, 'Kot Addu Village', 'a nameless place takes the first part of its address');
});

test('searches are spaced a second apart, cached and validated', async () => {
  const c = clock(), f = fakeFetch();
  const g = createGeocoder({ fetchText: f.fetchText, now: c.now, sleep: c.sleep });
  const first = await g.search('Abbottabad');
  assert.equal(first.places[0].name, 'Abbottabad');
  assert.match(first.attribution, /OpenStreetMap contributors/);
  assert.match(f.calls[0], /^https:\/\/nominatim\.openstreetmap\.org\/search\?q=Abbottabad&format=jsonv2&limit=8/);
  await g.search('  abbottabad ');
  assert.equal(f.calls.length, 1, 'the same search is answered from the cache');
  await g.search('Kabul');
  assert.equal(f.calls.length, 2);
  assert.ok(c.slept.reduce((a, b) => a + b, 0) >= 1000, 'at most one request per second');
  assert.equal(await statusOf(g.search(' ')), 400);
  assert.equal(await statusOf(g.search('a')), 400);
  assert.equal(await statusOf(g.search('x'.repeat(201))), 400);
});

test('failures are reported clearly', async () => {
  const c = clock();
  const answers = [{ status: 429, text: '' }, { status: 500, text: '' }, { status: 200, text: 'not json' }];
  const f = fakeFetch(() => answers.shift() || Promise.reject(new Error('getaddrinfo ENOTFOUND')));
  const g = createGeocoder({ fetchText: f.fetchText, now: c.now, sleep: c.sleep });
  const busy = await g.search('one').catch(e => e);
  assert.equal(busy.status, 503);
  assert.match(busy.message, /busy/);
  assert.equal(await statusOf(g.search('two')), 502);
  assert.equal(await statusOf(g.search('three')), 502);
  const offline = await g.search('four').catch(e => e);
  assert.equal(offline.status, 502);
  assert.match(offline.message, /Could not reach the place search/);
  assert.equal(f.calls.length, 4, 'failures are not cached');
});

test('a place is framed by its extent, or a small box around a point', async () => {
  const { placeBounds } = await import('../src/geo.ts');
  assert.deepEqual(placeBounds({ lng: 73.24, lat: 34.17, bbox: [73.15, 34.1, 73.3, 34.25] }), [[73.15, 34.1], [73.3, 34.25]]);
  const [[w, s], [e, n]] = placeBounds({ lng: 70.3, lat: 29.95, bbox: null });
  assert.ok(Math.abs(w - 70.29) < 1e-9 && Math.abs(e - 70.31) < 1e-9 && Math.abs(s - 29.94) < 1e-9 && Math.abs(n - 29.96) < 1e-9);
  assert.deepEqual(placeBounds({ lng: 1, lat: 2, bbox: [5, 5, 5, 5] })[0], [0.99, 1.99], 'an empty extent falls back to the point');
});
