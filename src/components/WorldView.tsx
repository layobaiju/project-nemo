import { useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, BookOpen, ChevronRight, Database, FileUp, Globe2, HelpCircle, Layers3, MapPin, Network, Plus, Search, Shield, Sparkles, Trash2, X } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import type { EventItem, RecordLink } from '../types.ts';
import { ALL_LAYERS, LAYERS, VERIFICATION, VERIFICATION_COLORS, dateSpan, formatDateRange, hasCoords, isPlaceholder, matchesQuery, nowIso, recordSearchText, uid, visibleByLayers } from '../model.ts';
import type { Match } from '../similarity.ts';
import { exportBoard, download, projectJSON, safeName } from '../exporters.ts';
import { makeEdge, nodeSearchText, recordNode } from '../graph.ts';
import InteractiveMap, { type BasemapMode, type BasemapStatus } from '../InteractiveMap.tsx';
import { usePersisted } from '../usePersisted.ts';
import { placeBounds, type Place } from '../geo.ts';
import PlaceSearch from './PlaceSearch.tsx';
import RecordSummary from './RecordSummary.tsx';
import SimilarityPanel from './SimilarityPanel.tsx';

const PRESETS: [string, string, string][] = [['All time', '', ''], ['Last 10 years', String(new Date().getFullYear() - 10), ''], ['Last 25 years', String(new Date().getFullYear() - 25), ''], ['Before 2000', '', '1999'], ['1990s', '1990', '1999'], ['20th century', '1901', '2000']];
const LAYER_ICON: Record<string, JSX.Element> = { Events: <Activity size={12} />, Countries: <Globe2 size={12} />, Conflicts: <Network size={12} />, Actors: <Shield size={12} />, Sources: <BookOpen size={12} /> };

export default function WorldView({ ctx }: { ctx: Ctx }) {
  const { project, board } = ctx;
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const [includeUndated, setIncludeUndated] = useState(true);
  const [verif, setVerif] = useState('All');
  const [layers, setLayers] = usePersisted<string[]>('atlas.layers', ALL_LAYERS);
  const [basemap, setBasemap] = usePersisted<BasemapMode>('atlas.basemap', 'online');
  const [status, setStatus] = useState<BasemapStatus | null>(null);
  const [similarMode, setSimilarMode] = useState(false);
  const [similarIds, setSimilarIds] = useState<string[]>([]);
  const [scope, setScope] = useState<'board' | 'project'>('board');
  const [selectedId, setSelectedId] = useState('');
  const [focus, setFocus] = useState<{ lng: number; lat: number; n: number }>();
  const [listFilter, setListFilter] = useState<'all' | 'unplaced' | 'unsourced' | 'placeholder'>('all');
  const [listLimit, setListLimit] = useState(150);
  const [showRules, setShowRules] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [findPlace, setFindPlace] = useState(false);
  const [place, setPlace] = useState<{ p: Place; fit: { bounds: [[number, number], [number, number]]; n: number; maxZoom: number } } | null>(null);

  const allProjectEvents = useMemo(() => project.boards.flatMap(b => b.events.map(e => ({ e, boardId: b.id }))), [project]);
  // An entity opened from Investigate: only its records are shown until the chip is cleared.
  const focusIds = useMemo(() => (ctx.focus ? new Set(ctx.focus.recordIds) : null), [ctx.focus]);
  const filtered = useMemo(() => {
    const f = from ? dateSpan(from)?.[0] ?? null : null, t = to ? dateSpan(to)?.[1] ?? null : null;
    return board.events.filter(e => {
      if (focusIds && !focusIds.has(e.id)) return false;
      if (!matchesQuery(recordSearchText(e), query)) return false;
      if (f != null || t != null) {
        const s = dateSpan(e.date, e.endDate);
        if (!s) return includeUndated;
        if ((f != null && s[1] < f) || (t != null && s[0] > t)) return false;
      }
      return verif === 'All' || e.verification === verif;
    });
  }, [board.events, query, from, to, includeUndated, verif, focusIds]);
  const focusCount = focusIds ? board.events.filter(e => focusIds.has(e.id)).length : 0;
  const focusBoards = focusIds && !focusCount ? project.boards.filter(b => b.id !== board.id && b.events.some(e => focusIds.has(e.id))) : [];
  const focusFit = useMemo(() => {
    const pts = focusIds ? board.events.filter(e => focusIds.has(e.id) && hasCoords(e)) : [];
    if (!pts.length) return undefined;
    const xs = pts.map(e => e.longitude!), ys = pts.map(e => e.latitude!), pad = pts.length === 1 ? 1 : 0;
    return { bounds: [[Math.min(...xs) - pad, Math.min(...ys) - pad], [Math.max(...xs) + pad, Math.max(...ys) + pad]] as [[number, number], [number, number]], n: Date.now() };
  }, [ctx.focus?.n, board.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mapEvents = useMemo(() => filtered.filter(e => visibleByLayers(e, layers)), [filtered, layers]);
  const selected = board.events.find(e => e.id === selectedId) || allProjectEvents.find(x => x.e.id === selectedId)?.e;
  const pool = scope === 'board' ? board.events : allProjectEvents.map(x => x.e);
  const allLinks = project.boards.flatMap(b => b.links);

  const quality = useMemo(() => ({
    total: board.events.length, placed: board.events.filter(hasCoords).length,
    unsourced: board.events.filter(e => !e.evidence.length).length, placeholders: board.events.filter(isPlaceholder),
  }), [board.events]);
  const listed = filtered.filter(e => listFilter === 'all' || (listFilter === 'unplaced' && !hasCoords(e)) || (listFilter === 'unsourced' && !e.evidence.length) || (listFilter === 'placeholder' && isPlaceholder(e)));

  // Enter in the search box: go to the first match on the map, or search public sources when this board has none.
  const searchEnter = () => {
    const q = query.trim();
    if (!q) return;
    if (!filtered.length) { ctx.searchWorld(q); return; }
    const first = filtered.find(hasCoords) || filtered[0];
    select(first.id);
  };
  const select = (id: string, fly = true) => {
    setSelectedId(id);
    const e = allProjectEvents.find(x => x.e.id === id)?.e;
    if (fly && e && hasCoords(e)) setFocus({ lng: e.longitude, lat: e.latitude, n: Date.now() });
  };
  const openRecord = (id: string) => ctx.openRecord(id, allProjectEvents.find(x => x.e.id === id)?.boardId);

  const createComparison = (other: EventItem, m: Match, note: string, alsoGraph: boolean) => {
    if (!selected) return;
    const link: RecordLink = { id: uid(), a: selected.id, b: other.id, kind: 'comparison', score: m.score, reasons: m.reasons, note, createdAt: nowIso() };
    ctx.patchBoard(b => {
      let nodes = [...b.nodes], edges = [...b.edges], events = b.events;
      if (alsoGraph) {
        const ensure = (rec: EventItem, x: number, y: number) => {
          const existing = nodes.find(n => n.id === rec.nodeId || (n.data as any)?.recordId === rec.id);
          if (existing) return existing.id;
          const id = uid();
          nodes.push(recordNode(id, rec, x, y));
          events = events.map(e => (e.id === rec.id ? { ...e, nodeId: id } : e));
          return id;
        };
        const na = ensure(selected, 120 + Math.random() * 80, 120 + Math.random() * 120), nb = ensure(other, 460 + Math.random() * 80, 220 + Math.random() * 120);
        edges.push(makeEdge(na, nb, `comparison (analyst-created) ${m.score}`, 'one-to-one', { style: { strokeDasharray: '5 4', stroke: '#b18cff' }, data: { relation: 'comparison (analyst-created)', cardinality: 'one-to-one', comparisonLinkId: link.id } }));
      }
      return { ...b, nodes, edges, events, links: [...b.links, link] };
    });
    ctx.notify('Comparison link saved. It records an analyst comparison only, not a connection between the events.');
  };

  const removePlaceholders = () => {
    const ids = new Set(quality.placeholders.map(e => e.id));
    if (!ids.size || !confirm(`Remove ${ids.size} untouched placeholder marker${ids.size > 1 ? 's' : ''} (no title, date, source or details)?\n\n${quality.placeholders.slice(0, 12).map(e => `• ${e.name || 'untitled'}`).join('\n')}${ids.size > 12 ? '\n…' : ''}\n\nHost backups keep the earlier version.`)) return;
    ctx.patchBoard(b => ({ ...b, events: b.events.filter(e => !ids.has(e.id)) }));
    ctx.notify(`Removed ${ids.size} placeholder marker${ids.size > 1 ? 's' : ''}.`);
  };
  const removeBatch = (batchId: string) => {
    const n = board.events.filter(e => e.provenance.importBatchId === batchId).length;
    if (!confirm(`Remove the ${n} record${n === 1 ? '' : 's'} added by this import from “${board.name}”? Records you created yourself are not affected. The import log entry is kept.`)) return;
    ctx.patchBoard(b => {
      const gone = new Set(b.events.filter(e => e.provenance.importBatchId === batchId).map(e => e.id));
      return { ...b, events: b.events.filter(e => !gone.has(e.id)), links: b.links.filter(l => !gone.has(l.a) && !gone.has(l.b)), imports: b.imports.map(i => (i.id === batchId ? { ...i, removedAt: nowIso() } : i)) };
    });
  };
  const doExport = (kind: string) => {
    setExportOpen(false);
    if (kind === 'project') download(`${safeName(project.name)}-project.json`, 'application/json', projectJSON(project));
    else if (kind === 'backup') window.location.href = '/api/export';
    else exportBoard(kind as any, board);
  };

  const statusText = status && !status.ok ? `Online basemap unavailable: ${status.message} Showing bundled country outlines (Natural Earth) instead; records and markers still work.` : '';

  return <section className="content world-view">
    <div className="view-heading">
      <div><div className="eyebrow">GEOSPATIAL RESEARCH · {board.name.toUpperCase()}</div><h1>World view</h1><p>Records you have entered or imported, with their sources. Not a complete or live global feed.</p></div>
      <div className="actions">
        <button className="button subtle" disabled={ctx.readOnly} onClick={() => ctx.openImport()}><FileUp size={14} /> Import</button>
        <div className="menu-wrap"><button className="button subtle" onClick={() => setExportOpen(x => !x)}><ArrowDownToLine size={14} /> Export</button>
          {exportOpen && <div className="menu" onMouseLeave={() => setExportOpen(false)}>
            <button onClick={() => doExport('records')}><b>Board records (JSON)</b><small>Lossless: evidence, actors, figures, provenance</small></button>
            <button onClick={() => doExport('csv')}><b>Board records (CSV)</b><small>Spreadsheet; re-importable with the Atlas template</small></button>
            <button onClick={() => doExport('evidence')}><b>Evidence register (CSV)</b><small>One row per source and the fields it supports</small></button>
            <button onClick={() => doExport('geojson')}><b>GeoJSON</b><small>For QGIS and other GIS tools</small></button>
            <button onClick={() => doExport('project')}><b>Whole project (JSON)</b><small>All boards, graphs, folders, links</small></button>
            <button onClick={() => doExport('backup')}><b>Full workspace backup</b><small>Every project, from the Windows host</small></button>
          </div>}
        </div>
        <button className="button primary" disabled={ctx.readOnly} onClick={() => ctx.newRecord()}><Plus size={14} /> Add record</button>
      </div>
    </div>
    {ctx.pickMode && <div className="pick-banner"><span>Click the globe to set the location for the record you were editing.</span><button className="button subtle" onClick={ctx.cancelPick}><X size={13} /> Cancel</button></div>}
    <div className="world-columns">
      <div className="map-panel">
        <div className="map-toolbar">
          <form className="searchbox" role="search" onSubmit={e => { e.preventDefault(); searchEnter(); }}><Search size={14} /><input aria-label="Search records on this board" placeholder="Search records on this board" value={query} onChange={e => setQuery(e.target.value)} /></form>
          <select className="time-filter" aria-label="Date preset" value={PRESETS.find(p => p[1] === from && p[2] === to)?.[0] || 'Custom'} onChange={e => { const p = PRESETS.find(x => x[0] === e.target.value); if (p) { setFrom(p[1]); setTo(p[2]); } }}>{PRESETS.map(p => <option key={p[0]}>{p[0]}</option>)}<option disabled>Custom</option></select>
          <input className="date-input" aria-label="From date" placeholder="From YYYY" value={from} onChange={e => setFrom(e.target.value)} />
          <input className="date-input" aria-label="To date" placeholder="To YYYY" value={to} onChange={e => setTo(e.target.value)} />
          <select className="time-filter" aria-label="Verification filter" value={verif} onChange={e => setVerif(e.target.value)}><option>All</option>{VERIFICATION.map(v => <option key={v}>{v}</option>)}</select>
          <button type="button" className={'button subtle' + (findPlace ? ' active' : '')} aria-expanded={findPlace} onClick={() => setFindPlace(x => !x)}><MapPin size={13} /> Find place</button>
          <select className="time-filter" aria-label="Basemap" value={basemap} onChange={e => setBasemap(e.target.value as BasemapMode)}><option value="online">Basemap: OpenFreeMap (online)</option><option value="offline">Basemap: offline outlines</option></select>
        </div>
        {findPlace && <div className="world-place">
          <PlaceSearch autoFocus onPick={p => setPlace({ p, fit: { bounds: placeBounds(p), n: Date.now(), maxZoom: 12 } })} onClose={() => { setFindPlace(false); setPlace(null); }} />
          {place && <small className="muted">Showing {place.p.name}{place.p.type ? ` (${place.p.type}${place.p.region ? `, ${place.p.region}` : ''})` : ''} on the globe. Records are not filtered.</small>}
        </div>}
        {ctx.focus && <div className="focus-chip" role="status">
          <span>{focusCount ? <>Showing <b>{focusCount}</b> record{focusCount === 1 ? '' : 's'} for <b>{ctx.focus.label}</b>.</> : <>None of <b>{ctx.focus.label}</b>’s records are on this board.</>}</span>
          {focusBoards.map(b => <button key={b.id} className="button subtle small" onClick={() => ctx.selectBoard(b.id)}>{b.name}</button>)}
          <button className="button subtle small" onClick={() => ctx.setFocus(null)}><X size={12} /> Clear</button>
        </div>}
        {query.trim() && <div className="search-status" role="status">
          {filtered.length ? <span>{filtered.length} of {board.events.length} record{board.events.length === 1 ? '' : 's'} on this board match “{query.trim()}”. Press Enter to go to the first one on the map.</span>
            : <span>No records on this board match “{query.trim()}”. Press Enter to search Wikipedia, Wikidata and news instead.</span>}
          <button className="button subtle small" onClick={() => ctx.searchWorld(query.trim())}><Globe2 size={12} /> Search the world for “{query.trim()}”</button>
        </div>}
        {(from || to) && <label className="undated-toggle"><input type="checkbox" checked={includeUndated} onChange={e => setIncludeUndated(e.target.checked)} /> Keep undated records visible while a date filter is on</label>}
        {statusText && <div className="map-status">{statusText} <button className="text-button" onClick={() => { setBasemap('offline'); setTimeout(() => setBasemap('online'), 50); }}>Retry online</button></div>}
        <div className="map-host">
          <InteractiveMap events={mapEvents} similarIds={similarMode ? similarIds : []} selectedId={selectedId} focus={focus} fit={place && (!focusFit || place.fit.n > focusFit.n) ? place.fit : focusFit}
            showCountries={layers.includes('Countries')} showCasualties={layers.includes('Casualties')} basemap={basemap} pickMode={ctx.pickMode}
            onSelect={id => select(id, false)} onOpen={openRecord} onAddAt={(lng, lat) => ctx.newRecord({ longitude: lng, latitude: lat, locationPrecision: 'Unknown' })}
            onPick={ctx.onPick} onStatus={setStatus} />
        </div>
        <div className="map-legend">
          <span className="legend-items">{VERIFICATION.map(v => <span key={v}><i style={{ background: VERIFICATION_COLORS[v] }} />{v}</span>)}<span><i className="ring" />Similar</span>{layers.includes('Casualties') && <span><i className="ring red" />Reported figure (size)</span>}</span>
          <span>{mapEvents.filter(hasCoords).length} of {board.events.length} records on the globe{board.events.length - quality.placed ? ` · ${board.events.length - quality.placed} without coordinates` : ''}</span>
        </div>
        <p className="map-attrib-note">Basemap © OpenMapTiles / OpenStreetMap contributors via OpenFreeMap (needs internet on the Windows host). Offline outlines: Natural Earth (public domain). Borders are illustrative and may not reflect every claim.</p>
      </div>

      <aside className="map-side">
        <div className="panel-head"><div><h2>Map layers</h2><p>A record shows if it matches any enabled layer</p></div><button className="icon-action" aria-label="Layer rules" onClick={() => setShowRules(x => !x)}><HelpCircle size={14} /></button></div>
        {showRules && <div className="layer-rules">{LAYERS.map(l => <p key={l.key}><b>{l.key}:</b> {l.rule}</p>)}<p>These layers only display records supplied in this workspace.</p></div>}
        {LAYERS.map((l, i) => {
          const count = l.key === 'Countries' ? null : filtered.filter(e => l.test?.(e)).length;
          return <label className="layer" key={l.key}>
            <span className={'layer-glyph g' + i}>{LAYER_ICON[l.key] || <Layers3 size={11} />}</span>
            <span className="layer-name">{l.key}{count != null && <small>{count}</small>}</span>
            <button type="button" className="only" onClick={e => { e.preventDefault(); setLayers(l.key === 'Countries' ? ['Countries'] : [l.key, ...(layers.includes('Countries') ? ['Countries'] : [])]); }}>only</button>
            <input type="checkbox" checked={layers.includes(l.key)} onChange={() => setLayers(a => (a.includes(l.key) ? a.filter(x => x !== l.key) : [...a, l.key]))} />
          </label>;
        })}
        <button className="text-button" onClick={() => setLayers(ALL_LAYERS)}>Show all layers</button>

        <label className="layer similarity-toggle"><span className="layer-glyph similarity-glyph"><Sparkles size={12} /></span><span className="layer-name">Find similar historical records</span><input type="checkbox" checked={similarMode} onChange={() => setSimilarMode(x => !x)} /></label>
        {similarMode && <SimilarityPanel selected={selected} pool={pool} scope={scope} setScope={setScope} links={allLinks} onMatches={setSimilarIds} onSelect={id => select(id)} onLink={createComparison} />}

        {selected && <><div className="divider" /><RecordSummary e={selected} compact onEdit={() => openRecord(selected.id)} /></>}

        <div className="divider" />
        <div className="panel-head"><div><h2>Records</h2><p>{listed.length} shown · {quality.total} on this board</p></div><button className="icon-action" aria-label="Add record" disabled={ctx.readOnly} onClick={() => ctx.newRecord()}><Plus size={14} /></button></div>
        <div className="quality-chips">
          {([['all', `All`], ['unplaced', `No coordinates (${quality.total - quality.placed})`], ['unsourced', `Unsourced (${quality.unsourced})`], ['placeholder', `Placeholders (${quality.placeholders.length})`]] as const).map(([k, label]) => <button key={k} className={listFilter === k ? 'on' : ''} onClick={() => setListFilter(k)}>{label}</button>)}
        </div>
        {listFilter === 'placeholder' && quality.placeholders.length > 0 && <button className="button danger small" disabled={ctx.readOnly} onClick={removePlaceholders}><Trash2 size={12} /> Remove untouched placeholders</button>}
        {listed.slice(0, listLimit).map(e => <button className={'event-row' + (e.id === selectedId ? ' selected' : '')} key={e.id} onClick={() => select(e.id)} onDoubleClick={() => openRecord(e.id)}>
          <i style={{ background: VERIFICATION_COLORS[e.verification] }} />
          <span><b>{e.name || 'Untitled record'}</b><small>{formatDateRange(e)} · {e.place || 'no place'} · {e.evidence.length} src{hasCoords(e) ? '' : ' · not on globe'}</small></span>
          <ChevronRight size={13} onClick={ev => { ev.stopPropagation(); openRecord(e.id); }} />
        </button>)}
        {listed.length > listLimit && <button className="text-button" onClick={() => setListLimit(n => n + 300)}>Show more ({listed.length - listLimit} remaining)</button>}
        {query.trim() && !filtered.length ? <NoMatch ctx={ctx} query={query.trim()} />
          : !board.events.length && <div className="empty-side"><Database size={18} /><p>No records yet. Add one, click the globe, or import a properly licensed dataset (e.g. UCDP GED).</p></div>}

        {board.imports.length > 0 && <><div className="divider" /><div className="panel-head"><div><h2>Import log</h2><p>Where these records came from</p></div></div>
          {board.imports.slice().reverse().map(i => <div key={i.id} className={'import-log' + (i.removedAt ? ' removed' : '')}>
            <b>{i.dataset.name}{i.dataset.version ? ` v${i.dataset.version}` : ''}</b>
            <small>{i.importedAt.slice(0, 10)} · {i.fileName} · {i.imported} imported, {i.skipped} skipped{i.flaggedDuplicates ? `, ${i.flaggedDuplicates} flagged duplicates` : ''}</small>
            <small>License: {i.dataset.license}{i.dataset.url ? ` · ${i.dataset.url}` : ''}</small>
            {i.removedAt ? <small className="muted">Records removed {i.removedAt.slice(0, 10)}</small> : <button className="text-button danger" disabled={ctx.readOnly} onClick={() => removeBatch(i.id)}><Trash2 size={11} /> Remove this import’s records</button>}
          </div>)}</>}
        <div className="map-care"><Shield size={14} /> Keep facts, allegations, estimates and interpretations apart. Qualify attribution and casualty figures, and cite the source for each.</div>
      </aside>
    </div>
  </section>;
}

/** Explains an empty search: it only covers records on this board, and the name may be a graph node or on another board. */
function NoMatch({ ctx, query }: { ctx: Ctx; query: string }) {
  const { board, project } = ctx;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const filteredOut = board.events.filter(e => matchesQuery(recordSearchText(e), query)).length;
  const nodes = board.nodes.filter(n => matchesQuery(nodeSearchText(n), query)).length;
  const others = project.boards.filter(b => b.id !== board.id).map(b => ({ b, n: b.events.filter(e => matchesQuery(recordSearchText(e), query)).length })).filter(x => x.n);
  return <div className="empty-side" role="status"><Search size={18} />
    <p>{filteredOut ? `${plural(filteredOut, 'record')} ${filteredOut === 1 ? 'matches' : 'match'} “${query}”, but the date or verification filter hides them.` : `No records on this board match “${query}”.`} Search looks only at records you entered or imported on this board. Atlas has no built-in event data.</p>
    {nodes > 0 && <button className="button subtle" onClick={() => ctx.setView('Graph')}><Network size={13} /> {plural(nodes, 'graph node')} on this board {nodes === 1 ? 'matches' : 'match'}: open Graph</button>}
    {others.map(({ b, n }) => <button key={b.id} className="button subtle" onClick={() => ctx.selectBoard(b.id)}>{plural(n, 'record')} on “{b.name}”</button>)}
  </div>;
}
