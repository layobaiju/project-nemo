// Atlas Windows host: serves the web build, stores workspace data in data/ (an index in projects.json plus
// one file per board, see store.mjs), and proxies the free OpenFreeMap basemap so LAN devices only need to reach this PC.
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createThrottle, generateCode, isAllowedHostHeader, isLoopback, isPrivateAddress, normalizeCode, normalizeIp,
  originMatchesHost, parseCookies, safeEqual, tokenFor,
} from './security.mjs';
import { createStore, stamp, writeAtomic } from './store.mjs';
import { createExplore, defaultFetchText } from './explore.mjs';
import { createGeocoder } from './geocode.mjs';
import { satTileUrl } from './tiles.mjs';
import { createWatch } from './watch.mjs';

const VERSION = '0.8.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const dataDir = process.env.ATLAS_DATA_DIR ? path.resolve(process.env.ATLAS_DATA_DIR) : path.join(root, 'data');
const store = createStore({ dataDir });
// Tests point ATLAS_EXPLORE_FAKE at a module that stands in for Wikipedia, Wikidata and GDELT.
const fakeUpstream = process.env.ATLAS_EXPLORE_FAKE ? (await import(pathToFileURL(path.resolve(root, process.env.ATLAS_EXPLORE_FAKE)).href)).default : null;
const explore = createExplore(fakeUpstream ? { fetchText: fakeUpstream } : {});
// Watchlists: scheduled checks of news and Wikidata, kept in data/watch.json (see watch.mjs).
const watch = createWatch({ dataDir, explore });
// Place search for the maps (OpenStreetMap Nominatim, one request per second; see geocode.mjs).
const geocoder = createGeocoder({ fetchText: fakeUpstream || defaultFetchText });
const { backupDir } = store.paths;
const configPath = path.join(dataDir, 'host-config.json');
const port = Number(process.env.PORT || 4174);
const bind = process.env.ATLAS_BIND || '0.0.0.0';
const lanCodeRequired = !/^(off|0|false|no)$/i.test(process.env.ATLAS_LAN_CODE || '');
const allowedNames = [os.hostname(), `${os.hostname()}.local`, ...(process.env.ATLAS_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)];
const MAX_BODY = 150 * 1024 * 1024;
const COOKIE = 'atlas_access';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const compressible = /^(text\/|application\/(json|javascript)|image\/svg)/;

// ---------- host config (access code) ----------
let config = { secret: '', accessCode: '' };
async function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(configPath, 'utf8')); } catch {}
  const next = { secret: saved.secret || crypto.randomBytes(32).toString('hex'), accessCode: saved.accessCode || generateCode() };
  if (next.secret !== saved.secret || next.accessCode !== saved.accessCode) await writeAtomic(configPath, JSON.stringify(next, null, 2));
  config = { ...next, accessCode: process.env.ATLAS_ACCESS_CODE?.trim() || next.accessCode };
}

// ---------- http helpers ----------
const baseHeaders = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' };
function send(req, res, status, body, type, extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { ...baseHeaders, 'content-type': type, vary: 'Accept-Encoding', ...extra };
  if (buf.length > 1024 && compressible.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !headers['content-encoding']) {
    buf = zlib.gzipSync(buf, { level: 6 });
    headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}
const json = (req, res, status, data, extra = {}) => send(req, res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'cache-control': 'no-store', ...extra });
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  if (!/application\/json/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
  try { return JSON.parse(await readBody(req)); } catch (e) { throw Object.assign(new Error(e.status ? e.message : 'Invalid JSON body'), { status: e.status || 400 }); }
}
const unitResult = (req, res, r) => json(req, res, r.conflict ? 409 : 200, r.conflict ? { error: 'conflict', reason: r.reason, revision: r.revision } : r);
function routeIds(match) {
  try { return match.slice(1).map(decodeURIComponent); } catch { return null; }
}
function lanUrls() {
  const out = [];
  for (const items of Object.values(os.networkInterfaces())) for (const item of items || []) if (item.family === 'IPv4' && !item.internal) out.push(`http://${item.address}:${port}`);
  return out;
}

// ---------- basemap proxy (OpenFreeMap: free, no key, attribution required) ----------
const mapOrigin = 'https://tiles.openfreemap.org/';
const tileCache = new Map(); let tileBytes = 0; const TILE_CACHE_MAX = 64 * 1024 * 1024;
let styleCache = null;
function localizeMapUrls(value, origin) {
  if (typeof value === 'string' && value.startsWith(mapOrigin)) return `${origin}/api/map/assets/${value.slice(mapOrigin.length)}`;
  if (Array.isArray(value)) return value.map(v => localizeMapUrls(v, origin));
  if (value && typeof value === 'object') for (const key of Object.keys(value)) value[key] = localizeMapUrls(value[key], origin);
  return value;
}
async function mapRequest(req, res, url) {
  const origin = `http://${req.headers.host || 'localhost'}`;
  if (url.pathname === '/api/map/style') {
    try {
      if (!styleCache || Date.now() - styleCache.at > 3600_000) {
        const upstream = await fetch(`${mapOrigin}styles/dark`, { signal: AbortSignal.timeout(12000) });
        if (!upstream.ok) throw Error(`OpenFreeMap returned HTTP ${upstream.status}`);
        styleCache = { at: Date.now(), text: await upstream.text() };
      }
      return json(req, res, 200, localizeMapUrls(JSON.parse(styleCache.text), origin), { 'cache-control': 'no-cache' });
    } catch (e) {
      return json(req, res, 502, { error: 'The Windows host could not load the free OpenFreeMap basemap style.', detail: e.name === 'TimeoutError' ? 'Request timed out (is this PC online?)' : e.message });
    }
  }
  // Satellite imagery for the Map workspace (Esri or EOX), through the same tile cache.
  if (url.pathname.startsWith('/api/map/sat/')) {
    const m = url.pathname.match(/^\/api\/map\/sat\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)$/);
    const upstreamUrl = m && satTileUrl(m[1], m[2], m[3], m[4]);
    if (!upstreamUrl) return json(req, res, 400, { error: 'Invalid satellite tile address' });
    const key = `sat:${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
    const hit = tileCache.get(key);
    if (hit) { tileCache.delete(key); tileCache.set(key, hit); return send(req, res, 200, hit.body, hit.type, { 'cache-control': hit.cache }); }
    try {
      const upstream = await fetch(upstreamUrl, { headers: { 'user-agent': `Atlas-Workspace/${VERSION} (self-hosted research tool)` }, signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) return send(req, res, upstream.status === 404 ? 404 : 502, 'Satellite tile unavailable', 'text/plain; charset=utf-8');
      const type = upstream.headers.get('content-type') || 'image/jpeg';
      const body = Buffer.from(await upstream.arrayBuffer()), cache = 'public, max-age=86400';
      if (body.length < 2 * 1024 * 1024) {
        tileCache.set(key, { body, type, cache }); tileBytes += body.length;
        for (const [k, v] of tileCache) { if (tileBytes <= TILE_CACHE_MAX) break; tileCache.delete(k); tileBytes -= v.body.length; }
      }
      return send(req, res, 200, body, type, { 'cache-control': cache });
    } catch (e) {
      return send(req, res, 502, `Could not reach the satellite imagery provider: ${e.message}`, 'text/plain; charset=utf-8');
    }
  }
  const prefix = '/api/map/assets/';
  if (!url.pathname.startsWith(prefix)) return false;
  let resource;
  try { resource = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { return json(req, res, 400, { error: 'Invalid map asset path' }); }
  if (!resource || resource.includes('..') || resource.includes('\\') || resource.startsWith('/')) return json(req, res, 400, { error: 'Invalid map asset path' });
  const key = resource + url.search;
  const hit = tileCache.get(key);
  if (hit) { tileCache.delete(key); tileCache.set(key, hit); return send(req, res, 200, hit.body, hit.type, { 'cache-control': hit.cache }); }
  try {
    const upstream = await fetch(mapOrigin + key, { signal: AbortSignal.timeout(15000) });
    if (!upstream.ok) return send(req, res, upstream.status, 'Basemap asset unavailable', 'text/plain; charset=utf-8');
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    let body = Buffer.from(await upstream.arrayBuffer());
    if (type.includes('json')) body = Buffer.from(JSON.stringify(localizeMapUrls(JSON.parse(body.toString('utf8')), origin)));
    const cache = upstream.headers.get('cache-control') || 'public, max-age=86400';
    if (!type.includes('json') && body.length < 2 * 1024 * 1024) {
      tileCache.set(key, { body, type, cache }); tileBytes += body.length;
      for (const [k, v] of tileCache) { if (tileBytes <= TILE_CACHE_MAX) break; tileCache.delete(k); tileBytes -= v.body.length; }
    }
    return send(req, res, 200, body, type, { 'cache-control': cache });
  } catch (e) {
    return send(req, res, 502, `Could not reach the free basemap provider: ${e.message}`, 'text/plain; charset=utf-8');
  }
}

// ---------- Explore: live look-ups in Wikipedia, Wikidata and GDELT (see explore.mjs) ----------
async function exploreRequest(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Method not allowed' });
  const p = url.pathname, q = (url.searchParams.get('q') || '').trim();
  const bad = message => json(req, res, 400, { error: message });
  const queryOk = q.length >= 1 && q.length <= 200;
  try {
    if (p === '/api/explore/search') return queryOk ? json(req, res, 200, await explore.search(q)) : bad('Type 1 to 200 characters to search.');
    const topic = p.match(/^\/api\/explore\/topic\/([^/]+)$/);
    if (topic) return /^Q\d{1,12}$/.test(topic[1]) ? json(req, res, 200, await explore.topic(topic[1])) : bad('Expected a Wikidata item ID such as Q1317.');
    const events = p.match(/^\/api\/explore\/events\/([^/]+)$/);
    if (events) return /^Q\d{1,12}$/.test(events[1]) ? json(req, res, 200, { events: await explore.events(events[1]) }) : bad('Expected a Wikidata item ID such as Q1317.');
    const around = p.match(/^\/api\/explore\/neighbors\/([^/]+)$/);
    if (around) return /^Q\d{1,12}$/.test(around[1]) ? json(req, res, 200, await explore.neighbors(around[1])) : bad('Expected a Wikidata item ID such as Q1317.');
    if (p === '/api/explore/news') {
      const before = url.searchParams.get('before') || '';
      if (!queryOk || (before && !/^\d{14}$/.test(before))) return bad('Expected q (1 to 200 characters) and an optional before=YYYYMMDDhhmmss.');
      return json(req, res, 200, await explore.news(q, before || undefined));
    }
  } catch (e) {
    return json(req, res, e.status || 502, { error: e.message || 'Explore failed.' });
  }
  return json(req, res, 404, { error: 'Unknown API endpoint' });
}

// ---------- Watchlists ----------
async function watchRequest(req, res, url) {
  const p = url.pathname, m = req.method;
  try {
    if (p === '/api/watch' && m === 'GET') return json(req, res, 200, watch.list());
    if (p === '/api/watch' && m === 'POST') return json(req, res, 201, await watch.add((await readJson(req)) || {}));
    if (p === '/api/watch/summary' && m === 'GET') return json(req, res, 200, watch.summary());
    if (p === '/api/watch/check' && m === 'POST') {
      const body = await readJson(req);
      const r = watch.check(typeof body?.id === 'string' ? body.id : undefined);
      return json(req, res, r.started ? 202 : 200, r);
    }
    if (p === '/api/watch/seen' && m === 'POST') return json(req, res, 200, await watch.markSeen((await readJson(req)) || {}));
    if (p === '/api/watch/settings' && m === 'PUT') return json(req, res, 200, await watch.setSettings((await readJson(req)) || {}));
    const one = p.match(/^\/api\/watch\/([A-Za-z0-9-]{1,64})$/);
    if (one && m === 'PUT') return json(req, res, 200, await watch.update(one[1], (await readJson(req)) || {}));
    if (one && m === 'DELETE') { await watch.remove(one[1]); return json(req, res, 200, { ok: true }); }
  } catch (e) {
    return json(req, res, e.status || 500, { error: e.message || 'The watchlist could not do that.' });
  }
  return json(req, res, 404, { error: 'Unknown API endpoint' });
}

// ---------- static files ----------
const gzCache = new Map();
async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(req, res, 400, 'Bad path', 'text/plain'); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.resolve(distDir, `.${rel}`);
  if (file !== distDir && !file.startsWith(distDir + path.sep)) return send(req, res, 403, 'Forbidden', 'text/plain');
  let stat;
  try { stat = await fs.stat(file); } catch {
    if (rel === '/index.html') return send(req, res, 503, 'Atlas web build not found. In PowerShell run: npm.cmd run build', 'text/plain; charset=utf-8');
    return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const type = mime[path.extname(file)] || 'application/octet-stream';
  const hashed = /-[A-Za-z0-9_-]{8}\.\w+$/.test(file);
  const cache = rel === '/index.html' ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  const gzip = compressible.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const cacheKey = `${file}:${stat.mtimeMs}`;
  if (gzip) {
    let body = gzCache.get(cacheKey);
    if (!body) { body = zlib.gzipSync(await fs.readFile(file), { level: 7 }); gzCache.set(cacheKey, body); }
    res.writeHead(200, { ...baseHeaders, 'content-type': type, 'content-encoding': 'gzip', 'content-length': body.length, 'cache-control': cache, vary: 'Accept-Encoding' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const body = await fs.readFile(file);
  res.writeHead(200, { ...baseHeaders, 'content-type': type, 'content-length': body.length, 'cache-control': cache });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------- access control ----------
const throttle = createThrottle(8, 10 * 60 * 1000);
function clientAddress(req) {
  const peer = normalizeIp(req.socket.remoteAddress);
  // The Vite dev server proxies /api from loopback and forwards the real device address.
  const fwd = isLoopback(peer) ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return fwd ? normalizeIp(fwd) : peer;
}
function isAuthorized(req, local) {
  if (local || !lanCodeRequired) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return !!token && safeEqual(token, tokenFor(config.secret, config.accessCode));
}
const cookieHeader = token => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 31536000 : 0}`;

// ---------- routes ----------
async function handle(req, res) {
  const client = clientAddress(req);
  if (!isPrivateAddress(client)) return send(req, res, 403, 'Atlas only accepts connections from this computer and private local networks.', 'text/plain; charset=utf-8');
  if (!isAllowedHostHeader(req.headers.host, allowedNames)) return send(req, res, 403, 'Unrecognised host name. Open Atlas by IP address (e.g. http://192.168.x.x:4174) or http://localhost:4174, or add the name to ATLAS_ALLOWED_HOSTS.', 'text/plain; charset=utf-8');
  const write = !['GET', 'HEAD'].includes(req.method || 'GET');
  if (write && !originMatchesHost(req.headers.origin, req.headers.host)) return json(req, res, 403, { error: 'Cross-site request blocked.' });
  if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders); return res.end(); }
  const url = new URL(req.url || '/', 'http://atlas.local');
  const local = isLoopback(client);
  const p = url.pathname;

  if (!p.startsWith('/api/')) return serveStatic(req, res, url);
  if (p === '/api/health') return json(req, res, 200, { ok: true, version: VERSION });
  if (p === '/api/session') return json(req, res, 200, { local, codeRequired: lanCodeRequired && !local, authorized: isAuthorized(req, local) });
  if (p === '/api/access' && req.method === 'POST') {
    if (throttle.blocked(client)) return json(req, res, 429, { error: 'Too many attempts. Wait 10 minutes and try again.' });
    const body = await readJson(req);
    if (!safeEqual(normalizeCode(body?.code), normalizeCode(config.accessCode))) { throttle.fail(client); return json(req, res, 401, { error: 'That access code is not correct.' }); }
    throttle.reset(client);
    return json(req, res, 200, { ok: true }, { 'set-cookie': cookieHeader(tokenFor(config.secret, config.accessCode)) });
  }
  if (p === '/api/access/forget' && req.method === 'POST') return json(req, res, 200, { ok: true }, { 'set-cookie': cookieHeader('') });
  if (!isAuthorized(req, local)) return json(req, res, 401, { error: 'access-code-required' });

  const mapHandled = await mapRequest(req, res, url);
  if (mapHandled !== false) return;
  if (p.startsWith('/api/explore/')) return exploreRequest(req, res, url);
  if (p === '/api/watch' || p.startsWith('/api/watch/')) return watchRequest(req, res, url);
  if (p === '/api/geo/search') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Method not allowed' });
    try { return json(req, res, 200, await geocoder.search(url.searchParams.get('q') || '')); } catch (e) { return json(req, res, e.status || 502, { error: e.message || 'Place search failed.' }); }
  }

  if (p === '/api/host-info') {
    const backups = local ? await store.listBackups() : [];
    const dataBytes = await store.dataBytes();
    return json(req, res, 200, {
      version: VERSION, local, codeRequired: lanCodeRequired, lanUrls: lanUrls(), port, dataBytes,
      ...(local ? { accessCode: lanCodeRequired ? config.accessCode : null, storagePath: dataDir, backupDir, backups: backups.slice(0, 15), backupCount: backups.length } : {}),
    });
  }
  if (p === '/api/access/rotate' && req.method === 'POST') {
    if (!local) return json(req, res, 403, { error: 'Rotate the code from the Windows host itself.' });
    if (process.env.ATLAS_ACCESS_CODE) return json(req, res, 409, { error: 'The code is fixed by the ATLAS_ACCESS_CODE environment variable.' });
    config.accessCode = generateCode();
    await writeAtomic(configPath, JSON.stringify({ secret: config.secret, accessCode: config.accessCode }, null, 2));
    console.log(`LAN access code changed: ${config.accessCode}`);
    return json(req, res, 200, { accessCode: config.accessCode });
  }
  if (p === '/api/workspace' && req.method === 'GET') return json(req, res, 200, await store.readWorkspace());
  if (p === '/api/workspace/revision') return json(req, res, 200, { revision: (await store.manifest()).revision });
  if (p === '/api/workspace/manifest') return json(req, res, 200, await store.manifest());
  // Whole-workspace save, kept for pages still open from Atlas 0.2. Current pages save per board.
  if (p === '/api/workspace' && req.method === 'PUT') {
    const body = await readJson(req);
    return unitResult(req, res, await store.saveWorkspace(body?.projects, String(body?.baseRevision || ''), body?.force === true));
  }
  const boardRoute = p.match(/^\/api\/boards\/([^/]+)\/([^/]+)$/);
  if (boardRoute) {
    const ids = routeIds(boardRoute);
    if (!ids) return json(req, res, 400, { error: 'Invalid board address' });
    const [pid, bid] = ids;
    if (req.method === 'GET') {
      const r = await store.readBoard(pid, bid);
      if (!r) return json(req, res, 404, { error: 'not-found' });
      // The stored text is sent as-is; a large board is not parsed and re-serialised for every request.
      return send(req, res, 200, `{"revision":${JSON.stringify(r.revision)},"board":${r.text}}`, 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
    }
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const body = await readJson(req);
      if (typeof body?.baseRevision !== 'string') return json(req, res, 400, { error: 'Expected a baseRevision.' });
      const force = body.force === true;
      return unitResult(req, res, req.method === 'PUT' ? await store.saveBoard(pid, bid, body.board, body.baseRevision, force) : await store.deleteBoard(pid, bid, body.baseRevision, force));
    }
    return json(req, res, 405, { error: 'Method not allowed' });
  }
  const projectRoute = p.match(/^\/api\/projects\/([^/]+)$/);
  if (projectRoute && (req.method === 'PUT' || req.method === 'DELETE')) {
    const ids = routeIds(projectRoute);
    const body = await readJson(req);
    if (!ids || typeof body?.baseRevision !== 'string') return json(req, res, 400, { error: 'Expected { baseRevision, project }.' });
    if (req.method === 'DELETE') return unitResult(req, res, await store.deleteProject(ids[0], body.baseRevision, body.boardRevisions, body.force === true));
    return unitResult(req, res, await store.saveProject(ids[0], body.project, body.baseRevision, body.force === true));
  }
  // Compatibility with pages loaded from Atlas 0.1: read still works; blind overwrite does not.
  if (p === '/api/projects' && req.method === 'GET') return json(req, res, 200, (await store.readWorkspace()).projects);
  if (p === '/api/projects' && req.method === 'PUT') return json(req, res, 409, { error: 'This page is from an older Atlas version. Reload the page; nothing was saved.' });
  if (p === '/api/export') {
    const { projects, revision } = await store.readWorkspace();
    return send(req, res, 200, JSON.stringify({ format: 'atlas-workspace', version: 2, exportedAt: new Date().toISOString(), revision, projects, watch: watch.exportable() }, null, 2), 'application/json; charset=utf-8', { 'cache-control': 'no-store', 'content-disposition': `attachment; filename="atlas-workspace-backup-${stamp()}.json"` });
  }
  return json(req, res, 404, { error: 'Unknown API endpoint' });
}

const server = createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) json(req, res, e.status || 500, { error: e.message || 'Server error' });
    else res.destroy();
    if (!e.status || e.status >= 500) console.error(e);
  });
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Atlas may already be running in another window. Close it, or start with: $env:PORT=4175; npm.cmd run host`);
  else console.error(e);
  process.exit(1);
});

await loadConfig();
try { await store.init(); } catch (e) { console.error(`WARNING: ${e.message}`); }
await watch.init();
watch.start();
server.listen(port, bind, () => {
  console.log(`Atlas ${VERSION} host is running.`);
  console.log(`  This PC:     http://localhost:${port}`);
  for (const u of lanUrls()) console.log(`  LAN access:  ${u}`);
  console.log(lanCodeRequired ? `  Access code for Mac/iPad (enter once per device): ${config.accessCode}` : '  WARNING: LAN access code disabled (ATLAS_LAN_CODE=off). Any device on your network can read and change data.');
  console.log(`  Data folder: ${dataDir} (projects.json + one file per board in boards)`);
  console.log(`  Backups:     ${backupDir}`);
  console.log('  Only private-network addresses are accepted. Do not port-forward this server to the internet.');
});
