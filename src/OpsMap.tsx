// The Map workspace's map: satellite or street basemap, drawings, resources and records, with Terra Draw for drawing
// and reshaping. It only reports what the user did (onCreate, onGeometry, …); the page saves it to the board.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, Marker, NavigationControl, ScaleControl, type GeoJSONSource, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { TerraDraw, TerraDrawCircleMode, TerraDrawLineStringMode, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { EventItem, MapFeature, MapGeometry, Resource } from './types.ts';
import { offlineStyle, onlineStyle } from './InteractiveMap.tsx';
import { VERIFICATION_COLORS, hasCoords, uid } from './model.ts';
import { bearing, formatArea, formatDistance, lineKm, lineMidpoint, polygonCenter, polygonKm2, type LngLat } from './geo.ts';
import { RESOURCE_STATUS } from './ops.ts';
import { RESOURCE_ICONS, SYMBOL_ICONS, iconSvg } from './opsIcons.tsx';

export type Basemap = 'esri' | 'eox' | 'streets' | 'outlines';
export type Tool = 'select' | 'marker' | 'route' | 'area' | 'rectangle' | 'circle' | 'label' | 'measure' | 'place';
/** Where to move the map: a point and zoom, or bounds to fit (for routes and areas). */
export type Focus = { lng: number; lat: number; zoom: number; n: number; bounds?: [LngLat, LngLat] };
type Props = {
  features: MapFeature[]; hiddenLayers: Set<string>; lockedLayers: Set<string>;
  resources: Resource[]; records: EventItem[]; showRecords: boolean;
  basemap: Basemap; tool: Tool; selectedId: string; reshapeId: string; readOnly: boolean; focus?: Focus;
  /** A place found by place search: a temporary pin with its name (satellite images have no labels). */
  pin?: { lng: number; lat: number; label: string } | null;
  onCreate: (kind: MapFeature['kind'], geometry: MapGeometry, shape?: MapFeature['shape']) => void;
  onSelect: (kind: 'feature' | 'resource' | '', id: string) => void;
  onGeometry: (id: string, geometry: MapGeometry) => void;
  onResourceMove: (id: string, position: LngLat) => void;
  onPlace: (position: LngLat) => void;
  onMeasure: (text: string | null) => void;
  onStatus: (message: string) => void;
};

const DRAW_MODE: Partial<Record<Tool, string>> = { route: 'linestring', area: 'polygon', rectangle: 'rectangle', circle: 'circle', measure: 'measure' };
const SHAPES = 'ops-shapes', RECORDS = 'ops-records';
const SHAPE_LAYERS = ['ops-route-line', 'ops-route-casing', 'ops-area-fill', 'ops-area-line'];
const SAT_ATTRIBUTION = {
  esri: 'Imagery © Esri, Maxar, Earthstar Geographics',
  eox: '<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless 2023</a> © EOX (Copernicus data), CC BY-NC-SA 4.0',
};

async function styleFor(b: Basemap): Promise<StyleSpecification> {
  if (b === 'esri' || b === 'eox') {
    return {
      version: 8, name: `Atlas satellite (${b})`,
      sources: { sat: { type: 'raster', tiles: [`${location.origin}/api/map/sat/${b}/{z}/{x}/{y}`], tileSize: 256, maxzoom: b === 'esri' ? 19 : 15, attribution: SAT_ATTRIBUTION[b] } },
      layers: [{ id: 'ops-bg', type: 'background', paint: { 'background-color': '#0b121b' } }, { id: 'sat', type: 'raster', source: 'sat' }],
    };
  }
  if (b === 'streets') { try { return await onlineStyle(); } catch { return offlineStyle(); } }
  return offlineStyle();
}

const pointOf = (f: MapFeature): LngLat | null => (f.geometry.type === 'Point' ? f.geometry.coordinates : null);
function el(cls: string, html = '', color = '') {
  const n = document.createElement('div');
  n.className = cls;
  if (color) n.style.setProperty('--c', color);
  n.innerHTML = html;
  return n;
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const sameGeometry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function OpsMap(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const draw = useRef<TerraDraw | null>(null);
  const overlays = useRef<Marker[]>([]);
  const fitted = useRef(false);
  const finishedAt = useRef(0);
  const latest = useRef(props);
  latest.current = props;
  const [styleGen, setStyleGen] = useState(0);

  const shapes = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: props.features
      .filter(f => (f.kind === 'route' || f.kind === 'area') && !props.hiddenLayers.has(f.layer) && f.id !== props.reshapeId)
      .map(f => ({ type: 'Feature' as const, geometry: f.geometry, properties: { id: f.id, kind: f.kind, color: f.color, selected: f.id === props.selectedId } })),
  }), [props.features, props.hiddenLayers, props.reshapeId, props.selectedId]);
  const records = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: props.showRecords ? props.records.filter(hasCoords).map(e => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [e.longitude!, e.latitude!] }, properties: { id: e.id, color: VERIFICATION_COLORS[e.verification] || '#8a96aa' } })) : [],
  }), [props.records, props.showRecords]);
  const data = useRef({ shapes, records });
  data.current = { shapes, records };

  // ---------- map, layers and Terra Draw (recreated whenever the basemap style loads) ----------
  const addLayers = (m: MapLibreMap) => {
    if (!m.getSource(SHAPES)) m.addSource(SHAPES, { type: 'geojson', data: data.current.shapes as any });
    if (!m.getSource(RECORDS)) m.addSource(RECORDS, { type: 'geojson', data: data.current.records as any });
    const area = ['==', ['get', 'kind'], 'area'] as any, route = ['==', ['get', 'kind'], 'route'] as any, sel = ['==', ['get', 'selected'], true] as any;
    if (!m.getLayer('ops-records')) m.addLayer({ id: 'ops-records', type: 'circle', source: RECORDS, paint: { 'circle-radius': 4.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#f4f7fb', 'circle-stroke-width': 1.2 } });
    if (!m.getLayer('ops-area-fill')) m.addLayer({ id: 'ops-area-fill', type: 'fill', source: SHAPES, filter: area, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', sel, 0.4, 0.24] } });
    if (!m.getLayer('ops-area-line')) m.addLayer({ id: 'ops-area-line', type: 'line', source: SHAPES, filter: area, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', sel, 3.5, 2] } });
    if (!m.getLayer('ops-route-casing')) m.addLayer({ id: 'ops-route-casing', type: 'line', source: SHAPES, filter: route, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#05080d', 'line-width': ['case', sel, 9, 7], 'line-opacity': 0.55 } });
    if (!m.getLayer('ops-route-line')) m.addLayer({ id: 'ops-route-line', type: 'line', source: SHAPES, filter: route, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', sel, 5, 3.5] } });
  };
  const startDraw = (m: MapLibreMap) => {
    try { draw.current?.stop(); } catch {}
    const td = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map: m }),
      idStrategy: { isValidId: id => typeof id === 'string' && id.length > 0, getId: () => uid() },
      modes: [
        new TerraDrawLineStringMode({ styles: { lineStringColor: '#e9b670', lineStringWidth: 3.5, closingPointColor: '#f4f7fb', closingPointWidth: 5 } }),
        new TerraDrawLineStringMode({ modeName: 'measure', styles: { lineStringColor: '#58c4dd', lineStringWidth: 2.5, closingPointColor: '#f4f7fb', closingPointWidth: 4 } }),
        new TerraDrawPolygonMode({ styles: { fillColor: '#729cf5', fillOpacity: 0.25, outlineColor: '#729cf5', outlineWidth: 2.5 } }),
        new TerraDrawRectangleMode({ styles: { fillColor: '#729cf5', fillOpacity: 0.25, outlineColor: '#729cf5', outlineWidth: 2.5 } }),
        new TerraDrawCircleMode({ styles: { fillColor: '#729cf5', fillOpacity: 0.25, outlineColor: '#729cf5', outlineWidth: 2.5 } }),
        new TerraDrawSelectMode({
          flags: {
            linestring: { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } },
            polygon: { feature: { draggable: true, coordinates: { midpoints: true, draggable: true, deletable: true } } },
            rectangle: { feature: { draggable: true, coordinates: { draggable: true, resizable: 'opposite' } } },
            circle: { feature: { draggable: true, coordinates: { draggable: true, resizable: 'center-fixed' } } },
          },
          styles: { selectedLineStringColor: '#f4f7fb', selectedPolygonColor: '#f4f7fb', selectedPolygonOutlineColor: '#f4f7fb', selectionPointColor: '#f4f7fb', midPointColor: '#58c4dd' },
        }),
      ],
    });
    td.start();
    // A finished route or area becomes a board drawing; a finished measurement stays on screen until the tool changes.
    td.on('finish', (id, ctx) => {
      if (ctx.mode === 'select' || ctx.mode === 'measure') return;
      finishedAt.current = Date.now();
      const f = td.getSnapshotFeature(id);
      if (!f) return;
      const geometry = f.geometry as MapGeometry;
      try { td.removeFeatures([id]); } catch {}
      latest.current.onMeasure(null);
      if (ctx.mode === 'linestring') latest.current.onCreate('route', geometry);
      else latest.current.onCreate('area', geometry, ctx.mode === 'rectangle' || ctx.mode === 'circle' ? ctx.mode : 'polygon');
    });
    td.on('change', ids => {
      for (const id of ids) {
        const f = td.hasFeature(id) ? td.getSnapshotFeature(id) as GeoJSONStoreFeatures | undefined : undefined;
        const mode = String(f?.properties?.mode || '');
        if (!f || !['linestring', 'measure', 'polygon', 'rectangle', 'circle'].includes(mode)) continue;
        if (f.geometry.type === 'LineString') latest.current.onMeasure(formatDistance(lineKm(f.geometry.coordinates as LngLat[])));
        if (f.geometry.type === 'Polygon') latest.current.onMeasure(formatArea(polygonKm2(f.geometry.coordinates[0] as LngLat[])));
      }
    });
    draw.current = td;
    if (location.search.includes('debug=map')) Object.assign(window as any, { atlasOpsMap: m, atlasDraw: td });
    const mode = latest.current.reshapeId ? 'select' : DRAW_MODE[latest.current.tool] || 'static';
    try { td.setMode(mode); } catch {}
  };

  useEffect(() => {
    if (!host.current || map.current) return;
    let disposed = false;
    const m = new MapLibreMap({ container: host.current, style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b121b' } }] }, center: [20, 20], zoom: 1.6, maxZoom: 19, attributionControl: { compact: true }, dragRotate: false });
    map.current = m;
    if (location.search.includes('debug=map')) Object.assign(window as any, { atlasOpsMap: m });
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('style.load', () => {
      addLayers(m);
      try { startDraw(m); } catch (e) {
        // MapLibre swallows errors thrown in its events, so say it out loud.
        console.error('Atlas: the drawing tools could not start', e);
        latest.current.onStatus(`The drawing tools could not start: ${(e as Error).message}`);
      }
      setStyleGen(g => g + 1);
      if (!fitted.current) {
        fitted.current = true;
        const pts: LngLat[] = [];
        for (const f of latest.current.features) {
          if (f.geometry.type === 'Point') pts.push(f.geometry.coordinates);
          if (f.geometry.type === 'LineString') pts.push(...f.geometry.coordinates);
          if (f.geometry.type === 'Polygon') pts.push(...f.geometry.coordinates[0]);
        }
        for (const r of latest.current.resources) if (r.position) pts.push(r.position);
        if (pts.length) {
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 80, maxZoom: 16, duration: 0 });
        }
      }
    });
    let tileErrors = 0;
    m.on('error', ev => { if ((ev as any).sourceId === 'sat' && ++tileErrors === 5) latest.current.onStatus('Some satellite tiles failed to load. Check the Windows PC’s internet connection or try the other imagery.'); });
    m.on('click', (ev: MapMouseEvent) => {
      const p = latest.current, at: LngLat = [Math.round(ev.lngLat.lng * 1e6) / 1e6, Math.round(ev.lngLat.lat * 1e6) / 1e6];
      if (p.readOnly && p.tool !== 'select') return;
      if (p.tool === 'marker' || p.tool === 'label') { p.onCreate(p.tool, { type: 'Point', coordinates: at }); return; }
      if (p.tool === 'place') { p.onPlace(at); return; }
      // The click that finishes a route or area also arrives here, after the tool has switched back to Select.
      if (p.tool !== 'select' || p.reshapeId || Date.now() - finishedAt.current < 500) return;
      const hit = m.queryRenderedFeatures(ev.point, { layers: SHAPE_LAYERS.filter(l => m.getLayer(l)) })[0];
      const id = String(hit?.properties?.id || '');
      const f = p.features.find(x => x.id === id);
      p.onSelect(f && !p.lockedLayers.has(f.layer) ? 'feature' : '', f && !p.lockedLayers.has(f.layer) ? id : '');
    });
    styleFor(latest.current.basemap).then(s => { if (!disposed) m.setStyle(s, { diff: false }); });
    return () => { disposed = true; try { draw.current?.stop(); } catch {} draw.current = null; m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstBasemap = useRef(true);
  useEffect(() => {
    if (firstBasemap.current) { firstBasemap.current = false; return; }
    let cancelled = false;
    styleFor(props.basemap).then(s => { if (!cancelled && map.current) { try { draw.current?.stop(); } catch {} map.current.setStyle(s, { diff: false }); } });
    return () => { cancelled = true; };
  }, [props.basemap]);

  useEffect(() => { (map.current?.getSource(SHAPES) as GeoJSONSource | undefined)?.setData(shapes as any); }, [shapes, styleGen]);
  useEffect(() => { (map.current?.getSource(RECORDS) as GeoJSONSource | undefined)?.setData(records as any); }, [records, styleGen]);

  // ---------- tools ----------
  useEffect(() => {
    const td = draw.current, m = map.current;
    if (!td || !m) return;
    if (props.reshapeId) return; // the reshape effect owns the mode
    try { td.clear(); td.setMode(DRAW_MODE[props.tool] || 'static'); } catch {}
    props.onMeasure(null);
    m.getCanvas().style.cursor = props.tool === 'select' ? '' : 'crosshair';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tool, styleGen, props.reshapeId]);

  // Reshape: the drawing moves into Terra Draw's select mode; its new geometry is reported when reshaping ends.
  useEffect(() => {
    const td = draw.current, id = props.reshapeId;
    if (!td || !id) return;
    const f = latest.current.features.find(x => x.id === id);
    if (!f || f.geometry.type === 'Point') return;
    const mode = f.kind === 'route' ? 'linestring' : f.shape || 'polygon';
    try { td.clear(); } catch {}
    let ok = td.addFeatures([{ id, type: 'Feature', geometry: f.geometry as any, properties: { mode } }])[0]?.valid;
    if (!ok && mode !== 'polygon' && mode !== 'linestring') ok = td.addFeatures([{ id, type: 'Feature', geometry: f.geometry as any, properties: { mode: 'polygon' } }])[0]?.valid;
    if (!ok) { latest.current.onStatus('This shape cannot be reshaped. Delete it and draw it again.'); return; }
    try { td.setMode('select'); td.selectFeature(id); } catch {}
    if (map.current) map.current.getCanvas().style.cursor = '';
    return () => {
      const snap = draw.current?.hasFeature(id) ? draw.current.getSnapshotFeature(id) : undefined;
      if (snap && !sameGeometry(snap.geometry, f.geometry)) latest.current.onGeometry(id, snap.geometry as MapGeometry);
      try { draw.current?.clear(); draw.current?.setMode(DRAW_MODE[latest.current.tool] || 'static'); } catch {}
    };
  }, [props.reshapeId, styleGen]);

  // ---------- markers, labels, captions, route arrows and resources (DOM overlays) ----------
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const o of overlays.current) o.remove();
    overlays.current = [];
    const p = props, selectTool = p.tool === 'select' && !p.reshapeId;
    const add = (node: HTMLElement, at: LngLat, opts: { draggable?: boolean; rotation?: number; onClick?: () => void; onDragEnd?: (at: LngLat) => void } = {}) => {
      if (opts.onClick) node.addEventListener('click', e => { if (latest.current.tool === 'select') { e.stopPropagation(); opts.onClick!(); } });
      const mk = new Marker({ element: node, draggable: !!opts.draggable, ...(opts.rotation != null ? { rotation: opts.rotation, rotationAlignment: 'map' as const } : {}) }).setLngLat(at).addTo(m);
      if (opts.onDragEnd) mk.on('dragend', () => { const ll = mk.getLngLat(); opts.onDragEnd!([Math.round(ll.lng * 1e6) / 1e6, Math.round(ll.lat * 1e6) / 1e6]); });
      overlays.current.push(mk);
    };
    for (const f of p.features) {
      if (p.hiddenLayers.has(f.layer)) continue;
      const locked = p.lockedLayers.has(f.layer), sel = f.id === p.selectedId ? ' selected' : '';
      const select = locked ? undefined : () => latest.current.onSelect('feature', f.id);
      const move = !locked && !p.readOnly && selectTool ? (at: LngLat) => latest.current.onGeometry(f.id, { type: 'Point', coordinates: at }) : undefined;
      const pt = pointOf(f);
      if (f.kind === 'marker' && pt) add(el(`ops-marker${sel}`, `<span class="ops-marker-icon">${iconSvg(SYMBOL_ICONS[f.symbol])}</span>${f.name ? `<span class="ops-marker-name">${escapeHtml(f.name)}</span>` : ''}`, f.color), pt, { draggable: !!move, onClick: select, onDragEnd: move });
      if (f.kind === 'label' && pt) add(el(`ops-label${sel}`, escapeHtml(f.name || 'Label'), f.color), pt, { draggable: !!move, onClick: select, onDragEnd: move });
      if (f.id === p.reshapeId) continue;
      if (f.geometry.type === 'LineString') {
        const c = f.geometry.coordinates as LngLat[];
        add(el(`ops-caption${sel}`, escapeHtml([f.name, formatDistance(lineKm(c))].filter(Boolean).join(' · ')), f.color), lineMidpoint(c), { onClick: select });
        add(el('ops-arrow', '', f.color), c[c.length - 1], { rotation: bearing(c[c.length - 2], c[c.length - 1]) });
      }
      if (f.geometry.type === 'Polygon') {
        const ring = f.geometry.coordinates[0] as LngLat[];
        add(el(`ops-caption${sel}`, escapeHtml([f.name, formatArea(polygonKm2(ring))].filter(Boolean).join(' · ')), f.color), polygonCenter(ring), { onClick: select });
      }
    }
    for (const r of p.resources) {
      if (!r.position) continue;
      const sel = r.id === p.selectedId ? ' selected' : '';
      add(el(`ops-resource${sel}`, `<span class="ops-marker-icon">${iconSvg(RESOURCE_ICONS[r.type])}</span><span class="ops-marker-name">${escapeHtml(r.name)}</span>`, RESOURCE_STATUS[r.status] || '#7f8ca0'), r.position, {
        draggable: !p.readOnly && selectTool, onClick: () => latest.current.onSelect('resource', r.id), onDragEnd: at => latest.current.onResourceMove(r.id, at),
      });
    }
    if (p.pin) add(el('ops-pin', `<span class="ops-pin-dot"></span><span class="ops-marker-name">${escapeHtml(p.pin.label)}</span>`, '#e9b670'), [p.pin.lng, p.pin.lat]);
  }, [props.features, props.resources, props.hiddenLayers, props.lockedLayers, props.selectedId, props.reshapeId, props.tool, props.readOnly, props.pin, styleGen]);

  useEffect(() => {
    const f = props.focus, m = map.current;
    if (!f || !m) return;
    if (f.bounds) m.fitBounds(f.bounds, { padding: 70, maxZoom: f.zoom, duration: 900 });
    else m.flyTo({ center: [f.lng, f.lat], zoom: f.zoom, duration: 900 });
  }, [props.focus?.n]);

  return <div ref={host} className="ops-map-canvas" />;
}
