// Watchlist: what the Windows host found new for your watched entities and keywords (GDELT news, Wikidata changes).
// Watches and alerts live on the host (data/watch.json), never in projects or boards.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CheckCheck, Database, ExternalLink, FolderPlus, Loader2, Newspaper, Pause, Pencil, Plus, RefreshCw, ScanSearch, Shield, Tag, Trash2, TriangleAlert, X } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { AccessRequired, addWatch, checkWatches, getWatchList, markWatchSeen, removeWatch, setWatchSettings, updateWatch } from '../api.ts';
import { INTERVAL_LABELS, ago, alertDay, historyUrl, type Alert, type Watch, type WatchList } from '../watch.ts';
import { newsToLinks, saveLinks } from '../explore.ts';
import { usePersisted } from '../usePersisted.ts';
import { SELECTED_WATCH_KEY } from './WatchButton.tsx';

const errorText = (e: unknown) => (e instanceof AccessRequired ? 'This device needs the access code again. Reload the page.' : e instanceof Error ? e.message : String(e));
const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const folderFor = (w: Watch) => `Watch: ${w.label}`;

export default function WatchlistView({ ctx }: { ctx: Ctx }) {
  const ro = ctx.readOnly;
  const [data, setData] = useState<WatchList | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = usePersisted<string>(SELECTED_WATCH_KEY, '');
  const [editing, setEditing] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Alerts that were new when their watch was opened keep their marker until the page is left.
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try { setData(await getWatchList()); setLoadError(''); } catch (e) { setLoadError(errorText(e)); }
    setNow(Date.now());
  }, []);
  useEffect(() => { load(); }, [load]);
  const running = !!data?.status.running;
  useEffect(() => { const t = setInterval(load, running ? 3000 : 60000); return () => clearInterval(t); }, [running, load]);
  const wasRunning = useRef(false);
  useEffect(() => { if (wasRunning.current && !running) ctx.refreshWatch(); wasRunning.current = running; }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    if (ro) return;
    setBusy(true);
    try { await fn(); await load(); ctx.refreshWatch(); if (done) ctx.notify(done); } catch (e) { ctx.notify(errorText(e)); } finally { setBusy(false); }
  };

  const watches = data?.watches || [];
  const watch = watches.find(w => w.id === selected);
  const byId = useMemo(() => new Map(watches.map(w => [w.id, w])), [watches]);
  const alerts = (data?.alerts || []).filter(a => !watch || a.watchId === watch.id);
  const unseenHere = watch ? watch.unseen : 0;

  // Opening a watch marks its alerts seen (on every device), after they have been shown once.
  useEffect(() => {
    if (!watch || !unseenHere || ro) return;
    const ids = (data?.alerts || []).filter(a => a.watchId === watch.id && !a.seen).map(a => a.id);
    setFresh(f => new Set([...f, ...ids]));
    const t = setTimeout(() => { markWatchSeen({ watchId: watch.id }).then(() => { load(); ctx.refreshWatch(); }).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [watch?.id, unseenHere]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveToBoard = (a: Alert) => {
    const w = byId.get(a.watchId);
    if (!a.news || !w) return;
    const name = folderFor(w);
    const already = ctx.board.folders.find(f => f.name === name)?.items.some(i => i.url === a.news!.url);
    if (already) { ctx.notify(`Already in “${name}” on ${ctx.board.name}.`); return; }
    ctx.patchBoard(b => saveLinks(b, w.label, newsToLinks([{ ...a.news!, country: '' }]), name).board);
    ctx.notify(`Saved to the folder “${name}” on ${ctx.board.name}.`);
  };
  const openInvestigate = (w: Watch) => {
    try { localStorage.setItem('atlas.inv.entity', JSON.stringify(w.entityKey)); } catch {}
    ctx.setView('Investigate');
  };

  const status = data?.status;
  const statusLine = !status ? '' : status.running ? `Checking ${Math.min(status.done + 1, status.total)} of ${status.total}${status.current ? `: ${status.current}` : ''}…`
    : `${status.lastRoundAt ? `Last check ${ago(status.lastRoundAt, now)}.` : 'Not checked yet.'} ${data!.settings.intervalHours ? `Next check around ${clock(status.nextRoundAt)}.` : 'Checks run only when you press Check now.'} Checks run while the Windows host is running.`;
  const totalUnseen = watches.reduce((n, w) => n + w.unseen, 0);

  // Newest first, grouped by day.
  const groups: [string, Alert[]][] = [];
  for (const a of alerts) {
    const day = alertDay(a.at, now);
    const last = groups[groups.length - 1];
    if (last && last[0] === day) last[1].push(a); else groups.push([day, [a]]);
  }

  return <section className="content wl">
    <div className="view-heading">
      <div><div className="eyebrow">WATCHLIST · NEWS AND WIKIDATA</div><h1>Watchlist</h1>
        <p>The Windows host checks your watches for new articles (GDELT) and Wikidata changes. Alerts are leads to check, not verified facts.</p></div>
      <div className="actions">
        <select className="time-filter" aria-label="How often to check" disabled={ro || !data} value={data?.settings.intervalHours ?? 6} onChange={e => act(() => setWatchSettings(Number(e.target.value)))}>
          {INTERVAL_LABELS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
        </select>
        <button className="button subtle" disabled={ro || busy || running || !watches.length} onClick={() => act(() => checkWatches(), 'Checking now. New alerts appear here as each watch is done.')}>{running ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Check now</button>
        <button className="button primary" disabled={ro} onClick={() => setAdding(x => !x)}><Plus size={13} /> Add keyword watch</button>
      </div>
    </div>
    {statusLine && <div className="wl-status" role="status">{running && <Loader2 size={12} className="spin" />}{statusLine}</div>}
    {loadError && <div className="explore-warn" role="alert"><TriangleAlert size={14} />{loadError}<button className="button subtle" onClick={load}>Try again</button></div>}
    {adding && <AddKeyword busy={busy} onCancel={() => setAdding(false)} onAdd={(query, englishOnly) => act(async () => { const w = await addWatch({ kind: 'keyword', label: query, englishOnly }); setSelected(w.id); setAdding(false); }, `Watching “${query}”. The first check only records what is already there.`)} />}

    <div className="wl-columns">
      <aside className="wl-watches" aria-label="Watches">
        <button className={'wl-watch' + (!watch ? ' on' : '')} onClick={() => setSelected('')}><Bell size={14} /><span><b>All watches</b><small>{watches.length} watch{watches.length === 1 ? '' : 'es'}</small></span>{totalUnseen > 0 && <i className="wl-count">{totalUnseen}</i>}</button>
        {watches.map(w => editing === w.id
          ? <EditWatch key={w.id} w={w} busy={busy} onCancel={() => setEditing('')}
            onSave={patch => act(async () => { await updateWatch(w.id, patch); setEditing(''); })}
            onRemove={() => { if (confirm(`Stop watching “${w.label}”? Its alerts are removed too.`)) act(async () => { await removeWatch(w.id); setEditing(''); if (selected === w.id) setSelected(''); }, `Stopped watching “${w.label}”.`); }} />
          : <div key={w.id} className={'wl-watch-row' + (watch?.id === w.id ? ' on' : '')}>
            <button className="wl-watch" onClick={() => setSelected(w.id)}>
              {w.kind === 'entity' ? <ScanSearch size={14} /> : <Tag size={14} />}
              <span><b>{w.label}</b><small>{w.paused ? 'Paused' : w.lastCheckedAt ? `Checked ${ago(w.lastCheckedAt, now)}` : 'Not checked yet'}{w.qid ? ` · ${w.qid}` : ''}{w.query !== w.label ? ` · “${w.query}”` : ''}</small></span>
              {w.lastError && <TriangleAlert size={13} className="wl-warn" aria-label="Last check had a problem" />}
              {w.unseen > 0 && <i className="wl-count">{w.unseen}</i>}
            </button>
            <button className="icon-action" aria-label={`Edit ${w.label}`} disabled={ro} onClick={() => setEditing(w.id)}><Pencil size={12} /></button>
          </div>)}
        {data && !watches.length && <p className="muted small">Nothing watched yet. Use <b>Watch</b> on an Investigate profile or an Explore topic, or add a keyword here.</p>}
      </aside>

      <div className="wl-feed">
        <div className="wl-feed-head">
          <div><h2>{watch ? watch.label : 'All alerts'}</h2>
            {watch && <small className="muted">{watch.kind === 'entity' ? `News for “${watch.query}”${watch.qid ? ` and Wikidata ${watch.qid}` : ''}` : `News for “${watch.query}”`}{watch.englishOnly ? ' · English articles only' : ''}{watch.paused ? ' · paused' : ''}</small>}</div>
          <div className="wl-feed-actions">
            {watch && <button className="button subtle small" disabled={ro || busy || running || watch.paused} onClick={() => act(() => checkWatches(watch.id), `Checking “${watch.label}”.`)}><RefreshCw size={12} /> Check this</button>}
            {watch?.entityKey && watch.projectId === ctx.project.id && <button className="button subtle small" onClick={() => openInvestigate(watch)}><ScanSearch size={12} /> Investigate</button>}
            {watch && <button className="button subtle small" onClick={() => ctx.searchWorld(watch.label)}><Newspaper size={12} /> Explore</button>}
            {!watch && totalUnseen > 0 && <button className="button subtle small" disabled={ro} onClick={() => act(() => markWatchSeen({ all: true }))}><CheckCheck size={12} /> Mark all seen</button>}
          </div>
        </div>
        {watch?.lastError && <div className="explore-warn" role="status"><TriangleAlert size={14} />Last check: {watch.lastError}</div>}
        {groups.map(([day, list]) => <section key={day} className="wl-day"><h4>{day}</h4>
          {list.map(a => {
            const w = byId.get(a.watchId), isNew = !a.seen || fresh.has(a.id);
            return a.kind === 'news' && a.news ? <article key={a.id} className={'wl-alert' + (isNew ? ' new' : '')}>
              <Newspaper size={14} />
              <div><a href={a.news.url} target="_blank" rel="noreferrer noopener">{a.news.title} <ExternalLink size={10} /></a>
                <small>{[a.news.domain, a.news.date, a.news.language].filter(Boolean).join(' · ')}{!watch && w ? ` · ${w.label}` : ''}{isNew ? ' · new' : ''}</small></div>
              <button className="button subtle small" disabled={ro} title={w ? `Adds the link to the folder “${folderFor(w)}” on ${ctx.board.name}` : ''} onClick={() => saveToBoard(a)}><FolderPlus size={12} /> Save to board</button>
            </article> : <article key={a.id} className={'wl-alert wikidata' + (isNew ? ' new' : '')}>
              <Database size={14} />
              <div><span>{a.change?.text}</span>
                <small><span className="wl-unverified">unverified</span> Wikidata{a.qid ? ` ${a.qid}` : ''}{!watch && w ? ` · ${w.label}` : ''}{isNew ? ' · new' : ''}</small></div>
              {a.qid && <a className="button subtle small" href={historyUrl(a.qid)} target="_blank" rel="noreferrer noopener">Edit history <ExternalLink size={10} /></a>}
            </article>;
          })}
        </section>)}
        {data && !alerts.length && <p className="muted small wl-empty">{watches.length ? 'No alerts yet. The first check only records what is already there; later checks show what is new.' : 'Alerts appear here once you watch something.'}</p>}
        <div className="tip"><Shield size={14} /><span>News alerts are links to articles that mention the phrase; they belong to their publishers and can be about someone else with the same name. Wikidata is community-edited, so changes can be mistakes. Check before relying on either.</span></div>
      </div>
    </div>
  </section>;
}

function AddKeyword({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (query: string, englishOnly: boolean) => void; onCancel: () => void }) {
  const [query, setQuery] = useState(''), [english, setEnglish] = useState(false);
  const q = query.trim();
  return <form className="wl-form" onSubmit={e => { e.preventDefault(); if (q) onAdd(q, english); }}>
    <label>Phrase to watch in the news<input autoFocus maxLength={200} placeholder="e.g. Sudan ceasefire" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <label className="wl-check"><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} /> English-language articles only</label>
    <div className="wl-form-actions"><button type="button" className="button subtle small" onClick={onCancel}><X size={12} /> Cancel</button><button className="button primary small" disabled={!q || busy}><Plus size={12} /> Watch</button></div>
  </form>;
}

function EditWatch({ w, busy, onSave, onRemove, onCancel }: { w: Watch; busy: boolean; onSave: (patch: Partial<Pick<Watch, 'label' | 'query' | 'englishOnly' | 'paused'>>) => void; onRemove: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState(w.label), [query, setQuery] = useState(w.query), [english, setEnglish] = useState(w.englishOnly), [paused, setPaused] = useState(w.paused);
  const changesNews = query.trim() !== w.query || english !== w.englishOnly;
  return <form className="wl-form wl-edit" onSubmit={e => { e.preventDefault(); onSave({ label: label.trim(), query: query.trim(), englishOnly: english, paused }); }}>
    <label>Name<input maxLength={200} value={label} onChange={e => setLabel(e.target.value)} /></label>
    <label>News phrase<input maxLength={200} value={query} onChange={e => setQuery(e.target.value)} /></label>
    {changesNews && <small className="muted">A new phrase or language setting starts fresh: the next check only records what is already there.</small>}
    <label className="wl-check"><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} /> English-language articles only</label>
    <label className="wl-check"><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} /> <Pause size={11} /> Pause this watch</label>
    <div className="wl-form-actions">
      <button type="button" className="button danger small" onClick={onRemove}><Trash2 size={12} /> Remove</button>
      <span />
      <button type="button" className="button subtle small" onClick={onCancel}>Cancel</button>
      <button className="button primary small" disabled={busy || !label.trim() || !query.trim()}>Save</button>
    </div>
  </form>;
}
