// End to end: starts the real host on a free port with a temporary data folder. Run with: npm.cmd test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProjects } from '../src/model.ts';
import { applyRemote, applySaved, baselineFrom, conflictFor, conflictMessage, diffRemote, planSave } from '../src/sync.ts';
import { fileKey } from '../server/store.mjs';
import { emptyBoard, ucdpRecords } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
after(() => { for (const c of children) c.kill(); });

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}
async function startHost(dataDir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/host.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), ATLAS_DATA_DIR: dataDir, ATLAS_BIND: '127.0.0.1', ATLAS_ACCESS_CODE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { out += d; if (out.includes('host is running')) resolve(); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', code => reject(new Error(`host exited (${code}): ${out}`)));
  });
  return { base: `http://127.0.0.1:${port}`, port, output: () => out };
}
const getJson = async (base, p) => { const r = await fetch(base + p); return { status: r.status, data: await r.json() }; };
async function put(base, p, body, method = 'PUT') {
  const text = JSON.stringify(body);
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: text });
  return { status: r.status, data: await r.json(), sent: Buffer.byteLength(text) };
}
const boardUrl = (pid, bid) => `/api/boards/${encodeURIComponent(pid)}/${encodeURIComponent(bid)}`;
/** What a browser tab does in flush(): send each planned operation, keep the baseline current. */
async function flush(base, projects, baseline) {
  const results = [];
  for (const op of planSave(projects, baseline)) {
    const r = op.kind === 'project' ? await put(base, `/api/projects/${encodeURIComponent(op.pid)}`, { baseRevision: op.baseRevision, project: op.meta })
      : op.kind === 'board' ? await put(base, boardUrl(op.pid, op.bid), { baseRevision: op.baseRevision, board: op.board })
      : await put(base, boardUrl(op.pid, op.bid), { baseRevision: op.baseRevision }, 'DELETE');
    if (r.status === 200) applySaved(baseline, op, r.data.revision);
    results.push({ op, ...r });
  }
  return results;
}
async function openDevice(base) {
  const { data } = await getJson(base, '/api/workspace');
  const projects = normalizeProjects(data.projects);
  return { projects, baseline: baselineFrom(projects, data.manifest) };
}
const edit = (projects, bid, fn) => projects.map(p => ({ ...p, boards: p.boards.map(b => (b.id === bid ? fn(b) : b)) }));
function raw(port, p, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

test('a 5,000-record board saves without resending other boards; conflicts are per board', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'atlas-host-'));
  const legacy = [
    { id: 'military-workspace', name: 'Military', description: '', createdAt: '2026-01-01T00:00:00.000Z', boards: [emptyBoard('military-world', 'Global research map')] },
    { id: 'research', name: 'Research', description: '', createdAt: '2026-01-01T00:00:00.000Z', boards: [emptyBoard('ged', 'UCDP GED 2010–2019', ucdpRecords(5000)), emptyBoard('notes', 'Small notes')] },
  ];
  await writeFile(path.join(dataDir, 'projects.json'), JSON.stringify(legacy, null, 2));
  const host = await startHost(dataDir);
  assert.match(host.output(), /converted data\/projects\.json to one file per board \(3 boards\)/);
  const file = bid => path.join(dataDir, 'boards', fileKey('research'), `${fileKey(bid)}.json`);

  // Two devices open the workspace.
  const mac = await openDevice(host.base), ipad = await openDevice(host.base);
  assert.equal(mac.projects[1].boards[0].events.length, 5000);
  const bigBefore = await stat(file('ged'));

  // Mac edits the small board: one small request, and the big board's file is not rewritten.
  mac.projects = edit(mac.projects, 'notes', b => ({ ...b, name: 'Small notes (Mac)' }));
  const [smallSave, ...noMore] = await flush(host.base, mac.projects, mac.baseline);
  assert.equal(noMore.length, 0);
  assert.equal(smallSave.status, 200);
  assert.ok(smallSave.sent < 1000, `small save sent ${smallSave.sent} bytes`);
  assert.equal((await stat(file('ged'))).mtimeMs, bigBefore.mtimeMs, 'the 5,000-record board file was not rewritten');

  // iPad edits the big board at the same time: not a conflict, and the small board is not resent.
  const notesBefore = await readFile(file('notes'), 'utf8');
  ipad.projects = edit(ipad.projects, 'ged', b => ({ ...b, events: b.events.slice(0, 4999) }));
  const t0 = performance.now();
  const bigSaves = await flush(host.base, ipad.projects, ipad.baseline);
  const ms = Math.round(performance.now() - t0);
  assert.deepEqual(bigSaves.map(s => [s.op.bid, s.status]), [['ged', 200]]);
  assert.ok(bigSaves[0].sent > 5_000_000, `big save sent ${bigSaves[0].sent} bytes in ${ms} ms`);
  assert.equal(await readFile(file('notes'), 'utf8'), notesBefore, 'the small board file was not touched');
  console.log(`  5,000-record board: ${(bigSaves[0].sent / 1e6).toFixed(1)} MB saved in ${ms} ms; small board save sent ${smallSave.sent} bytes`);

  // iPad now edits the small board with its stale revision: a conflict that names the board.
  ipad.projects = edit(ipad.projects, 'notes', b => ({ ...b, name: 'Small notes (iPad)' }));
  const [stale] = await flush(host.base, ipad.projects, ipad.baseline);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.reason, 'changed');
  assert.equal(conflictMessage(conflictFor(stale.op, stale.data.reason)), 'Board “Small notes (iPad)” was changed on another device. Your recent edits to it here are not saved yet.');

  // Mac picks up the iPad's big-board save by downloading only that board.
  const { data: manifest } = await getJson(host.base, '/api/workspace/manifest');
  const plan = diffRemote(manifest, mac.baseline, mac.projects);
  assert.deepEqual(plan.fetch, [{ pid: 'research', bid: 'ged' }]);
  const { data: fetched } = await getJson(host.base, boardUrl('research', 'ged'));
  const merged = applyRemote(mac.projects, mac.baseline, manifest, plan, [{ pid: 'research', bid: 'ged', board: fetched.board, revision: fetched.revision }]);
  assert.equal(merged.projects[1].boards[0].events.length, 4999);
  assert.equal(merged.projects[1].boards[1].name, 'Small notes (Mac)');
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(planSave(merged.projects, mac.baseline), []);

  // The workspace endpoints from 0.2 keep working.
  const { data: rev } = await getJson(host.base, '/api/workspace/revision');
  assert.equal(rev.revision, manifest.revision);
  const exported = await getJson(host.base, '/api/export');
  assert.equal(exported.data.format, 'atlas-workspace');
  assert.deepEqual(exported.data.projects[1].boards.map(b => b.name), ['UCDP GED 2010–2019', 'Small notes (Mac)']);
  assert.equal((await put(host.base, '/api/workspace', { baseRevision: 'stale', projects: exported.data.projects })).status, 409);
  assert.ok((await readdir(path.join(dataDir, 'backups'))).some(n => n.startsWith('projects-before-split-')));
});

test('board endpoints keep the LAN access code, private-network and cross-site checks', async () => {
  const host = await startHost(await mkdtemp(path.join(os.tmpdir(), 'atlas-host-')));
  const url = boardUrl('military-workspace', 'military-world');
  assert.equal(await raw(host.port, url, {}), 200, 'this PC needs no code');
  assert.equal(await raw(host.port, url, { 'x-forwarded-for': '192.168.1.50' }), 401, 'a LAN device without the code is refused');
  assert.equal(await raw(host.port, url, { 'x-forwarded-for': '8.8.8.8' }), 403, 'public addresses are refused');
  assert.equal(await raw(host.port, url, { host: 'evil.example:4174' }), 403, 'unknown host names are refused (DNS rebinding)');
  assert.equal(await raw(host.port, url, { origin: 'https://evil.example', 'content-type': 'application/json' }, 'PUT'), 403, 'cross-site writes are refused');
  assert.equal(await raw(host.port, '/api/workspace/manifest', { 'x-forwarded-for': '192.168.1.50' }), 401);
  assert.equal(await raw(host.port, '/api/map/sat/esri/2/9/0', {}), 400, 'tile outside the zoom level');
  assert.equal(await raw(host.port, '/api/map/sat/nope/1/0/0', {}), 400, 'unknown imagery provider');
  assert.equal(await raw(host.port, '/api/map/sat/esri/1/0/0', { 'x-forwarded-for': '192.168.1.50' }), 401, 'imagery also needs the access code');
});

test('explore routes answer from the injected source and keep the access checks', async () => {
  const host = await startHost(await mkdtemp(path.join(os.tmpdir(), 'atlas-host-')), { ATLAS_EXPLORE_FAKE: 'tests/fixtures/explore/fake-fetch.mjs' });
  const search = await getJson(host.base, '/api/explore/search?q=osama%20binladen');
  assert.equal(search.status, 200);
  assert.equal(search.data[0].id, 'Q1317');
  const topic = await getJson(host.base, '/api/explore/topic/Q1317');
  assert.equal(topic.status, 200);
  assert.ok(topic.data.facts.length > 0 && topic.data.links.references.length > 0);
  assert.equal((await getJson(host.base, '/api/explore/topic/Q1317x')).status, 400);
  const events = await getJson(host.base, '/api/explore/events/Q1317');
  assert.equal(events.status, 200);
  assert.ok(events.data.events.some(e => e.label === 'killing of Osama bin Laden'));
  assert.equal((await getJson(host.base, '/api/explore/events/x')).status, 400);
  const around = await getJson(host.base, '/api/explore/neighbors/Q1317');
  assert.equal(around.status, 200);
  assert.ok(around.data.groups.some(g => g.key === 'out:P463'));
  assert.equal((await getJson(host.base, '/api/explore/neighbors/x')).status, 400);
  assert.equal((await getJson(host.base, '/api/explore/search?q=%20')).status, 400);
  assert.equal((await getJson(host.base, `/api/explore/search?q=${'a'.repeat(201)}`)).status, 400);
  assert.equal((await getJson(host.base, '/api/explore/news?q=x&before=2026')).status, 400);
  const news = await getJson(host.base, '/api/explore/news?q=Osama%20bin%20Laden');
  assert.equal(news.status, 200);
  assert.ok(news.data.articles.length > 0);
  assert.equal(await raw(host.port, '/api/explore/search?q=osama', { 'x-forwarded-for': '192.168.1.50' }), 401, 'LAN devices still need the access code');
  const place = await getJson(host.base, '/api/geo/search?q=Abbottabad');
  assert.equal(place.status, 200);
  assert.deepEqual([place.data.places[0].name, place.data.places[0].bbox], ['Abbottabad', [73.15, 34.1, 73.3, 34.25]]);
  assert.match(place.data.attribution, /OpenStreetMap contributors/);
  assert.equal((await getJson(host.base, '/api/geo/search?q=a')).status, 400);
  assert.equal(await raw(host.port, '/api/geo/search?q=Kabul', { 'x-forwarded-for': '192.168.1.50' }), 401, 'place search also needs the access code');

  // upstream failure is a 502
  const offline = await getJson(host.base, '/api/explore/search?q=offline');
  assert.equal(offline.status, 502);
  assert.match(offline.data.error, /could not reach Wikipedia or Wikidata/);
});

test('a project can be deleted over HTTP, but not the default workspace', async () => {
  const host = await startHost(await mkdtemp(path.join(os.tmpdir(), 'atlas-host-')));
  assert.equal((await put(host.base, '/api/projects/px', { baseRevision: 'new', project: { id: 'px', name: 'Scratch', description: '' } })).status, 200);
  assert.equal((await put(host.base, boardUrl('px', 'b1'), { baseRevision: 'new', board: emptyBoard('b1', 'Scratch board') })).status, 200);
  const { data: m } = await getJson(host.base, '/api/workspace/manifest');
  const px = m.projects.find(p => p.id === 'px');
  const del = await put(host.base, '/api/projects/px', { baseRevision: px.revision, boardRevisions: Object.fromEntries(px.boards.map(b => [b.id, b.revision])) }, 'DELETE');
  assert.equal(del.status, 200);
  assert.deepEqual((await getJson(host.base, '/api/workspace/manifest')).data.projects.map(p => p.id), ['military-workspace']);
  const mil = await put(host.base, '/api/projects/military-workspace', { baseRevision: 'x', boardRevisions: {}, force: true }, 'DELETE');
  assert.deepEqual([mil.status, mil.data.reason], [409, 'protected']);
});

test('watch routes keep the access checks and validate input', async () => {
  const host = await startHost(await mkdtemp(path.join(os.tmpdir(), 'atlas-host-')), { ATLAS_EXPLORE_FAKE: 'tests/fixtures/explore/fake-fetch.mjs' });
  const post = (p, body) => put(host.base, p, body, 'POST');
  const added = await post('/api/watch', { kind: 'keyword', label: 'Sudan ceasefire' });
  assert.equal(added.status, 201);
  assert.equal(added.data.query, 'Sudan ceasefire');
  assert.equal((await post('/api/watch', { kind: 'keyword', label: 'Sudan ceasefire' })).status, 409);
  assert.equal((await post('/api/watch', { kind: 'entity', label: 'x', qid: 'nope' })).status, 400);
  let list = await getJson(host.base, '/api/watch');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.watches.map(w => [w.label, w.unseen]), [['Sudan ceasefire', 0]]);
  assert.equal(list.data.settings.intervalHours, 6);
  assert.equal((await put(host.base, '/api/watch/settings', { intervalHours: 5 })).status, 400);
  assert.equal((await put(host.base, '/api/watch/settings', { intervalHours: 24 })).status, 200);
  const started = await post('/api/watch/check', {});
  assert.equal(started.status, 202);
  for (let i = 0; i < 60; i++) {
    list = await getJson(host.base, '/api/watch');
    if (!list.data.status.running) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(list.data.watches[0].lastCheckedAt, 'the check ran against the injected source');
  assert.equal(list.data.watches[0].lastError, undefined);
  const summary = await getJson(host.base, '/api/watch/summary');
  assert.deepEqual(summary.data, { unseen: 0, running: false, watched: [{ id: added.data.id, label: 'Sudan ceasefire', query: 'Sudan ceasefire' }] });
  assert.deepEqual((await post('/api/watch/seen', { all: true })).data, { unseen: 0 });
  assert.equal((await post('/api/watch/seen', { nothing: 1 })).status, 400);
  assert.equal((await put(host.base, `/api/watch/${added.data.id}`, { paused: true })).data.paused, true);
  const backup = await getJson(host.base, '/api/export');
  assert.deepEqual(backup.data.watch.watches.map(w => w.label), ['Sudan ceasefire']);
  assert.ok(!('seenUrls' in backup.data.watch.watches[0]));
  assert.equal(await raw(host.port, '/api/watch', { 'x-forwarded-for': '192.168.1.50' }), 401, 'LAN devices need the access code');
  assert.equal(await raw(host.port, '/api/watch/summary', { 'x-forwarded-for': '192.168.1.50' }), 401);
  assert.equal((await put(host.base, `/api/watch/${added.data.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await put(host.base, `/api/watch/${added.data.id}`, {}, 'DELETE')).status, 404);
});
