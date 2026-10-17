// Watchlists: the host checks watched entities and keywords against GDELT news and Wikidata on a schedule and keeps
// what is new in data/watch.json. Nothing here touches projects or boards.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stamp, writeAtomic } from './store.mjs';

export const IGNORED_PROPERTIES = new Set(['P8687', 'P3744', 'P373', 'P18']); // follower counts, subscribers, Commons category, image
export const LIMITS = { watches: 100, newsPerCheck: 50, seenUrls: 1000, alerts: 500, text: 200 };
export const INTERVALS = [0, 1, 6, 24];
export const BUSY = 'GDELT is limiting requests; will retry next round';

const uniqSorted = list => [...new Set(list.map(String))].sort((a, b) => a.localeCompare(b));
export const normalizeQuery = q => String(q ?? '').toLowerCase().replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

/** What a check compares: label, description, aliases and the facts Explore shows, values sorted. */
export function snapshotOf(topic) {
  const facts = {};
  for (const f of topic?.facts || []) {
    if (IGNORED_PROPERTIES.has(f.property)) continue;
    const values = uniqSorted((f.values || []).map(v => v?.text).filter(t => t != null && t !== ''));
    if (values.length) facts[f.property] = { label: String(f.label || f.property), values };
  }
  return { label: String(topic?.label || ''), description: String(topic?.description || ''), aliases: uniqSorted(topic?.aliases || []), facts };
}

const list = a => a.join(', ');
function setDiff(before, after) {
  const b = new Set(before), a = new Set(after);
  return { added: after.filter(x => !b.has(x)), removed: before.filter(x => !a.has(x)) };
}
function changeText(label, added, removed) {
  if (added.length && removed.length) return `${label}: removed ${list(removed)}; added ${list(added)}`;
  return added.length ? `${label} added: ${list(added)}` : `${label} removed: ${list(removed)}`;
}

/** Each difference becomes one change: label, description, aliases, then properties by label. */
export function diffSnapshots(prev, next) {
  const out = [];
  if (prev.label !== next.label) out.push({ label: 'Label', added: [next.label], removed: [prev.label], text: `Label changed: “${prev.label}” → “${next.label}”` });
  if (prev.description !== next.description) out.push({ label: 'Description', added: [next.description], removed: [prev.description], text: `Description changed: “${prev.description}” → “${next.description}”` });
  const al = setDiff(prev.aliases, next.aliases);
  if (al.added.length || al.removed.length) out.push({ label: 'Also known as', ...al, text: changeText('Also known as', al.added, al.removed) });
  const props = [...new Set([...Object.keys(prev.facts), ...Object.keys(next.facts)])];
  const labelOf = p => next.facts[p]?.label || prev.facts[p]?.label || p;
  for (const p of props.sort((a, b) => labelOf(a).localeCompare(labelOf(b)))) {
    const d = setDiff(prev.facts[p]?.values || [], next.facts[p]?.values || []);
    if (d.added.length || d.removed.length) out.push({ property: p, label: labelOf(p), ...d, text: changeText(labelOf(p), d.added, d.removed) });
  }
  return out;
}

/**
 * Articles not seen before for this watch, newest first, at most `max`. The first check (`baseline`) only records
 * what is there. Seen URLs keep the newest `keep`.
 */
export function pickNewArticles(seenUrls, articles, { englishOnly = false, baseline = false, max = LIMITS.newsPerCheck, keep = LIMITS.seenUrls } = {}) {
  const seen = new Set(seenUrls);
  const usable = (articles || []).filter(a => a?.url && (!englishOnly || /^english$/i.test(a.language || '')));
  const unseen = usable.filter(a => !seen.has(a.url));
  const urls = [...new Set(unseen.map(a => a.url))];
  return { fresh: baseline ? [] : unseen.slice(0, max), seenUrls: [...urls, ...seenUrls].slice(0, keep) };
}

const str = v => (typeof v === 'string' ? v : '');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** Reads watch.json leniently: unknown or broken entries are dropped, never thrown. */
export function normalizeWatchFile(raw) {
  const r = isObj(raw) ? raw : {};
  const s = isObj(r.settings) ? r.settings : {};
  const settings = { intervalHours: INTERVALS.includes(s.intervalHours) ? s.intervalHours : 6, ...(str(s.lastRoundAt) ? { lastRoundAt: s.lastRoundAt } : {}) };
  const watches = (Array.isArray(r.watches) ? r.watches : []).filter(w => isObj(w) && str(w.id) && (w.kind === 'entity' || w.kind === 'keyword') && str(w.label) && str(w.query))
    .map(w => ({ ...w, englishOnly: w.englishOnly === true, paused: w.paused === true, seenUrls: Array.isArray(w.seenUrls) ? w.seenUrls.filter(u => typeof u === 'string') : [] }));
  const alerts = (Array.isArray(r.alerts) ? r.alerts : []).filter(a => isObj(a) && str(a.id) && str(a.watchId) && str(a.at) && (a.kind === 'news' || a.kind === 'wikidata'))
    .map(a => ({ ...a, seen: a.seen === true }));
  return { format: 'atlas-watch', version: 1, settings, watches, alerts };
}

// ---------- the service ----------
const HOUR = 3600 * 1000;
const QID = /^Q\d{1,12}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const reason = e => e?.message || String(e);
const internal = ({ seenUrls: _s, snapshot: _n, newsBaselined: _b, wikidataGone: _g, ...rest }) => rest;

/**
 * Keeps data/watch.json, runs the schedule and checks one watch at a time through the Explore client, so GDELT's one
 * request every 5 seconds is shared fairly with Explore's own searches.
 */
export function createWatch({ dataDir, explore, now = Date.now, timers = { every: setInterval, after: setTimeout, clear: clearInterval }, log = console.warn, startDelayMs = 30000 }) {
  const file = path.join(dataDir, 'watch.json');
  let state = normalizeWatchFile(null);
  let running = null, roundDone = Promise.resolve(), ticker = null;
  const iso = () => new Date(now()).toISOString();
  const find = id => state.watches.find(w => w.id === id);
  const unseenCount = watchId => state.alerts.filter(a => !a.seen && (!watchId || a.watchId === watchId)).length;

  // Saves run one after another: two writes to the same file at once would share a temporary file.
  let saving = Promise.resolve();
  function save() {
    const p = saving.then(() => writeAtomic(file, JSON.stringify(state)));
    saving = p.catch(() => {});
    return p;
  }
  const saveQuietly = () => save().catch(e => log(`Watchlist: could not save ${file}: ${reason(e)}`));

  /** Keeps the newest 500 alerts: the oldest seen ones go first, then the oldest unseen. */
  function capAlerts() {
    const over = state.alerts.length - LIMITS.alerts;
    if (over <= 0) return;
    const byAge = [...state.alerts].sort((a, b) => a.at.localeCompare(b.at));
    const drop = new Set([...byAge.filter(a => a.seen), ...byAge.filter(a => !a.seen)].slice(0, over).map(a => a.id));
    state.alerts = state.alerts.filter(a => !drop.has(a.id));
  }

  const publicWatch = w => ({ ...internal(w), unseen: unseenCount(w.id) });
  function status() {
    const h = state.settings.intervalHours, last = Date.parse(state.settings.lastRoundAt || '');
    const next = !h ? null : Number.isFinite(last) ? new Date(last + h * HOUR).toISOString() : iso();
    return { running: !!running, done: running?.done ?? 0, total: running?.total ?? 0, current: running?.current ?? '', lastRoundAt: state.settings.lastRoundAt || null, nextRoundAt: next };
  }
  const itemChange = (qid, text, added = [], removed = []) => ({ kind: 'wikidata', qid, change: { label: 'Wikidata item', added, removed, text } });

  /** Checks one watch. Anything that fails leaves that part of the watch's memory as it was. */
  async function checkOne(w, newsBlocked) {
    const errors = [], found = [];
    if (newsBlocked) errors.push(BUSY);
    else {
      try {
        const r = await explore.news(w.query, undefined, { fresh: true });
        if (r?.busy) { newsBlocked = true; errors.push(BUSY); }
        else if (r?.error) errors.push(`News: ${r.error}`);
        else {
          const { fresh, seenUrls } = pickNewArticles(w.seenUrls, r?.articles || [], { englishOnly: w.englishOnly, baseline: !w.newsBaselined });
          w.seenUrls = seenUrls;
          w.newsBaselined = true;
          for (const a of fresh) found.push({ kind: 'news', news: { title: String(a.title || a.url), url: a.url, domain: String(a.domain || ''), date: String(a.date || ''), language: String(a.language || '') } });
        }
      } catch (e) { errors.push(`News: ${reason(e)}`); }
    }
    if (w.qid && w.wikidataGone) errors.push(`Wikidata item ${w.qid} no longer exists`);
    else if (w.qid) {
      try {
        const t = await explore.topic(w.qid, { fresh: true });
        // Labels missing from a partial answer would look like changes, so it is not compared.
        if (t?.errors && Object.keys(t.errors).length) errors.push('Wikidata answered only in part; will retry next round');
        else {
          if (t.redirectedTo && t.redirectedTo !== w.qid) {
            found.push(itemChange(t.redirectedTo, `Wikidata item ${w.qid} was merged into ${t.redirectedTo}`, [t.redirectedTo], [w.qid]));
            w.qid = t.redirectedTo;
          }
          const snap = snapshotOf(t);
          if (w.snapshot) for (const change of diffSnapshots(w.snapshot, snap)) found.push({ kind: 'wikidata', qid: w.qid, change });
          w.snapshot = snap;
        }
      } catch (e) {
        if (e?.status === 404) {
          found.push(itemChange(w.qid, `Wikidata item ${w.qid} no longer exists`));
          errors.push(`Wikidata item ${w.qid} no longer exists`);
          w.wikidataGone = true;
        } else errors.push(`Wikidata: ${reason(e)}`);
      }
    }
    return { found, errors, newsBlocked };
  }

  async function runRound(ids, full) {
    running = { done: 0, total: ids.length, current: '' };
    let newsBlocked = false;
    try {
      for (const id of ids) {
        const w = find(id);
        if (!w || w.paused) { running.done++; continue; }
        running.current = w.label;
        const r = await checkOne(w, newsBlocked);
        newsBlocked = r.newsBlocked;
        // A watch removed while it was being checked stays removed, with no alerts.
        if (find(id)) {
          const at = iso();
          for (const a of r.found) state.alerts.push({ id: crypto.randomUUID(), watchId: id, at, ...a, seen: false });
          w.lastCheckedAt = at;
          if (r.errors.length) w.lastError = r.errors.join(' · '); else delete w.lastError;
          capAlerts();
          await saveQuietly();
        }
        running.done++;
      }
      if (full) { state.settings.lastRoundAt = iso(); await saveQuietly(); }
    } finally { running = null; }
  }

  function check(id) {
    if (running) return { started: false, reason: 'already checking' };
    if (id != null && !find(id)) throw fail(404, 'No such watch.');
    const ids = id != null ? [id] : state.watches.map(w => w.id);
    roundDone = runRound(ids, id == null).catch(e => log(`Watchlist round failed: ${reason(e)}`));
    return { started: true };
  }

  function tick() {
    const h = state.settings.intervalHours;
    if (!h || running || !state.watches.length) return;
    const last = Date.parse(state.settings.lastRoundAt || '');
    if (Number.isFinite(last) && now() - last < h * HOUR) return;
    check();
  }

  const isDuplicate = (except, qid, query) => state.watches.some(w => w.id !== except && (qid ? w.qid === qid : !w.qid && normalizeQuery(w.query) === normalizeQuery(query)));
  const checkText = (v, what) => { const t = clean(v); if (!t || t.length > LIMITS.text) throw fail(400, `${what} must be 1 to ${LIMITS.text} characters.`); return t; };

  return {
    async init() {
      let text = null;
      try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log(`Watchlist: could not read ${file}: ${reason(e)}`); }
      if (text == null) { state = normalizeWatchFile(null); return; }
      try { state = normalizeWatchFile(JSON.parse(text)); } catch {
        const aside = `${file}.corrupt-${stamp()}`;
        await fs.rename(file, aside).catch(() => {});
        log(`Watchlist: ${file} could not be read and was moved to ${aside}. Starting with an empty watchlist.`);
        state = normalizeWatchFile(null);
      }
      capAlerts();
    },
    list() {
      const order = new Map(state.alerts.map((a, i) => [a.id, i]));
      const alerts = [...state.alerts].sort((a, b) => b.at.localeCompare(a.at) || order.get(b.id) - order.get(a.id));
      return { settings: { intervalHours: state.settings.intervalHours }, status: status(), watches: state.watches.map(publicWatch), alerts };
    },
    summary() {
      return { unseen: unseenCount(), running: !!running, watched: state.watches.map(w => ({ id: w.id, label: w.label, query: w.query, ...(w.qid ? { qid: w.qid } : {}) })) };
    },
    async add(input = {}) {
      const kind = input.kind;
      if (kind !== 'entity' && kind !== 'keyword') throw fail(400, 'Expected kind "entity" or "keyword".');
      const label = checkText(input.label, 'The name');
      const query = input.query == null || clean(input.query) === '' ? label : checkText(input.query, 'The news phrase');
      const qid = kind === 'entity' && input.qid != null && input.qid !== '' ? String(input.qid) : undefined;
      if (qid && !QID.test(qid)) throw fail(400, 'Expected a Wikidata item ID such as Q1317.');
      if (isDuplicate(null, qid, query)) throw fail(409, `“${label}” is already watched.`);
      if (state.watches.length >= LIMITS.watches) throw fail(409, `Atlas keeps at most ${LIMITS.watches} watches. Remove one first.`);
      const extra = k => (typeof input[k] === 'string' && input[k] && input[k].length <= LIMITS.text ? { [k]: input[k] } : {});
      const w = { id: crypto.randomUUID(), kind, label, query, ...(qid ? { qid } : {}), ...extra('projectId'), ...extra('entityKey'), englishOnly: input.englishOnly === true, paused: false, createdAt: iso(), seenUrls: [] };
      state.watches.push(w);
      await save();
      return publicWatch(w);
    },
    async update(id, patch = {}) {
      const w = find(id);
      if (!w) throw fail(404, 'No such watch.');
      // A new phrase or language filter starts a new baseline, so the edit does not flood the feed.
      const restart = () => { w.seenUrls = []; w.newsBaselined = false; };
      const label = 'label' in patch ? checkText(patch.label, 'The name') : w.label;
      const query = 'query' in patch ? checkText(patch.query, 'The news phrase') : w.query;
      if (!w.qid && query !== w.query && isDuplicate(w.id, undefined, query)) throw fail(409, `“${query}” is already watched.`);
      w.label = label;
      if (query !== w.query) { w.query = query; restart(); }
      if ('englishOnly' in patch && (patch.englishOnly === true) !== w.englishOnly) { w.englishOnly = patch.englishOnly === true; restart(); }
      if ('paused' in patch) w.paused = patch.paused === true;
      await save();
      return publicWatch(w);
    },
    async remove(id) {
      if (!find(id)) throw fail(404, 'No such watch.');
      state.watches = state.watches.filter(w => w.id !== id);
      state.alerts = state.alerts.filter(a => a.watchId !== id);
      await save();
    },
    check,
    idle: () => roundDone,
    async markSeen(sel = {}) {
      let hit;
      if (sel?.all === true) hit = () => true;
      else if (typeof sel?.watchId === 'string') hit = a => a.watchId === sel.watchId;
      else if (Array.isArray(sel?.ids)) { const ids = new Set(sel.ids.map(String)); hit = a => ids.has(a.id); }
      else throw fail(400, 'Expected { ids }, { watchId } or { all: true }.');
      for (const a of state.alerts) if (hit(a)) a.seen = true;
      await save();
      return { unseen: unseenCount() };
    },
    async setSettings({ intervalHours } = {}) {
      if (!INTERVALS.includes(intervalHours)) throw fail(400, 'intervalHours must be 0 (manual only), 1, 6 or 24.');
      state.settings.intervalHours = intervalHours;
      await save();
      return { intervalHours };
    },
    status,
    /** For the full workspace backup: the watches themselves, without alerts or what the host remembers. */
    exportable: () => ({ settings: { intervalHours: state.settings.intervalHours }, watches: state.watches.map(w => { const { lastError: _e, ...rest } = internal(w); return rest; }) }),
    start() { ticker = timers.every(tick, 60 * 1000); timers.after(tick, startDelayMs); },
    stop() { if (ticker != null) timers.clear(ticker); ticker = null; },
  };
}
