// Explore host module: search, topic assembly, links, events, failures and GDELT rate limiting. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplore, wikidataTime, parsePoint, formatterUrl, chunk, nodeKind } from '../server/explore.mjs';
import fakeFetch from './fixtures/explore/fake-fetch.mjs';

function clock(start = Date.UTC(2026, 9, 16)) {
  const c = { t: start, slept: [] };
  c.now = () => c.t;
  c.sleep = async ms => { c.slept.push(ms); c.t += ms; };
  return c;
}
const explore = (fetchText = fakeFetch, c = clock()) => createExplore({ fetchText, now: c.now, sleep: c.sleep, log: () => {} });
const round2 = ([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100];

test('search finds Osama bin Laden from a misspelled name', async () => {
  const x = explore();
  const hits = await x.search('osama binladen');
  assert.deepEqual(hits[0], { id: 'Q1317', label: 'Osama bin Laden', description: 'Founder of al-Qaeda (1957–2011)', wikipediaTitle: 'Osama bin Laden' });
  assert.deepEqual(hits.map(h => h.id), ['Q1317', 'Q3126626', 'Q863493', 'Q10612826'], 'Wikipedia hits in rank order, then Wikidata-only hits, no duplicates');
  assert.equal(hits[3].wikipediaTitle, null);
  assert.deepEqual((await x.search('q1317')).map(h => h.id), ['Q1317']);
});

test('wikidataTime keeps precision', () => {
  assert.equal(wikidataTime({ time: '+1957-03-10T00:00:00Z', precision: 11 }), '1957-03-10');
  assert.equal(wikidataTime({ time: '+1957-03-00T00:00:00Z', precision: 10 }), '1957-03');
  assert.equal(wikidataTime({ time: '1991-01-01T00:00:00Z', precision: 9 }), '1991');
  assert.equal(wikidataTime({ time: '+1900-01-01T00:00:00Z', precision: 7 }), '1900');
  assert.equal(wikidataTime({ time: '+0500-01-01T00:00:00Z', precision: 9 }), '0500');
  assert.equal(wikidataTime({ time: 'http://www.wikidata.org/.well-known/genid/x', precision: 11 }), '');
  assert.deepEqual(parsePoint('Point(73.242439 34.169308)'), [73.242439, 34.169308]);
  assert.equal(parsePoint('nonsense'), null);
  assert.equal(formatterUrl('https://viaf.org/en/viaf/$1', '97678624'), 'https://viaf.org/en/viaf/97678624');
  assert.equal(formatterUrl('https://commons.wikimedia.org/wiki/File:$1', 'A b/c.jpg'), 'https://commons.wikimedia.org/wiki/File:A%20b/c.jpg');
});

test('topic facts use labels, dates and positions', async () => {
  const t = await explore().topic('Q1317');
  assert.equal(t.label, 'Osama bin Laden');
  assert.equal(t.isHuman, true);
  assert.deepEqual(t.types, ['human']);
  assert.deepEqual(t.dates, { start: '1957-03-10', end: '2011-05-02', kind: 'life' });
  assert.equal(t.coord, null);
  const fact = p => t.facts.find(f => f.property === p);
  assert.deepEqual(fact('P569'), { property: 'P569', label: 'date of birth', values: [{ text: '1957-03-10', date: '1957-03-10' }] });
  assert.equal(fact('P19').values[0].text, 'Riyadh');
  assert.deepEqual(round2(fact('P19').values[0].coord), [46.72, 24.64]);
  assert.deepEqual(fact('P27').values.map(v => v.text), ['Saudi Arabia'], 'the deprecated citizenship is left out');
  assert.equal(fact('P2048').values[0].text, '195 centimetre');
  assert.equal(fact('P214'), undefined, 'database IDs are links, not facts');
  assert.equal(fact('P856'), undefined);
  assert.deepEqual(t.facts.slice(0, 5).map(f => f.property), ['P31', 'P569', 'P19', 'P570', 'P20'], 'facts follow the fixed reading order');
  assert.equal(t.wikipedia.url, 'https://en.wikipedia.org/wiki/Osama_bin_Laden');
  assert.match(t.wikipedia.extract, /^Osama bin Laden was the founder/);
  assert.deepEqual(t.errors, {});
});

test('links: formatter URLs, official site first, all Wikipedia sources', async () => {
  const { links } = await explore().topic('Q1317');
  assert.deepEqual(links.databases[0], { url: 'https://example.org/official', label: 'official website', note: '' });
  assert.deepEqual(links.databases.find(l => l.label === 'VIAF cluster ID'), { url: 'https://viaf.org/en/viaf/97678624', label: 'VIAF cluster ID', note: '97678624' });
  assert.deepEqual(links.references.map(l => l.url), [
    'http://www.spiegel.de/international/world/0,1518,544921,00.html',
    'https://www.fbi.gov/wanted/topten/usama-bin-laden',
    'https://www.9-11commission.gov/report/911Report.pdf',
  ]);
  assert.deepEqual(links.languages.map(l => l.url), ['https://en.wikipedia.org/wiki/Osama_bin_Laden', 'https://fr.wikipedia.org/wiki/Oussama_ben_Laden']);
});

test('events: dated items only, one row per item, positions from the item or its place', async () => {
  const events = await explore().events('Q1317');
  assert.deepEqual(events.map(e => e.label), ['History of the United States (1991–2008)', 'September 11 attacks', 'killing of Osama bin Laden']);
  const [history, sept11, killing] = events;
  assert.deepEqual([history.date, history.endDate, history.coord], ['1991', '2008', null]);
  assert.deepEqual(round2(sept11.coord), [-74.01, 40.71], 'a place with a position wins over one without');
  assert.equal(sept11.place, 'New York City');
  assert.deepEqual({ id: killing.id, date: killing.date, coord: round2(killing.coord) }, { id: 'Q19085', date: '2011-05-02', coord: [73.24, 34.17] });
});

test('topic without an English article', async () => {
  const t = await explore().topic('Q99');
  assert.equal(t.wikipedia, null);
  assert.equal(t.errors.wikipedia, undefined);
  assert.deepEqual(t.coord, [-0.12, 51.5]);
  assert.deepEqual(t.links.references, []);
  await assert.rejects(explore().topic('Q404'), e => e.status === 404);
});

test('a failing source does not blank the topic', async () => {
  const noSparql = async (url, init) => { if (url.startsWith('https://query.wikidata.org/')) throw new Error('timeout'); return fakeFetch(url, init); };
  const t = await explore(noSparql).topic('Q1317');
  assert.deepEqual(t.facts.find(f => f.property === 'P19').values[0], { text: 'Q3692', id: 'Q3692' });
  assert.match(t.errors.labels, /timeout/);
  assert.ok(t.wikipedia, 'Wikipedia still loads');
  await assert.rejects(explore(noSparql).events('Q1317'), e => e.status === 502 && /timeout/.test(e.message));
});

test('big topics: related events are a separate, bounded look-up that never holds up the topic page', async () => {
  const bodies = [];
  const spy = async (url, init) => { if (init?.body) bodies.push(decodeURIComponent(init.body)); return fakeFetch(url, init); };
  const x = explore(spy);
  const t = await x.topic('Q1317');
  assert.equal('events' in t, false, 'the topic answer does not wait for events');
  assert.equal(bodies.some(b => b.includes('timePrecision')), false);
  await x.events('Q1317');
  const query = bodies.find(b => b.includes('timePrecision'));
  assert.match(query, /VALUES \?p \{[^}]*wdt:P710[^}]*wdt:P276[^}]*\}/, 'only properties that tie an event to the topic');
  assert.doesNotMatch(query, /wikibase:directClaim/, 'never every item that mentions the topic (millions for a country)');
  assert.match(query, /LIMIT 600\s*$/);
  await x.events('Q1317');
  assert.equal(bodies.filter(b => b.includes('timePrecision')).length, 1, 'events are cached');
});

test('large topics are chunked and capped', async () => {
  assert.deepEqual(chunk(Array.from({ length: 650 }, (_, i) => i), 300).map(c => c.length), [300, 300, 50]);
  let pages = 0;
  const many = async (url, init) => {
    const u = new URL(url);
    if (u.searchParams.get('prop') === 'extlinks') {
      const n = pages++;
      const extlinks = Array.from({ length: 500 }, (_, i) => ({ url: `https://example.org/${n}/${i}` }));
      return { status: 200, text: JSON.stringify({ continue: { elcontinue: String(n + 1) }, query: { pages: [{ extlinks }] } }) };
    }
    return fakeFetch(url, init);
  };
  const t = await explore(many).topic('Q1317');
  assert.equal(t.links.references.length, 5000);
  assert.equal(pages, 10, 'stops asking once 5,000 links are collected');
});

test('news is spaced, backs off on 429 and is cached', async () => {
  const c = clock();
  let calls = 0, busy = false;
  const gdelt = async (url, init) => { calls++; return busy ? { status: 429, text: 'Please limit requests to one every 5 seconds.' } : fakeFetch(url, init); };
  const x = explore(gdelt, c);
  const first = await x.news('Osama bin Laden');
  assert.deepEqual(first.articles.map(a => [a.title, a.date, a.domain]), [['Twenty years after Abbottabad', '2026-05-01', 'news.example.com'], ['Archive release on bin Laden documents', '2025-11-02', 'news.example.org']]);
  await x.news('al-Qaeda');
  assert.ok(c.slept.at(-1) >= 5500, `waited ${c.slept.at(-1)} ms between GDELT requests`);
  assert.equal(calls, 2);
  await x.news('Osama bin Laden');
  assert.equal(calls, 2, 'the same query within 6 hours comes from the cache');

  busy = true;
  c.t += 10_000;
  assert.deepEqual(await x.news('Abbottabad'), { articles: [], busy: true, retryAfter: 30 });
  c.t += 10_000;
  assert.deepEqual(await x.news('Abbottabad'), { articles: [], busy: true, retryAfter: 20 });
  assert.equal(calls, 3, 'no request while backing off');
  c.t += 21_000;
  assert.equal((await x.news('Abbottabad')).retryAfter, 60, 'a second refusal backs off longer');
  busy = false;
  c.t += 61_000;
  assert.equal((await x.news('Abbottabad')).articles.length, 2);
  busy = true;
  c.t += 10_000;
  assert.equal((await x.news('Jalalabad')).retryAfter, 30, 'a success resets the back-off');
});

test('news query is quoted safely', async () => {
  const urls = [];
  const x = explore(async (url, init) => { urls.push(url); return url.includes('notjson') ? { status: 200, text: 'Your search contained a phrase that was too short.' } : fakeFetch(url, init); });
  await x.news('"bin laden"');
  assert.match(urls[0], /query=%22bin%20laden%22&/);
  assert.match(urls[0], /startdatetime=20170101000000/);
  await x.news('أسامة بن لادن');
  assert.match(urls[1], /query=%22%D8%A3/);
  assert.deepEqual(await x.news('notjson'), { articles: [], error: 'Your search contained a phrase that was too short.' });
});

test('the real upstream client only talks HTTPS to the allowed hosts', async () => {
  const { defaultFetchText } = await import('../server/explore.mjs');
  await assert.rejects(defaultFetchText('https://evil.example/x'), /does not contact evil\.example/);
  await assert.rejects(defaultFetchText('http://en.wikipedia.org/w/api.php'), /does not contact http:\/\/en\.wikipedia\.org/);
});

test('links never carry script or other non-web addresses', async () => {
  const vandalised = async (url, init) => {
    const r = await fakeFetch(url, init);
    if (url.includes('wbgetentities')) return { ...r, text: r.text.replace('https://example.org/official', 'javascript:alert(1)').replace('https://fr.wikipedia.org/wiki/Oussama_ben_Laden', 'data:text/html,hi') };
    if (String(init?.body || '').includes('P1630')) return { ...r, text: r.text.replace('https://viaf.org/en/viaf/$1', 'javascript:alert(\\"$1\\")') };
    return r;
  };
  const { links } = await explore(vandalised).topic('Q1317');
  const all = [...links.databases, ...links.references, ...links.languages].map(l => l.url);
  assert.ok(all.length > 0);
  assert.deepEqual(all.filter(u => !/^https?:\/\//i.test(u)), []);
  assert.equal(links.databases.some(l => l.label === 'VIAF cluster ID'), false);
});

// A topic as large as a country: 650 properties and 650 linked items.
function bigTopicFetch(log) {
  const claims = {};
  for (let i = 1; i <= 650; i++) claims[`P${1000 + i}`] = [{ rank: 'normal', mainsnak: { snaktype: 'value', property: `P${1000 + i}`, datatype: 'wikibase-item', datavalue: { type: 'wikibase-entityid', value: { id: `Q${5000 + i}` } } } }];
  let active = 0;
  return async (url, init) => {
    if (url.includes('wbgetentities')) return { status: 200, text: JSON.stringify({ entities: { Q668: { id: 'Q668', labels: { en: { value: 'India' } }, descriptions: {}, aliases: {}, claims, sitelinks: {} } } }) };
    if (url.startsWith('https://query.wikidata.org/')) {
      active++; log.max = Math.max(log.max, active);
      const body = decodeURIComponent(String(init.body));
      log.kinds.push(body.includes('P1630') ? 'properties' : 'items');
      await new Promise(r => setTimeout(r, 20));
      active--;
      const ids = body.match(/wd:[PQ]\d+/g).map(x => x.slice(3));
      const bindings = ids.map(id => (id.startsWith('P') ? { p: { value: `http://www.wikidata.org/entity/${id}` }, pLabel: { value: `label ${id}` } } : { i: { value: `http://www.wikidata.org/entity/${id}` }, iLabel: { value: `item ${id}` } }));
      return { status: 200, text: JSON.stringify({ results: { bindings } }) };
    }
    return fakeFetch(url, init);
  };
}

test('label look-ups for a big topic run in parallel, never more than 4 at once', async () => {
  const log = { max: 0, kinds: [] };
  const t = await createExplore({ fetchText: bigTopicFetch(log), log: () => {} }).topic('Q668');
  assert.equal(log.kinds.length, 6, 'three batches of properties and three of items');
  assert.ok(log.max >= 3, `batches of the same kind overlap too (max ${log.max} at once)`);
  assert.ok(log.max <= 4, `at most 4 queries at once (saw ${log.max})`);
  assert.equal(t.facts.find(f => f.property === 'P1650').values[0].text, 'item Q5650');
});

test('property names are remembered between topics', async () => {
  const log = { max: 0, kinds: [] };
  const c = clock();
  const x = createExplore({ fetchText: bigTopicFetch(log), now: c.now, sleep: c.sleep, log: () => {} });
  await x.topic('Q668');
  c.t += 25 * 3600 * 1000; // the topic itself has expired from the cache
  log.kinds = [];
  await x.topic('Q668');
  assert.deepEqual(log.kinds, ['items', 'items', 'items'], 'only item labels are fetched again');
});

test('a value repeated in several statements is shown once', async () => {
  const repeated = async (url, init) => {
    const r = await fakeFetch(url, init);
    if (!url.includes('wbgetentities')) return r;
    const data = JSON.parse(r.text);
    const p463 = data.entities.Q1317.claims.P463;
    p463.push(structuredClone(p463[0]), structuredClone(p463[0]));
    return { ...r, text: JSON.stringify(data) };
  };
  const t = await explore(repeated).topic('Q1317');
  assert.deepEqual(t.facts.find(f => f.property === 'P463').values.map(v => v.text), ['Al-Qaeda']);
});

// ---------- Search around ----------
const group = (n, key) => n.groups.find(g => g.key === key);

test('neighbours group outgoing facts and incoming roles, typed and directed', async () => {
  const n = await explore().neighbors('Q1317');
  assert.equal(n.label, 'Osama bin Laden');
  assert.deepEqual(group(n, 'out:P463').items.map(i => [i.id, i.label, i.kind]), [['Q34490', 'Al-Qaeda', 'Organisation']]);
  assert.equal(group(n, 'out:P463').relation, 'member of');
  assert.equal(group(n, 'out:P463').direction, 'out');
  assert.deepEqual(group(n, 'out:P19').items.map(i => [i.label, i.kind, i.description]), [['Riyadh', 'Place', 'capital of Saudi Arabia']]);
  assert.deepEqual(group(n, 'in:P533').items.map(i => [i.label, i.kind]), [['killing of Osama bin Laden', 'Historical event']]);
  assert.equal(group(n, 'in:P533').direction, 'in');
  assert.equal(group(n, 'in:P50').items[0].kind, 'Source');
  assert.equal(group(n, 'out:P31'), undefined, '“instance of human” is not a connection');
  assert.ok(n.groups.every(g => g.items.every(i => i.id !== 'Q1317')), 'the topic is not its own neighbour');
  assert.deepEqual(n.groups.slice(0, 3).map(g => g.direction), ['out', 'out', 'out'], 'outgoing groups come first');
  assert.equal(n.capped, false);
  assert.deepEqual(n.errors, {});
  assert.deepEqual(Object.keys(group(n, 'out:P463').items[0]).sort(), ['description', 'id', 'kind', 'label']);
});

test('nodeKind follows the spec order', () => {
  assert.equal(nodeKind({ isHuman: true, types: ['politician'] }), 'Actor');
  assert.equal(nodeKind({ types: ['terrorist organization'] }), 'Organisation');
  assert.equal(nodeKind({ types: ['armed forces'] }), 'Organisation');
  assert.equal(nodeKind({ types: ['war'] }), 'Historical event');
  assert.equal(nodeKind({ types: ['software'] }), 'Note', 'whole words only: “software” is not a war');
  assert.equal(nodeKind({ types: ['statement'] }), 'Note', 'whole words only: “statement” is not a state');
  assert.equal(nodeKind({ types: [], hasDate: true }), 'Historical event');
  assert.equal(nodeKind({ types: ['sovereign state'] }), 'Place');
  assert.equal(nodeKind({ types: [], hasCoord: true }), 'Place');
  assert.equal(nodeKind({ types: ['written work'] }), 'Source');
  assert.equal(nodeKind({ types: ['profession'] }), 'Note');
});

test('incoming links are capped and flagged', async () => {
  const many = async (url, init) => {
    if (String(init?.body || '').startsWith(encodeURIComponent('#atlas:incoming').replace(/^/, 'query='))) {
      const bindings = Array.from({ length: 300 }, (_, i) => ({ item: { value: `http://www.wikidata.org/entity/Q${900000 + i}` }, itemLabel: { value: `Thing ${i}` }, p: { value: 'http://www.wikidata.org/prop/direct/P276' } }));
      return { status: 200, text: JSON.stringify({ results: { bindings } }) };
    }
    return fakeFetch(url, init);
  };
  const n = await explore(many).neighbors('Q1317');
  assert.equal(n.capped, true);
  assert.equal(group(n, 'in:P276').items.length, 300);
});

test('a failed details lookup still returns the connections', async () => {
  const noDetails = async (url, init) => { if (decodeURIComponent(String(init?.body || '')).startsWith('query=#atlas:neighbors')) throw new Error('timeout'); return fakeFetch(url, init); };
  const n = await explore(noDetails).neighbors('Q1317');
  assert.match(n.errors.details, /timeout/);
  assert.ok(group(n, 'out:P463') && group(n, 'in:P533'));
  assert.ok(n.groups.every(g => g.items.every(i => i.kind === 'Note')));
});

test('search around skips personal attributes and protected characteristics', async () => {
  const item = (p, id) => ({ rank: 'normal', mainsnak: { snaktype: 'value', property: p, datatype: 'wikibase-item', datavalue: { type: 'wikibase-entityid', value: { id } } } });
  const withAttributes = async (url, init) => {
    const r = await fakeFetch(url, init);
    if (!url.includes('wbgetentities')) return r;
    const data = JSON.parse(r.text);
    Object.assign(data.entities.Q1317.claims, { P21: [item('P21', 'Q6581097')], P140: [item('P140', 'Q432')], P172: [item('P172', 'Q35323')], P91: [item('P91', 'Q1035954')], P1340: [item('P1340', 'Q17122705')], P1884: [item('P1884', 'Q2367101')], P552: [item('P552', 'Q3039938')], P734: [item('P734', 'Q4913780')], P735: [item('P735', 'Q2621553')], P1412: [item('P1412', 'Q13955')], P103: [item('P103', 'Q13955')], P1347: [item('P1347', 'Q210167')] });
    return { ...r, text: JSON.stringify(data) };
  };
  const n = await explore(withAttributes).neighbors('Q1317');
  const keys = n.groups.map(g => g.key);
  for (const p of ['P21', 'P140', 'P172', 'P91', 'P1340', 'P1884', 'P552', 'P734', 'P735', 'P1412', 'P103', 'P1347']) assert.ok(!keys.includes(`out:${p}`), `${p} is not offered as a connection`);
  assert.ok(keys.includes('out:P463'), 'real connections are still there');
});

test('fresh reads skip the cache, and redirected items are reported', async () => {
  let entityCalls = 0, gdeltCalls = 0;
  const counting = async (url, init) => {
    const u = new URL(url);
    if (u.searchParams.get('action') === 'wbgetentities' && u.searchParams.get('ids') === 'Q1317') entityCalls++;
    if (u.hostname === 'api.gdeltproject.org') gdeltCalls++;
    if (u.searchParams.get('action') === 'wbgetentities' && u.searchParams.get('ids') === 'Q5') {
      return { status: 200, text: JSON.stringify({ entities: { Q6: { id: 'Q6', redirects: { from: 'Q5', to: 'Q6' }, labels: { en: { value: 'Six' } }, descriptions: {}, claims: {} } } }) };
    }
    return fakeFetch(url, init);
  };
  const x = explore(counting);
  await x.topic('Q1317');
  await x.topic('Q1317');
  assert.equal(entityCalls, 1, 'the second read comes from the cache');
  await x.topic('Q1317', { fresh: true });
  assert.equal(entityCalls, 2, 'a fresh read asks Wikidata again');
  const six = await x.topic('Q5');
  assert.equal(six.redirectedTo, 'Q6');
  assert.equal(six.label, 'Six');
  assert.equal((await x.topic('Q1317')).redirectedTo, undefined);
  await x.news('watch test');
  await x.news('watch test');
  assert.equal(gdeltCalls, 1);
  await x.news('watch test', undefined, { fresh: true });
  assert.equal(gdeltCalls, 2);
});
