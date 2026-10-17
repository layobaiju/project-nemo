import { useEffect, useMemo, useState } from 'react';
import { Circle, Crosshair, Download, Eye, EyeOff, Layers, ListTodo, Lock, LockOpen, MapPin, MousePointer2, Pentagon, Plus, Radio, Route, Ruler, Square, Trash2, Type, X } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import type { Board, MapFeature, MapGeometry } from '../types.ts';
import { uid } from '../model.ts';
import { lineMidpoint, placeBounds, polygonCenter, type LngLat, type Place } from '../geo.ts';
import {
  COLORS, DEFAULT_LAYER, RESOURCE_STATUS, RESOURCE_TYPES, SYMBOLS, TASK_TYPES, addFeature, addLayer, addResource, createTask, deleteFeature, deleteLayer,
  deleteResource, deleteTask, drawingsGeoJSON, measureOf, nextStatuses, setTaskStatus, updateFeature, updateLayer, updateResource,
} from '../ops.ts';
import { download, safeName } from '../exporters.ts';
import { usePersisted } from '../usePersisted.ts';
import { RESOURCE_ICONS, SYMBOL_ICONS } from '../opsIcons.tsx';
import OpsMap, { type Basemap, type Focus, type Tool } from '../OpsMap.tsx';
import PlaceSearch from './PlaceSearch.tsx';

const TOOLS: [Tool, string, typeof MapPin, string][] = [
  ['select', 'Select', MousePointer2, 'Click a drawing or resource to edit it. Drag markers to move them.'],
  ['marker', 'Marker', MapPin, 'Click the map to place the chosen symbol. Click again for more.'],
  ['route', 'Route', Route, 'Click to add points along the route; click the last point again (or double-click) to finish.'],
  ['area', 'Area', Pentagon, 'Click the corners; click the first point to close the area.'],
  ['rectangle', 'Rectangle', Square, 'Click one corner, then the opposite corner.'],
  ['circle', 'Circle', Circle, 'Click the centre, then click again to set the radius.'],
  ['label', 'Label', Type, 'Click where the text should go, then type it in the panel.'],
  ['measure', 'Measure', Ruler, 'Click points to measure a distance; it is not saved.'],
];
const BASEMAPS: [Basemap, string][] = [['esri', 'Satellite (Esri, detailed)'], ['eox', 'Satellite (Sentinel-2)'], ['streets', 'Streets'], ['outlines', 'Outlines (offline)']];
const when = (iso: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');
function centerOf(f: MapFeature): LngLat {
  if (f.geometry.type === 'Point') return f.geometry.coordinates;
  if (f.geometry.type === 'LineString') return lineMidpoint(f.geometry.coordinates);
  return polygonCenter(f.geometry.coordinates[0]);
}
const featureTitle = (f: MapFeature) => f.name || (f.kind === 'marker' ? SYMBOLS.find(s => s.id === f.symbol)?.label || 'Marker' : f.kind === 'route' ? 'Route' : f.kind === 'area' ? 'Area' : 'Label');

/** The Map workspace: satellite map, drawings, resources and a task log, all saved with the current board. */
export default function MapWorkspace({ ctx }: { ctx: Ctx }) {
  const { board } = ctx;
  const features = board.mapFeatures || [], layers = board.mapLayers || [], resources = board.resources || [], tasks = board.tasks || [];
  const [tool, setTool] = useState<Tool>('select');
  const [symbol, setSymbol] = useState('flag');
  const [color, setColor] = useState(COLORS[0]);
  const [selected, setSelected] = useState<{ kind: 'feature' | 'resource'; id: string } | null>(null);
  const [reshapeId, setReshapeId] = useState('');
  const [placing, setPlacing] = useState('');
  const [measure, setMeasure] = useState<string | null>(null);
  const [focus, setFocus] = useState<Focus>();
  const [status, setStatus] = useState('');
  const [drawLayer, setDrawLayer] = useState('');
  const [place, setPlace] = useState<Place | null>(null);
  const [tab, setTab] = usePersisted<'layers' | 'resources' | 'tasks'>('atlas.ops.tab', 'layers');
  const [basemap, setBasemap] = usePersisted<Basemap>('atlas.ops.basemap', 'esri');
  const [showRecords, setShowRecords] = usePersisted('atlas.ops.records', true);
  const ro = ctx.readOnly;
  useEffect(() => { setSelected(null); setReshapeId(''); setPlacing(''); setTool('select'); }, [board.id]);
  useEffect(() => { if (status) { const t = setTimeout(() => setStatus(''), 6000); return () => clearTimeout(t); } }, [status]);

  const hidden = useMemo(() => new Set(layers.filter(l => !l.visible).map(l => l.id)), [layers]);
  const locked = useMemo(() => new Set(layers.filter(l => l.locked).map(l => l.id)), [layers]);
  const feature = selected?.kind === 'feature' ? features.find(f => f.id === selected.id) : undefined;
  const patch = (fn: (b: Board) => Board) => { if (!ro) ctx.patchBoard(fn); };
  const zoomTo = (f: MapFeature) => {
    const [lng, lat] = centerOf(f);
    const pts: LngLat[] = f.geometry.type === 'Point' ? [] : f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    setFocus({ lng, lat, zoom: 16, n: Date.now(), ...(pts.length ? { bounds: [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] as [LngLat, LngLat] } : {}) });
  };
  const chooseTool = (t: Tool) => { setReshapeId(''); setPlacing(''); setTool(t); };

  const onCreate = (kind: MapFeature['kind'], geometry: MapGeometry, shape?: MapFeature['shape']) => {
    if (ro) return;
    const id = uid();
    patch(b => addFeature(b, { id, kind, geometry, ...(shape ? { shape } : {}), symbol: kind === 'marker' ? symbol : '', color, name: kind === 'label' ? 'Label' : '', notes: '', layer: drawLayer || undefined }).board);
    setSelected({ kind: 'feature', id });
    if (kind !== 'marker') setTool('select');
  };
  // Place search: fly there and pin it; satellite images carry no place names.
  const goToPlace = (p: Place) => { setPlace(p); setFocus({ lng: p.lng, lat: p.lat, zoom: 16, n: Date.now(), bounds: placeBounds(p) }); };
  const addPlaceMarker = (p: Place) => {
    if (ro) return;
    const id = uid();
    patch(b => addFeature(b, { id, kind: 'marker', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, symbol: 'flag', color, name: p.name, notes: `${[p.type, p.region].filter(Boolean).join(' · ')} (found with OpenStreetMap place search)`, layer: drawLayer || undefined }).board);
    setSelected({ kind: 'feature', id }); setPlace(null);
  };
  const onPlace = (at: LngLat) => {
    if (!placing) return;
    patch(b => updateResource(b, placing, { position: at }));
    setPlacing(''); setTool('select');
  };

  return <section className="ops">
    <aside className="ops-panel">
      <div className="ops-panel-head"><div className="eyebrow">MAP WORKSPACE · {board.name.toUpperCase()}</div>
        <div className="ops-tabs" role="tablist">
          {([['layers', 'Layers', Layers], ['resources', 'Resources', Radio], ['tasks', 'Tasks', ListTodo]] as const).map(([k, label, Icon]) =>
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={13} /> {label}{k === 'resources' ? ` (${resources.length})` : k === 'tasks' ? ` (${tasks.filter(t => t.status !== 'Done' && t.status !== 'Cancelled').length})` : ''}</button>)}
        </div>
      </div>
      {feature && <FeatureEditor ctx={ctx} f={feature} layers={layers} reshaping={reshapeId === feature.id} tasks={tasks.filter(t => t.featureId === feature.id)}
        onClose={() => { setSelected(null); setReshapeId(''); }} onZoom={() => zoomTo(feature)}
        onReshape={() => { if (reshapeId === feature.id) setReshapeId(''); else { setTool('select'); setReshapeId(feature.id); } }}
        onDelete={() => { if (confirm(`Delete “${featureTitle(feature)}”?`)) { patch(b => deleteFeature(b, feature.id)); setSelected(null); setReshapeId(''); } }}
        patch={p => patch(b => updateFeature(b, feature.id, p))} />}
      <div className="ops-panel-body">
        {tab === 'layers' && <LayersTab ctx={ctx} features={features} layers={layers} drawLayer={drawLayer} setDrawLayer={setDrawLayer} showRecords={showRecords} setShowRecords={setShowRecords}
          recordCount={board.events.filter(e => e.longitude != null).length} selectedId={selected?.id || ''}
          onPick={f => { setSelected({ kind: 'feature', id: f.id }); zoomTo(f); }} patch={patch} />}
        {tab === 'resources' && <ResourcesTab ctx={ctx} patch={patch} selectedId={selected?.kind === 'resource' ? selected.id : ''} placing={placing}
          onPlace={id => { setPlacing(id); setTool('place'); setStatus('Click the map to place the resource.'); }}
          onFocus={(lng, lat) => setFocus({ lng, lat, zoom: 15, n: Date.now() })} />}
        {tab === 'tasks' && <TasksTab ctx={ctx} patch={patch} features={features} onFocusFeature={f => { setSelected({ kind: 'feature', id: f.id }); zoomTo(f); }} />}
      </div>
    </aside>

    <div className="ops-map">
      <OpsMap features={features} hiddenLayers={hidden} lockedLayers={locked} resources={resources} records={board.events} showRecords={showRecords}
        basemap={basemap} tool={tool} selectedId={selected?.id || ''} reshapeId={reshapeId} readOnly={ro} focus={focus} pin={place ? { lng: place.lng, lat: place.lat, label: place.name } : null}
        onCreate={onCreate} onSelect={(kind, id) => { setSelected(kind ? { kind, id } : null); if (kind === 'resource') setTab('resources'); }}
        onGeometry={(id, geometry) => patch(b => updateFeature(b, id, { geometry }))}
        onResourceMove={(id, position) => patch(b => updateResource(b, id, { position }))}
        onPlace={onPlace} onMeasure={setMeasure} onStatus={setStatus} />
      <div className="ops-toolbar" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(([t, label, Icon]) => <button key={t} className={tool === t ? 'on' : ''} aria-pressed={tool === t} title={label} disabled={ro && t !== 'select' && t !== 'measure'} onClick={() => chooseTool(t)}><Icon size={15} /><span>{label}</span></button>)}
      </div>
      {(tool === 'marker' || tool === 'route' || tool === 'area' || tool === 'rectangle' || tool === 'circle' || tool === 'label') && <div className="ops-style-picker">
        {tool === 'marker' && <div className="ops-symbols">{SYMBOLS.map(s => { const Icon = SYMBOL_ICONS[s.id]; return <button key={s.id} title={s.label} aria-label={s.label} className={symbol === s.id ? 'on' : ''} onClick={() => setSymbol(s.id)}><Icon size={14} /></button>; })}</div>}
        <div className="ops-colors">{COLORS.map(c => <button key={c} aria-label={`Colour ${c}`} className={color === c ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} />)}</div>
      </div>}
      <div className="ops-hint">{placing ? 'Click the map to place the resource.' : reshapeId ? 'Drag points to reshape; drag the middle dots to add points. Click “Done reshaping” in the panel when finished.' : TOOLS.find(t => t[0] === tool)?.[3]}{measure && <b> · {measure}</b>}</div>
      <div className="ops-map-actions">
        <PlaceSearch className="ops-place" onPick={goToPlace} onClose={() => setPlace(null)} />
        {place && <div className="ops-place-card"><MapPin size={13} /><span><b>{place.name}</b><small>{[place.type, place.region].filter(Boolean).join(' · ')}</small></span>
          <button className="button primary small" disabled={ro} onClick={() => addPlaceMarker(place)}><Plus size={12} /> Add as marker</button>
          <button className="place-close" aria-label="Remove the pin" onClick={() => setPlace(null)}><X size={12} /></button></div>}
        <select aria-label="Basemap" value={basemap} onChange={e => setBasemap(e.target.value as Basemap)}>{BASEMAPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="icon-action" title="Download drawings (GeoJSON)" aria-label="Download drawings as GeoJSON" onClick={() => download(`${safeName(board.name)}-map-drawings.geojson`, 'application/geo+json', JSON.stringify(drawingsGeoJSON(board), null, 2))}><Download size={14} /></button>
      </div>
      {status && <div className="ops-status" role="status">{status}</div>}
    </div>
  </section>;
}

function FeatureEditor({ ctx, f, layers, reshaping, tasks, onClose, onZoom, onReshape, onDelete, patch }: {
  ctx: Ctx; f: MapFeature; layers: Board['mapLayers'] & {}; reshaping: boolean; tasks: NonNullable<Board['tasks']>;
  onClose: () => void; onZoom: () => void; onReshape: () => void; onDelete: () => void; patch: (p: Partial<MapFeature>) => void;
}) {
  const ro = ctx.readOnly, size = measureOf(f), p = f.geometry.type === 'Point' ? f.geometry.coordinates : null;
  return <div className="ops-editor">
    <div className="ops-editor-head"><b>{f.kind === 'marker' ? 'Marker' : f.kind === 'route' ? 'Route' : f.kind === 'area' ? `Area${f.shape && f.shape !== 'polygon' ? ` (${f.shape})` : ''}` : 'Label'}{size ? ` · ${size}` : ''}</b><button className="icon-action" aria-label="Close" onClick={onClose}><X size={13} /></button></div>
    <input className="plain-input" aria-label="Name" placeholder={f.kind === 'label' ? 'Label text' : 'Name'} value={f.name} disabled={ro} onChange={e => patch({ name: e.target.value })} />
    {f.kind === 'marker' && <div className="ops-symbols">{SYMBOLS.map(s => { const Icon = SYMBOL_ICONS[s.id]; return <button key={s.id} title={s.label} aria-label={s.label} disabled={ro} className={f.symbol === s.id ? 'on' : ''} onClick={() => patch({ symbol: s.id })}><Icon size={13} /></button>; })}</div>}
    <div className="ops-colors">{COLORS.map(c => <button key={c} aria-label={`Colour ${c}`} disabled={ro} className={f.color === c ? 'on' : ''} style={{ background: c }} onClick={() => patch({ color: c })} />)}</div>
    <label className="ops-field">Layer<select value={f.layer} disabled={ro} onChange={e => patch({ layer: e.target.value })}>{layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <textarea className="plain-input" rows={2} aria-label="Notes" placeholder="Notes" value={f.notes} disabled={ro} onChange={e => patch({ notes: e.target.value })} />
    {p && <small className="muted">{p[1].toFixed(5)}, {p[0].toFixed(5)}</small>}
    {tasks.length > 0 && <small className="muted">Used by {tasks.length} task{tasks.length === 1 ? '' : 's'}: {tasks.map(t => t.title).join(', ')}</small>}
    <div className="ops-editor-actions">
      <button className="button subtle small" onClick={onZoom}><Crosshair size={12} /> Zoom to</button>
      {(f.kind === 'route' || f.kind === 'area') && <button className={`button ${reshaping ? 'primary' : 'subtle'} small`} disabled={ro} onClick={onReshape}>{reshaping ? 'Done reshaping' : 'Reshape'}</button>}
      <button className="button danger small" disabled={ro} onClick={onDelete}><Trash2 size={12} /> Delete</button>
    </div>
  </div>;
}

function LayersTab({ ctx, features, layers, drawLayer, setDrawLayer, showRecords, setShowRecords, recordCount, selectedId, onPick, patch }: {
  ctx: Ctx; features: MapFeature[]; layers: NonNullable<Board['mapLayers']>; drawLayer: string; setDrawLayer: (id: string) => void; showRecords: boolean; setShowRecords: (v: boolean) => void;
  recordCount: number; selectedId: string; onPick: (f: MapFeature) => void; patch: (fn: (b: Board) => Board) => void;
}) {
  const ro = ctx.readOnly;
  return <>
    <div className="ops-row">
      <label className="ops-field">Draw into<select value={drawLayer} disabled={ro} onChange={e => setDrawLayer(e.target.value)}><option value="">{DEFAULT_LAYER}</option>{layers.filter(l => l.name !== DEFAULT_LAYER).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <button className="button subtle small" disabled={ro} onClick={() => { const name = prompt('Name of the new layer (e.g. Routes, Hazards)'); if (name?.trim()) patch(b => addLayer(b, name).board); }}><Plus size={12} /> Layer</button>
    </div>
    {!features.length && <p className="muted small">Nothing drawn yet. Pick a tool above the map: Marker, Route, Area, Rectangle, Circle or Label.</p>}
    {layers.map(l => {
      const items = features.filter(f => f.layer === l.id);
      return <div className="ops-layer" key={l.id}>
        <div className="ops-layer-head">
          <button className="icon-action" aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`} onClick={() => patch(b => updateLayer(b, l.id, { visible: !l.visible }))} disabled={ro}>{l.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
          <button className="icon-action" aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`} onClick={() => patch(b => updateLayer(b, l.id, { locked: !l.locked }))} disabled={ro}>{l.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
          <b onDoubleClick={() => { if (ro || l.name === DEFAULT_LAYER) return; const n = prompt('Rename layer', l.name); if (n?.trim()) patch(b => updateLayer(b, l.id, { name: n.trim() })); }}>{l.name} <i>({items.length})</i></b>
          {l.name !== DEFAULT_LAYER && <button className="icon-action" aria-label={`Delete layer ${l.name}`} disabled={ro} onClick={() => { if (confirm(`Delete layer “${l.name}”? Its ${items.length} drawing(s) move to ${DEFAULT_LAYER}.`)) patch(b => deleteLayer(b, l.id)); }}><Trash2 size={12} /></button>}
        </div>
        {items.map(f => { const Icon = f.kind === 'marker' ? SYMBOL_ICONS[f.symbol] || MapPin : f.kind === 'route' ? Route : f.kind === 'area' ? Pentagon : Type; return <button key={f.id} className={'ops-item' + (f.id === selectedId ? ' on' : '')} onClick={() => onPick(f)}><i style={{ color: f.color }}><Icon size={13} /></i><span>{featureTitle(f)}</span><small>{measureOf(f)}</small></button>; })}
      </div>;
    })}
    <label className="ops-check"><input type="checkbox" checked={showRecords} onChange={e => setShowRecords(e.target.checked)} /> Show this board’s saved records ({recordCount} with a position)</label>
  </>;
}

function ResourcesTab({ ctx, patch, selectedId, placing, onPlace, onFocus }: {
  ctx: Ctx; patch: (fn: (b: Board) => Board) => void; selectedId: string; placing: string; onPlace: (id: string) => void; onFocus: (lng: number, lat: number) => void;
}) {
  const ro = ctx.readOnly, resources = ctx.board.resources || [];
  const [name, setName] = useState(''), [type, setType] = useState('Team');
  return <>
    <form className="ops-row" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; patch(b => addResource(b, { name: name.trim(), type }).board); setName(''); }}>
      <input className="plain-input" aria-label="Resource name" placeholder="Name (e.g. Team 1, Truck 2)" value={name} disabled={ro} onChange={e => setName(e.target.value)} />
      <select aria-label="Resource type" value={type} disabled={ro} onChange={e => setType(e.target.value)}>{RESOURCE_TYPES.map(t => <option key={t}>{t}</option>)}</select>
      <button className="button primary small" type="submit" disabled={ro || !name.trim()}><Plus size={12} /> Add</button>
    </form>
    {!resources.length && <p className="muted small">No resources yet. Add the teams, vehicles or equipment you are coordinating, then keep their status up to date.</p>}
    {resources.map(r => {
      const Icon = RESOURCE_ICONS[r.type] || Circle;
      return <div className={'ops-card' + (r.id === selectedId ? ' on' : '')} key={r.id}>
        <div className="ops-card-head"><i style={{ color: RESOURCE_STATUS[r.status] }}><Icon size={14} /></i>
          <input className="plain-input" aria-label="Resource name" value={r.name} disabled={ro} onChange={e => patch(b => updateResource(b, r.id, { name: e.target.value }))} />
          <span className="ops-chip" style={{ background: RESOURCE_STATUS[r.status] || '#7f8ca0' }}>{r.status}</span></div>
        <div className="ops-row">
          <select aria-label="Status" value={r.status} disabled={ro} onChange={e => patch(b => updateResource(b, r.id, { status: e.target.value }))}>{Object.keys(RESOURCE_STATUS).map(s => <option key={s}>{s}</option>)}</select>
          <select aria-label="Type" value={r.type} disabled={ro} onChange={e => patch(b => updateResource(b, r.id, { type: e.target.value }))}>{RESOURCE_TYPES.map(t => <option key={t}>{t}</option>)}</select>
        </div>
        <textarea className="plain-input" rows={1} aria-label="Notes" placeholder="Notes" value={r.notes} disabled={ro} onChange={e => patch(b => updateResource(b, r.id, { notes: e.target.value }))} />
        <div className="ops-editor-actions">
          {r.position ? <button className="button subtle small" onClick={() => onFocus(r.position![0], r.position![1])}><Crosshair size={12} /> Show</button> : null}
          <button className={`button ${placing === r.id ? 'primary' : 'subtle'} small`} disabled={ro} onClick={() => onPlace(r.id)}><MapPin size={12} /> {r.position ? 'Move on map' : 'Place on map'}</button>
          {r.position && <button className="button subtle small" disabled={ro} onClick={() => patch(b => updateResource(b, r.id, { position: null }))}>Remove from map</button>}
          <button className="icon-action" aria-label={`Delete ${r.name}`} disabled={ro} onClick={() => { if (confirm(`Delete resource “${r.name}”? Tasks keep their history.`)) patch(b => deleteResource(b, r.id)); }}><Trash2 size={12} /></button>
        </div>
        <small className="muted">Updated {when(r.updatedAt)}</small>
      </div>;
    })}
  </>;
}

function TasksTab({ ctx, patch, features, onFocusFeature }: { ctx: Ctx; patch: (fn: (b: Board) => Board) => void; features: MapFeature[]; onFocusFeature: (f: MapFeature) => void }) {
  const ro = ctx.readOnly, resources = ctx.board.resources || [], tasks = ctx.board.tasks || [];
  const [draft, setDraft] = useState({ title: '', type: TASK_TYPES[0], resourceId: '', featureId: '', note: '' });
  const [showAll, setShowAll] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const shown = [...tasks].filter(t => showAll || (t.status !== 'Done' && t.status !== 'Cancelled')).reverse();
  const named = features.filter(f => f.kind !== 'label');
  return <>
    <form className="ops-task-form" onSubmit={e => { e.preventDefault(); if (!draft.title.trim()) return; patch(b => createTask(b, draft, ctx.device).board); setDraft({ ...draft, title: '', note: '' }); }}>
      <input className="plain-input" aria-label="Task title" placeholder="New task (e.g. Check the north bridge)" value={draft.title} disabled={ro} onChange={e => setDraft({ ...draft, title: e.target.value })} />
      <div className="ops-row">
        <select aria-label="Task type" value={draft.type} disabled={ro} onChange={e => setDraft({ ...draft, type: e.target.value })}>{TASK_TYPES.map(t => <option key={t}>{t}</option>)}</select>
        <select aria-label="Assigned resource" value={draft.resourceId} disabled={ro} onChange={e => setDraft({ ...draft, resourceId: e.target.value })}><option value="">No resource</option>{resources.map(r => <option key={r.id} value={r.id}>{r.name} ({r.status})</option>)}</select>
      </div>
      <select aria-label="Linked drawing" value={draft.featureId} disabled={ro} onChange={e => setDraft({ ...draft, featureId: e.target.value })}><option value="">No linked drawing</option>{named.map(f => <option key={f.id} value={f.id}>{featureTitle(f)}{measureOf(f) ? ` · ${measureOf(f)}` : ''}</option>)}</select>
      <button className="button primary small" type="submit" disabled={ro || !draft.title.trim()}><Plus size={12} /> Request task</button>
    </form>
    <label className="ops-check"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show finished and cancelled tasks</label>
    {!shown.length && <p className="muted small">{tasks.length ? 'No open tasks.' : 'No tasks yet. Each status change is logged with the time and the device that made it.'}</p>}
    {shown.map(t => {
      const r = resources.find(x => x.id === t.resourceId), f = features.find(x => x.id === t.featureId);
      return <div className="ops-card" key={t.id}>
        <div className="ops-card-head"><b>{t.title}</b><span className={`ops-chip task-${t.status.replace(/\s/g, '-').toLowerCase()}`}>{t.status}</span></div>
        <small className="muted">{t.type}{r ? ` · ${r.name} (${r.status})` : ''}{f ? ' · ' : ''}{f && <button className="text-button inline" onClick={() => onFocusFeature(f)}>{featureTitle(f)}</button>}</small>
        {nextStatuses(t.status).length > 0 && <div className="ops-row">
          <input className="plain-input" aria-label="Note for the next status" placeholder="Note (optional)" value={notes[t.id] || ''} disabled={ro} onChange={e => setNotes({ ...notes, [t.id]: e.target.value })} />
          {nextStatuses(t.status).map(s => <button key={s} className={`button ${s === 'Cancelled' ? 'subtle' : 'primary'} small`} disabled={ro} onClick={() => { patch(b => setTaskStatus(b, t.id, s, ctx.device, notes[t.id] || '')); setNotes({ ...notes, [t.id]: '' }); }}>{s === 'Cancelled' ? 'Cancel' : s}</button>)}
        </div>}
        <button className="text-button" onClick={() => setOpen({ ...open, [t.id]: !open[t.id] })}>{open[t.id] ? 'Hide' : 'Show'} history ({t.log.length})</button>
        {open[t.id] && <ol className="ops-log">{t.log.map((l, i) => <li key={i}><time>{when(l.at)}</time><b>{l.status}</b><span>{l.by}{l.note ? ` · ${l.note}` : ''}</span></li>)}</ol>}
        {!ro && <button className="text-button danger" onClick={() => { if (confirm(`Delete task “${t.title}” and its history?`)) patch(b => deleteTask(b, t.id)); }}>Delete task</button>}
      </div>;
    })}
  </>;
}
