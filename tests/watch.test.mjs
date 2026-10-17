// Watchlists: Wikidata snapshots and differences, new-article detection, the watch service and its schedule. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, normalizeWatchFile, pickNewArticles, snapshotOf } from '../server/watch.mjs';

const topic = (over = {}) => ({
  id: 'Q1', label: 'Osama bin Laden', description: 'founder of al-Qaeda', aliases: ['Usama bin Laden'], errors: {},
  facts: [{ property: 'P31', label: 'instance of', values: [{ text: 'human' }] }, { property: 'P8687', label: 'social media followers', values: [{ text: '100' }] }],
  ...over,
});
const art = (i, language = 'English') => ({ title: `T${i}`, url: `https://n.example/${i}`, domain: 'n.example', date: '2026-10-17', language, country: '' });

test('snapshots keep facts sorted and drop ignored properties', () => {
  const s = snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'B' }, { text: 'A' }, { text: 'A' }] }] }));
  assert.deepEqual(s.facts, { P463: { label: 'member of', values: ['A', 'B'] } });
  assert.ok(!('P8687' in snapshotOf(topic()).facts));
  assert.deepEqual(snapshotOf(topic()).aliases, ['Usama bin Laden']);
});

test('differences between snapshots', () => {
  const a = snapshotOf(topic());
  const b = snapshotOf(topic({
    description: 'Saudi militant', aliases: ['Usama bin Laden', 'UBL'],
    facts: [{ property: 'P31', label: 'instance of', values: [{ text: 'human' }] }, { property: 'P570', label: 'date of death', values: [{ text: '2011-05-02' }] }],
  }));
  assert.deepEqual(diffSnapshots(a, b).map(c => c.text), ['Description changed: “founder of al-Qaeda” → “Saudi militant”', 'Also known as added: UBL', 'date of death added: 2011-05-02']);
  assert.deepEqual(diffSnapshots(a, snapshotOf(topic({ facts: [...topic().facts].reverse() }))), [], 'order does not matter');
  const m = diffSnapshots(snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'X' }] }] })), snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'Y' }] }] })));
  assert.equal(m[0].text, 'member of: removed X; added Y');
  assert.deepEqual([m[0].property, m[0].added, m[0].removed], ['P463', ['Y'], ['X']]);
  assert.equal(diffSnapshots(a, snapshotOf(topic({ label: 'Usama bin Ladin' })))[0].text, 'Label changed: “Osama bin Laden” → “Usama bin Ladin”');
  const gone = diffSnapshots(snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'X' }] }] })), a);
  assert.deepEqual(gone.map(c => c.text), ['instance of added: human', 'member of removed: X']);
});

test('new articles: baseline, English only and caps', () => {
  const first = pickNewArticles([], [art(1), art(2)], { baseline: true });
  assert.deepEqual(first.fresh, []);
  assert.deepEqual(first.seenUrls, ['https://n.example/1', 'https://n.example/2']);
  const next = pickNewArticles(first.seenUrls, [art(3), art(4, 'French'), art(1)], { englishOnly: true });
  assert.deepEqual(next.fresh.map(a => a.title), ['T3']);
  assert.equal(next.seenUrls[0], 'https://n.example/3');
  assert.ok(!next.seenUrls.includes('https://n.example/4'), 'a skipped French article is not marked seen');
  const many = Array.from({ length: 80 }, (_, i) => art(100 + i));
  assert.equal(pickNewArticles([], many).fresh.length, 50);
  assert.equal(pickNewArticles(Array.from({ length: 1000 }, (_, i) => `https://old/${i}`), [art(9)]).seenUrls.length, 1000);
});

test('watch files are normalised', () => {
  assert.deepEqual(normalizeWatchFile('junk'), { format: 'atlas-watch', version: 1, settings: { intervalHours: 6 }, watches: [], alerts: [] });
  assert.equal(normalizeWatchFile({ settings: { intervalHours: 5 } }).settings.intervalHours, 6);
  assert.equal(normalizeWatchFile({ settings: { intervalHours: 0 } }).settings.intervalHours, 0);
  assert.equal(normalizeWatchFile({ watches: [{ id: 'w', kind: 'keyword', label: 'x', query: 'x' }, { kind: 'nope' }, null] }).watches.length, 1);
  assert.equal(normalizeWatchFile({ alerts: [{ id: 'a', watchId: 'w', at: '2026-10-17T00:00:00Z', kind: 'news', seen: false }, { id: 'b' }] }).alerts.length, 1);
});

// ---------- the service ----------
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWatch } from '../server/watch.mjs';

function fakeExplore() {
  const x = { feed: {}, topics: {}, newsCalls: [], topicCalls: [], newsAnswer: null, topicAnswer: {}, gate: null };
  x.news = async (q, before, opts) => { x.newsCalls.push([q, opts]); if (x.gate) await x.gate; return x.newsAnswer ? x.newsAnswer(q) : { articles: x.feed[q] || [] }; };
  x.topic = async (qid, opts) => {
    x.topicCalls.push([qid, opts]);
    if (x.topicAnswer[qid]) return x.topicAnswer[qid]();
    if (!x.topics[qid]) throw Object.assign(new Error(`Wikidata has no item ${qid}.`), { status: 404 });
    return x.topics[qid];
  };
  return x;
}
async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atlas-watch-'));
  const ex = fakeExplore(), clock = { t: Date.parse('2026-10-17T00:00:00Z') }, fired = { every: [], after: [] };
  const timers = { every: (fn, ms) => { fired.every.push({ fn, ms }); return fired.every.length; }, after: (fn, ms) => { fired.after.push({ fn, ms }); return 0; }, clear: () => {} };
  const make = () => createWatch({ dataDir, explore: ex, now: () => clock.t, timers, log: () => {} });
  const w = make();
  await w.init();
  const round = async id => { const r = w.check(id); await w.idle(); return r; };
  return { w, ex, clock, fired, dataDir, round, make };
}
const statusOf = async p => { try { await p; return 200; } catch (e) { return e.status; } };
const watchOf = (w, id) => w.list().watches.find(x => x.id === id);

test('adding watches: validation, duplicates and the limit', async () => {
  const { w } = await setup();
  const k = await w.add({ kind: 'keyword', label: 'Sudan ceasefire' });
  assert.equal(k.query, 'Sudan ceasefire');
  assert.equal(await statusOf(w.add({ kind: 'keyword', label: 'Other', query: 'sudan  CEASEFIRE' })), 409);
  await w.add({ kind: 'entity', label: 'Osama bin Laden', qid: 'Q1317' });
  assert.equal(await statusOf(w.add({ kind: 'entity', label: 'OBL', qid: 'Q1317' })), 409);
  assert.equal(await statusOf(w.add({ kind: 'entity', label: 'x', qid: 'X1' })), 400);
  assert.equal(await statusOf(w.add({ kind: 'keyword', label: '' })), 400);
  assert.equal(await statusOf(w.add({ kind: 'keyword', label: 'x'.repeat(201) })), 400);
  assert.equal(await statusOf(w.add({ kind: 'other', label: 'x' })), 400);
  for (let i = 0; i < 98; i++) await w.add({ kind: 'keyword', label: `topic ${i}` });
  const err = await w.add({ kind: 'keyword', label: 'one too many' }).catch(e => e);
  assert.equal(err.status, 409);
  assert.match(err.message, /at most 100 watches/);
});

test('a round makes a baseline first, then news and Wikidata alerts', async () => {
  const { w, ex, round } = await setup();
  ex.topics.Q1 = topic();
  ex.feed['Osama bin Laden'] = [art(1)];
  ex.feed['Sudan ceasefire'] = [art(2)];
  const e = await w.add({ kind: 'entity', label: 'Osama bin Laden', qid: 'Q1' });
  await w.add({ kind: 'keyword', label: 'Sudan ceasefire' });
  assert.deepEqual(await round(), { started: true });
  assert.equal(w.list().alerts.length, 0, 'the first check only records a baseline');
  assert.ok(watchOf(w, e.id).lastCheckedAt);
  assert.ok(ex.newsCalls.every(([, o]) => o?.fresh === true) && ex.topicCalls.every(([, o]) => o?.fresh === true), 'checks bypass the cache');
  ex.feed['Osama bin Laden'] = [art(3), art(1)];
  ex.topics.Q1 = topic({ facts: [...topic().facts, { property: 'P570', label: 'date of death', values: [{ text: '2011-05-02' }] }] });
  await round();
  const alerts = w.list().alerts;
  assert.deepEqual(alerts.map(a => a.kind).sort(), ['news', 'wikidata']);
  assert.equal(alerts.find(a => a.kind === 'news').news.url, 'https://n.example/3');
  assert.equal(alerts.find(a => a.kind === 'wikidata').change.text, 'date of death added: 2011-05-02');
  assert.ok(alerts.every(a => a.watchId === e.id && !a.seen));
  assert.equal(w.summary().unseen, 2);
  assert.equal(watchOf(w, e.id).unseen, 2);
  assert.ok(!('seenUrls' in watchOf(w, e.id)) && !('snapshot' in watchOf(w, e.id)), 'internal state stays on the host');
});

test('failures leave the state alone and are reported', async () => {
  const { w, ex, round } = await setup();
  ex.topics.Q1 = topic();
  ex.feed.a = [art(1)];
  const a = await w.add({ kind: 'entity', label: 'a', qid: 'Q1' });
  const b = await w.add({ kind: 'keyword', label: 'b' });
  await round();
  ex.newsAnswer = () => ({ articles: [], busy: true, retryAfter: 30 });
  ex.newsCalls.length = 0;
  ex.topicAnswer.Q1 = async () => { throw Object.assign(new Error('timeout'), { status: 502 }); };
  await round();
  assert.equal(ex.newsCalls.length, 1, 'after GDELT refuses, the rest of the round skips news');
  assert.match(watchOf(w, a.id).lastError, /GDELT is limiting requests; will retry next round/);
  assert.match(watchOf(w, a.id).lastError, /Wikidata/);
  assert.match(watchOf(w, b.id).lastError, /GDELT is limiting requests/);
  ex.newsAnswer = null;
  ex.topicAnswer.Q1 = async () => ({ ...topic({ description: 'changed' }), errors: { labels: 'timeout' } });
  ex.feed.a = [art(1)];
  await round();
  assert.equal(w.list().alerts.length, 0, 'no alerts from a failed or partial answer, and the baseline was kept');
  assert.match(watchOf(w, a.id).lastError, /only in part/);
  delete ex.topicAnswer.Q1;
  await round();
  assert.equal(watchOf(w, a.id).lastError, undefined, 'a later success clears the error');
  assert.equal(w.list().alerts.length, 0);
});

test('missing and merged Wikidata items', async () => {
  const { w, ex, round } = await setup();
  ex.topics.Q1 = topic();
  ex.topics.Q7 = topic({ id: 'Q7' });
  const gone = await w.add({ kind: 'entity', label: 'gone', qid: 'Q1' });
  const merged = await w.add({ kind: 'entity', label: 'merged', qid: 'Q7' });
  await round();
  delete ex.topics.Q1;
  ex.topics.Q7 = { ...topic({ id: 'Q8' }), redirectedTo: 'Q8' };
  ex.topics.Q8 = topic({ id: 'Q8' });
  await round();
  const texts = w.list().alerts.map(a => a.change.text).sort();
  assert.deepEqual(texts, ['Wikidata item Q1 no longer exists', 'Wikidata item Q7 was merged into Q8']);
  assert.equal(watchOf(w, merged.id).qid, 'Q8');
  ex.topicCalls.length = 0;
  await round();
  assert.ok(!ex.topicCalls.some(([q]) => q === 'Q1'), 'a missing item is not asked for again');
  assert.equal(w.list().alerts.length, 2);
  assert.match(watchOf(w, gone.id).lastError, /no longer exists/);
});

test('editing the phrase restarts the baseline; paused watches are skipped', async () => {
  const { w, ex, round } = await setup();
  ex.feed.old = [art(1)];
  ex.feed.new = [art(5), art(6)];
  const k = await w.add({ kind: 'keyword', label: 'k', query: 'old' });
  await round();
  await w.update(k.id, { query: 'new' });
  await round();
  assert.equal(w.list().alerts.length, 0, 'the new phrase starts with a baseline');
  await w.update(k.id, { paused: true });
  ex.newsCalls.length = 0;
  await round();
  assert.equal(ex.newsCalls.length, 0);
  assert.equal(await statusOf(w.update('nope', { paused: false })), 404);
  assert.equal(await statusOf(w.update(k.id, { query: '' })), 400);
});

test('check during a round, removal during a round', async () => {
  const { w, ex, dataDir } = await setup();
  ex.feed.one = [art(1)];
  ex.feed.two = [art(2)];
  await w.add({ kind: 'keyword', label: 'one' });
  const two = await w.add({ kind: 'keyword', label: 'two' });
  let release;
  ex.gate = new Promise(r => { release = r; });
  assert.deepEqual(w.check(), { started: true });
  assert.deepEqual(w.check(), { started: false, reason: 'already checking' });
  assert.equal(w.status().running, true);
  await new Promise(r => setTimeout(r, 10));
  await w.remove(two.id);
  release();
  await w.idle();
  const saved = JSON.parse(await readFile(path.join(dataDir, 'watch.json'), 'utf8'));
  assert.ok(!saved.watches.some(x => x.id === two.id), 'a watch removed during a round stays removed');
  assert.deepEqual(ex.newsCalls.map(([q]) => q), ['one']);
  assert.equal(await statusOf(w.remove(two.id)), 404);
});

test('alert cap and marking seen', async () => {
  const { w, dataDir, make } = await setup();
  const k = await w.add({ kind: 'keyword', label: 'k' });
  const file = JSON.parse(await readFile(path.join(dataDir, 'watch.json'), 'utf8'));
  file.alerts = Array.from({ length: 510 }, (_, i) => ({ id: `a${i}`, watchId: k.id, at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), kind: 'news', news: { title: `t${i}`, url: `https://x/${i}` }, seen: i < 20 }));
  await writeFile(path.join(dataDir, 'watch.json'), JSON.stringify(file));
  const w2 = make();
  await w2.init();
  const ids = w2.list().alerts.map(a => a.id);
  assert.equal(ids.length, 500);
  assert.ok(!ids.includes('a0') && !ids.includes('a9') && ids.includes('a10') && ids.includes('a509'), 'the oldest seen alerts go first');
  assert.equal(ids[0], 'a509', 'newest first');
  assert.deepEqual(await w2.markSeen({ ids: ['a509', 'a508'] }), { unseen: 488 });
  assert.deepEqual(await w2.markSeen({ watchId: k.id }), { unseen: 0 });
  assert.equal(await statusOf(w2.markSeen({})), 400);
  assert.deepEqual(await w2.markSeen({ all: true }), { unseen: 0 });
});

test('schedule: overdue on start, interval and manual-only', async () => {
  const { w, ex, clock, fired } = await setup();
  ex.feed.k = [art(1)];
  await w.add({ kind: 'keyword', label: 'k' });
  w.start();
  assert.deepEqual(fired.after.map(f => f.ms), [30000]);
  assert.deepEqual(fired.every.map(f => f.ms), [60000]);
  fired.after[0].fn();
  await w.idle();
  assert.equal(ex.newsCalls.length, 1, 'never checked, so a round starts shortly after start-up');
  clock.t += 5 * 3600000;
  fired.every[0].fn();
  await w.idle();
  assert.equal(ex.newsCalls.length, 1, 'not due yet');
  clock.t += 3600000;
  fired.every[0].fn();
  await w.idle();
  assert.equal(ex.newsCalls.length, 2, 'six hours later it runs');
  assert.equal(Date.parse(w.status().nextRoundAt) - clock.t, 6 * 3600000);
  await w.setSettings({ intervalHours: 0 });
  clock.t += 48 * 3600000;
  fired.every[0].fn();
  await w.idle();
  assert.equal(ex.newsCalls.length, 2, 'manual only');
  assert.equal(w.status().nextRoundAt, null);
  assert.equal(await statusOf(w.setSettings({ intervalHours: 5 })), 400);
  w.stop();
});

test('the file survives a restart, and a corrupt file is set aside', async () => {
  const { w, dataDir, make } = await setup();
  await w.add({ kind: 'keyword', label: 'kept' });
  const again = make();
  await again.init();
  assert.deepEqual(again.list().watches.map(x => x.label), ['kept']);
  await writeFile(path.join(dataDir, 'watch.json'), 'not json');
  const fresh = make();
  await fresh.init();
  assert.equal(fresh.list().watches.length, 0);
  assert.ok((await readdir(dataDir)).some(f => f.startsWith('watch.json.corrupt-')));
});

// ---------- app helpers ----------
import { ago, alertDay, findWatch } from '../src/watch.ts';

test('client helpers', () => {
  assert.equal(findWatch([{ id: 'a', qid: 'Q1', query: 'x', label: 'x' }], { qid: 'Q1' }).id, 'a');
  assert.equal(findWatch([{ id: 'a', qid: 'Q1', query: 'x', label: 'x' }], { qid: 'Q2', query: 'x' }), undefined, 'an entity is matched by its Wikidata ID only');
  assert.equal(findWatch([{ id: 'b', query: 'Sudan  ceasefire', label: 's' }], { query: '“sudan ceasefire”' }).id, 'b');
  assert.equal(findWatch([], { query: 'x' }), undefined);
  const now = Date.parse('2026-10-17T12:05:00Z');
  assert.equal(ago('2026-10-17T12:04:40Z', now), 'just now');
  assert.equal(ago('2026-10-17T11:50:00Z', now), '15 min ago');
  assert.equal(ago('2026-10-17T10:00:00Z', now), '2 h ago');
  assert.equal(ago('2026-10-14T10:00:00Z', now), '3 days ago');
  assert.equal(ago('', now), 'never');
  assert.equal(alertDay('2026-10-17T09:00:00Z', now), 'Today');
  assert.equal(alertDay('2026-10-16T09:00:00Z', now), 'Yesterday');
  assert.equal(alertDay('2026-10-01T09:00:00Z', now), '2026-10-01');
});
