import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibreMap, Popup, NavigationControl, GlobeControl, ScaleControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import countriesUrl from 'world-atlas/countries-110m.json?url';
import type { EventItem } from './types.ts';
import { VERIFICATION_COLORS, formatDateRange, hasCoords } from './model.ts';

// Version-matched worker copied into the build by scripts/sync-maplibre-worker.mjs (served locally, no CDN).
setWorkerUrl('/assets/maplibre-gl-worker.mjs');

export type BasemapMode = 'online' | 'offline';
export type BasemapStatus = { mode: BasemapMode; ok: boolean; message?: string };
type Props = {
  events: EventItem[];
  similarIds: string[];
  selectedId?: string;
  focus?: { lng: number; lat: number; n: number };
  showCountries: boolean;
  showCasualties: boolean;
  basemap: BasemapMode;
  pickMode: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  /** Without it, clicking empty map does nothing (read-only maps such as the Investigate page). */
  onAddAt?: (lng: number, lat: number) => void;
  onPick: (lng: number, lat: number) => void;
  onStatus: (s: BasemapStatus) => void;
  /** Frames these bounds ([west, south], [east, north]) when n changes and after the basemap loads. */
  fit?: { bounds: [[number, number], [number, number]]; n: number; maxZoom?: number };
  /** Hides the usage note under the map. */
  compact?: boolean;
};

const SOURCE = 'atlas-events', CIRCLES = 'atlas-event-circles', HALOS = 'atlas-event-similarity', RINGS = 'atlas-casualty-rings', SELECTED = 'atlas-event-selected';
const COUNTRY_FILL = 'atlas-country-fill', COUNTRY_LINE = 'atlas-country-line';

export async function onlineStyle(): Promise<StyleSpecification> {
  const res = await fetch('/api/map/style', { credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail ? `${data.error} ${data.detail}` : data?.error || `Host returned ${res.status}`);
  return data;
}
let countriesCache: unknown = null;
export async function offlineStyle(): Promise<StyleSpecification> {
  if (!countriesCache) {
    const [{ feature }, topo] = await Promise.all([import('topojson-client'), fetch(countriesUrl).then(r => r.json())]);
    countriesCache = feature(topo, topo.objects.countries);
  }
  return {
    version: 8, name: 'Atlas offline outline',
    sources: { 'atlas-countries': { type: 'geojson', data: countriesCache as any, attribution: 'Country outlines: <a href="https://www.naturalearthdata.com/" target="_blank">Natural Earth</a> (public domain)' } },
    layers: [
      { id: 'atlas-bg', type: 'background', paint: { 'background-color': '#10283a' } },
      { id: COUNTRY_FILL, type: 'fill', source: 'atlas-countries', paint: { 'fill-color': '#24404f' } },
      { id: COUNTRY_LINE, type: 'line', source: 'atlas-countries', paint: { 'line-color': '#6f97a8', 'line-width': 0.8 } },
    ],
  };
}

function el(tag: string, cls?: string, text?: string) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export default function InteractiveMap(props: Props) {
  const { events, similarIds, selectedId, focus, showCountries, showCasualties, basemap } = props;
  const host = useRef<HTMLDivElement>(null), map = useRef<MapLibreMap | null>(null), popup = useRef<Popup | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [hoverCountry, setHoverCountry] = useState('');
  const [tileWarning, setTileWarning] = useState(false);

  const features = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: events.filter(hasCoords).map(e => {
      const fig = e.casualties.find(c => c.population === 'All / unspecified') || e.casualties[0];
      return {
        type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [e.longitude!, e.latitude!] },
        properties: {
          id: e.id, color: VERIFICATION_COLORS[e.verification] || '#8a96aa', similar: similarIds.includes(e.id), selected: e.id === selectedId,
          casualty: fig ? (fig.best ?? fig.high ?? fig.low ?? 0) : 0,
        },
      };
    }),
  }), [events, similarIds, selectedId]);
  const featuresRef = useRef(features);
  featuresRef.current = features;

  const applyVisibility = (m: MapLibreMap) => {
    const p = latest.current;
    for (const l of m.getStyle().layers || []) {
      const id = l.id.toLowerCase();
      const countryLayer = (l.type === 'symbol' && (id.includes('country') || id.includes('state'))) || (l.type === 'line' && id.includes('boundary')) || l.id === COUNTRY_LINE;
      if (countryLayer) try { m.setLayoutProperty(l.id, 'visibility', p.showCountries ? 'visible' : 'none'); } catch {}
    }
    if (m.getLayer(RINGS)) m.setLayoutProperty(RINGS, 'visibility', p.showCasualties ? 'visible' : 'none');
  };

  const addAtlasLayers = (m: MapLibreMap) => {
    try { m.setProjection({ type: 'globe' }); } catch {}
    if (!m.getSource(SOURCE)) m.addSource(SOURCE, { type: 'geojson', data: featuresRef.current as any });
    if (!m.getLayer(RINGS)) m.addLayer({ id: RINGS, type: 'circle', source: SOURCE, filter: ['>', ['get', 'casualty'], 0], paint: { 'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'casualty']], 0, 6, 1, 8, 10, 18, 40, 38], 'circle-color': '#e5656f', 'circle-opacity': 0.08, 'circle-stroke-color': '#e5656f', 'circle-stroke-opacity': 0.55, 'circle-stroke-width': 1 } });
    if (!m.getLayer(HALOS)) m.addLayer({ id: HALOS, type: 'circle', source: SOURCE, filter: ['==', ['get', 'similar'], true], paint: { 'circle-radius': 14, 'circle-color': '#b18cff', 'circle-opacity': 0.18, 'circle-stroke-color': '#b18cff', 'circle-stroke-width': 1.4 } });
    if (!m.getLayer(SELECTED)) m.addLayer({ id: SELECTED, type: 'circle', source: SOURCE, filter: ['==', ['get', 'selected'], true], paint: { 'circle-radius': 12, 'circle-opacity': 0, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    if (!m.getLayer(CIRCLES)) m.addLayer({ id: CIRCLES, type: 'circle', source: SOURCE, paint: { 'circle-radius': ['case', ['==', ['get', 'selected'], true], 7.5, 5.5], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#f4f7fb', 'circle-stroke-width': 1.3, 'circle-opacity': 0.95 } });
    applyVisibility(m);
  };

  const fitTo = (m: MapLibreMap) => {
    const f = latest.current.fit;
    if (f) try { m.fitBounds(f.bounds, { padding: 40, maxZoom: f.maxZoom ?? 8, duration: 0 }); } catch {}
  };

  const loadStyle = async (mode: BasemapMode): Promise<StyleSpecification> => {
    if (mode === 'offline') { latest.current.onStatus({ mode: 'offline', ok: true }); return offlineStyle(); }
    try {
      const s = await onlineStyle();
      latest.current.onStatus({ mode: 'online', ok: true });
      return s;
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'The Windows host did not answer in time.' : (e as Error).message;
      latest.current.onStatus({ mode: 'offline', ok: false, message: msg });
      return offlineStyle();
    }
  };

  useEffect(() => {
    if (!host.current || map.current) return;
    let disposed = false;
    const m = new MapLibreMap({ container: host.current, style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#08131c' } }] }, center: [10, 22], zoom: 1.25, minZoom: 0.6, maxZoom: 14, attributionControl: { compact: true }, dragRotate: true, touchPitch: true, cooperativeGestures: false });
    map.current = m;
    if (location.search.includes('debug=map')) (window as any).atlasMap = m;
    m.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    m.addControl(new GlobeControl(), 'top-right');
    m.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
    m.on('style.load', () => { addAtlasLayers(m); fitTo(m); });
    loadStyle(latest.current.basemap).then(s => { if (!disposed) m.setStyle(s, { diff: false }); });

    let tileErrors = 0;
    m.on('error', ev => { if ((ev as any).sourceId && (ev as any).sourceId !== SOURCE && ++tileErrors > 4) setTileWarning(true); });
    m.on('click', CIRCLES, (ev: MapLayerMouseEvent) => {
      const id = String(ev.features?.[0]?.properties?.id || '');
      const e = latest.current.events.find(x => x.id === id);
      if (!e) return;
      latest.current.onSelect(id);
      const box = el('div', 'atlas-popup');
      box.append(el('b', '', e.name || 'Untitled record'), el('span', '', e.place || 'Place not specified'), el('small', '', `${formatDateRange(e)} · ${e.verification} · ${e.evidence.length} source${e.evidence.length === 1 ? '' : 's'}`));
      if (e.provenance.dataset) box.append(el('small', 'muted', `From: ${e.provenance.dataset}${e.provenance.datasetLicense ? ` (${e.provenance.datasetLicense})` : ''}`));
      const open = el('button', 'popup-button', 'Open record') as HTMLButtonElement;
      open.onclick = () => { popup.current?.remove(); latest.current.onOpen(id); };
      box.append(open);
      popup.current?.remove();
      popup.current = new Popup({ closeButton: true, offset: 12, maxWidth: '280px' }).setLngLat(ev.lngLat).setDOMContent(box).addTo(m);
    });
    m.on('mouseenter', CIRCLES, () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', CIRCLES, () => { m.getCanvas().style.cursor = ''; });
    m.on('mousemove', (ev: MapMouseEvent) => {
      if (!m.getLayer(COUNTRY_FILL)) return;
      const f = m.queryRenderedFeatures(ev.point, { layers: [COUNTRY_FILL] })[0];
      setHoverCountry(String(f?.properties?.name || ''));
    });
    m.on('click', (ev: MapMouseEvent) => {
      if (m.getLayer(CIRCLES) && m.queryRenderedFeatures(ev.point, { layers: [CIRCLES] }).length) return;
      const { lng, lat } = ev.lngLat;
      if (latest.current.pickMode) { latest.current.onPick(lng, lat); return; }
      if (!latest.current.onAddAt) return;
      const box = el('div', 'atlas-popup');
      box.append(el('b', '', 'Add a record here?'), el('small', '', `${lat.toFixed(4)}, ${lng.toFixed(4)}`));
      const add = el('button', 'popup-button', 'Add record at this point') as HTMLButtonElement;
      add.onclick = () => { popup.current?.remove(); latest.current.onAddAt?.(lng, lat); };
      box.append(add);
      popup.current?.remove();
      popup.current = new Popup({ closeButton: true, offset: 6 }).setLngLat(ev.lngLat).setDOMContent(box).addTo(m);
    });
    return () => { disposed = true; popup.current?.remove(); m.remove(); map.current = null; };
    // Map is created once; later prop changes update it in the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const firstBasemap = useRef(true);
  useEffect(() => {
    if (firstBasemap.current) { firstBasemap.current = false; return; }
    const m = map.current;
    if (!m) return;
    let cancelled = false;
    setTileWarning(false);
    loadStyle(basemap).then(s => { if (!cancelled) m.setStyle(s, { diff: false }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  useEffect(() => { const s = map.current?.getSource(SOURCE) as GeoJSONSource | undefined; s?.setData(features as any); }, [features]);
  useEffect(() => { const m = map.current; if (m?.isStyleLoaded()) applyVisibility(m); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showCountries, showCasualties]);
  useEffect(() => { if (focus && map.current) map.current.easeTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.current.getZoom(), 3.5), duration: 900 }); }, [focus?.n]);
  useEffect(() => { if (map.current) map.current.getCanvas().style.cursor = props.pickMode ? 'crosshair' : ''; }, [props.pickMode]);
  // fitBounds needs no loaded style; isStyleLoaded() stays false while tiles load, so don't wait for it.
  useEffect(() => { if (map.current) fitTo(map.current); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [props.fit?.n]);

  return <div className={'interactive-map-shell' + (props.pickMode ? ' picking' : '')}>
    <div ref={host} className="interactive-map" />
    {hoverCountry && <div className="map-hover-country">{hoverCountry}</div>}
    {tileWarning && basemap === 'online' && <div className="map-tile-warning">Some basemap tiles failed to load. Check the Windows host’s internet connection, or switch to the offline outline.</div>}
    {!props.compact && <div className="map-operation-note"><span className="live-dot" /> {props.pickMode ? 'Click the globe to set the record’s location' : 'Drag to pan · right-drag or two fingers to rotate · scroll or pinch to zoom · click to add a record'}</div>}
  </div>;
}
