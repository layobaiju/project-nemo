import type { ActorRef, Board, CasualtyFigure, EntityDecisions, EquipmentRef, EventItem, Evidence, Folder, FolderItem, MapFeature, MapGeometry, MapLayer, OpsTask, Project, Provenance, Resource } from './types.ts';

// ---------- ids ----------
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** Collision-resistant id; crypto.getRandomValues also works on plain-http LAN pages (randomUUID does not). */
export function uid(len = 10): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
}
export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

// ---------- vocabularies ----------
export const CATEGORIES = ['Event', 'Incident', 'Conflict', 'Country', 'Actor', 'Armed organization', 'State force', 'Casualty figure', 'Equipment', 'Source', 'Diplomatic / political', 'Humanitarian'];
export const CLASSIFICATIONS = ['', 'State-based armed conflict', 'Non-state conflict', 'One-sided violence', 'Protest / civil unrest', 'Diplomatic / political', 'Humanitarian / disaster', 'Other / unclassified'];
export const VERIFICATION = ['Unverified', 'Single source', 'Corroborated', 'Verified', 'Disputed', 'Retracted'];
export const VERIFICATION_HELP: Record<string, string> = {
  Unverified: 'Not yet checked against sources.',
  'Single source': 'Supported by one source only.',
  Corroborated: 'Supported by two or more independent sources.',
  Verified: 'Checked against independent, reliable sources by the analyst.',
  Disputed: 'Credible sources disagree on core facts.',
  Retracted: 'Shown to be false or withdrawn; kept for the record.',
};
export const VERIFICATION_COLORS: Record<string, string> = {
  Unverified: '#8a96aa', 'Single source': '#6f9cf5', Corroborated: '#4fc1b0', Verified: '#5fcf7f', Disputed: '#e9a94f', Retracted: '#e5656f',
};
/** Analyst confidence (kept from earlier versions; distinct from verification status). */
export const CONFIDENCE = ['Unverified', 'Low', 'Moderate', 'High', 'Documented', 'Disputed'];
export const DATE_PRECISION = ['Exact day', 'Within a few days', 'Week', 'Month', 'Year', 'Approximate'];
export const LOCATION_PRECISION = ['Unknown', 'Exact', 'Within ~25 km', 'District (2nd-level admin)', 'Province (1st-level admin)', 'Approximate area / linear feature', 'Country only', 'International waters / airspace'];
export const ACTOR_TYPES = ['State force', 'Armed group', 'Government / political body', 'International organization', 'Civil society / NGO', 'Individual', 'Other / unknown'];
export const ACTOR_ROLES = ['Party to event', 'Side A (as coded)', 'Side B (as coded)', 'Reported perpetrator', 'Affected party', 'Responder / mediator', 'Claimant', 'Other'];
export const ATTRIBUTION = ['Unknown', 'Alleged', 'Suspected', 'Claimed', 'Disputed', 'Confirmed', 'Coded by dataset'];
export const ATTRIBUTION_HELP: Record<string, string> = {
  Unknown: 'Involvement not established.',
  Alleged: 'Asserted by a party or source without independent confirmation.',
  Suspected: 'Considered possible by sources or analysts; not established.',
  Claimed: 'The actor itself claimed involvement.',
  Disputed: 'Sources disagree.',
  Confirmed: 'Established by independent, reliable sources (cite them).',
  'Coded by dataset': 'Assigned by the dataset’s coding rules; see its codebook.',
};
export const CASUALTY_METRICS = ['Killed', 'Injured', 'Missing', 'Displaced', 'Detained', 'Other'];
export const POPULATIONS = ['All / unspecified', 'Civilians', 'Combatants / armed personnel', 'Side A', 'Side B'];
export const FIGURE_STATUS = ['Reported', 'Estimate', 'Confirmed', 'Disputed'];
export const EQUIPMENT_STATUS = ['Reported', 'Alleged', 'Confirmed', 'Disputed', 'Unknown'];
export const SOURCE_TYPES = ['News report', 'Official statement', 'Primary document', 'NGO / IGO report', 'Academic publication', 'Dataset', 'Imagery / media', 'Social media', 'Other'];
export const RELIABILITY = ['Not assessed', 'Generally reliable', 'Mixed record', 'Questionable', 'Unknown'];
export const STANCE = ['Supports', 'Contradicts', 'Context only'];
export const LICENSES = ['CC BY 4.0', 'CC BY-SA 4.0', 'CC0 / Public domain', 'ODbL 1.0', 'Open Government Licence', 'My own research notes (no third-party license)', 'Other (describe in notes)', 'Unknown'];

/** Base fields a source can be traced to. Item refs (actor:/casualty:/equipment:) are added per record. */
export const BASE_FIELDS: [string, string][] = [
  ['title', 'Event occurred / title'], ['date', 'Date'], ['location', 'Location'], ['countries', 'Countries'],
  ['description', 'Description'], ['classification', 'Classification'],
];

export function supportOptions(e: Pick<EventItem, 'actors' | 'casualties' | 'equipment'>): [string, string][] {
  return [
    ...BASE_FIELDS,
    ...e.actors.map(a => [`actor:${a.id}`, `Actor: ${a.name || 'unnamed'} (${a.attribution})`] as [string, string]),
    ...e.casualties.map(c => [`casualty:${c.id}`, `Figure: ${c.metric} · ${c.population} (${formatFigure(c)})`] as [string, string]),
    ...e.equipment.map(q => [`equipment:${q.id}`, `Equipment: ${q.name || 'unnamed'}`] as [string, string]),
  ];
}
export function supportLabel(e: EventItem, key: string): string {
  return supportOptions(e).find(([k]) => k === key)?.[1] || key;
}
export const evidenceFor = (e: EventItem, key: string) => e.evidence.filter(s => s.supports.includes(key) && s.stance !== 'Contradicts');

// ---------- empty factories ----------
export const emptyEvidence = (): Evidence => ({
  id: uid(), title: '', publisher: '', url: '', publishedDate: '', accessedDate: today(), sourceType: 'News report',
  reliability: 'Not assessed', stance: 'Supports', claim: '', supports: [], license: '', notes: '',
});
export const emptyActor = (): ActorRef => ({ id: uid(), name: '', type: 'Other / unknown', role: 'Party to event', attribution: 'Unknown', note: '' });
export const emptyFigure = (): CasualtyFigure => ({ id: uid(), metric: 'Killed', population: 'All / unspecified', low: null, best: null, high: null, status: 'Reported', definition: '' });
export const emptyEquipment = (): EquipmentRef => ({ id: uid(), name: '', type: '', status: 'Reported', note: '' });

export function newEvent(partial: Partial<EventItem> = {}): EventItem {
  const t = nowIso();
  return normalizeEvent({ id: uid(), name: '', category: 'Event', place: '', date: '', confidence: 'Unverified', verification: 'Unverified', x: 50, y: 45, ...partial, provenance: { origin: 'manual', createdAt: t, updatedAt: t, ...(partial.provenance || {}) } });
}

// ---------- normalisation (non-destructive migration of older data) ----------
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | null => {
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export function normalizeEvidence(raw: any): Evidence {
  const base = emptyEvidence();
  return {
    ...base, ...raw,
    id: str(raw?.id) || base.id, title: str(raw?.title), publisher: str(raw?.publisher), url: str(raw?.url),
    publishedDate: str(raw?.publishedDate), accessedDate: str(raw?.accessedDate), sourceType: str(raw?.sourceType) || 'Other',
    reliability: str(raw?.reliability) || 'Not assessed', stance: str(raw?.stance) || 'Supports', claim: str(raw?.claim),
    supports: arr<string>(raw?.supports).map(str), license: str(raw?.license), notes: str(raw?.notes),
  };
}

export function normalizeEvent(raw: any): EventItem {
  const legacySources = arr<unknown>(raw?.sources).map(str).filter(Boolean);
  let evidence = arr<any>(raw?.evidence).map(normalizeEvidence);
  if (!evidence.length && legacySources.length) {
    // Older Atlas versions stored sources as plain lines. Keep each one, but mark that the claim was never recorded.
    evidence = legacySources.map(s => ({
      ...emptyEvidence(), accessedDate: '', sourceType: 'Other', title: isUrl(s) ? '' : s, url: isUrl(s) ? s : '',
      claim: '', notes: 'Migrated from an earlier Atlas version; the specific claim was not recorded.',
    }));
  }
  const lng = num(raw?.longitude), lat = num(raw?.latitude);
  const p = raw?.provenance || {};
  const provenance: Provenance = { ...p, origin: str(p.origin) || 'legacy', createdAt: str(p.createdAt), updatedAt: str(p.updatedAt) };
  return {
    ...raw,
    id: str(raw?.id) || uid(),
    name: str(raw?.name), category: str(raw?.category) || 'Event', place: str(raw?.place),
    date: str(raw?.date), endDate: str(raw?.endDate), datePrecision: str(raw?.datePrecision),
    x: num(raw?.x) ?? 50, y: num(raw?.y) ?? 45,
    longitude: lng != null && lng >= -180 && lng <= 180 ? lng : undefined,
    latitude: lat != null && lat >= -90 && lat <= 90 ? lat : undefined,
    locationPrecision: str(raw?.locationPrecision) || 'Unknown',
    countries: arr<unknown>(raw?.countries).map(str).filter(Boolean),
    description: str(raw?.description), classification: str(raw?.classification), conflictName: str(raw?.conflictName),
    actors: arr<any>(raw?.actors).map(a => ({ ...emptyActor(), ...a, id: str(a?.id) || uid(), name: str(a?.name) })),
    casualties: arr<any>(raw?.casualties).map(c => ({ ...emptyFigure(), ...c, id: str(c?.id) || uid(), low: num(c?.low), best: num(c?.best), high: num(c?.high), definition: str(c?.definition) })),
    equipment: arr<any>(raw?.equipment).map(q => ({ ...emptyEquipment(), ...q, id: str(q?.id) || uid(), name: str(q?.name) })),
    evidence,
    sources: evidence.map(s => s.url || s.title).filter(Boolean),
    confidence: str(raw?.confidence) || 'Unverified', verification: str(raw?.verification) || 'Unverified',
    attributionNote: str(raw?.attributionNote), analystNotes: str(raw?.analystNotes),
    tags: arr<unknown>(raw?.tags).map(str).filter(Boolean),
    nodeId: raw?.nodeId ? str(raw.nodeId) : undefined,
    provenance,
  };
}

export function normalizeFolderItem(raw: any): FolderItem {
  const nodeIds = arr<string>(raw?.nodeIds).map(str);
  if (raw?.nodeId && !nodeIds.includes(raw.nodeId)) nodeIds.push(str(raw.nodeId));
  return { ...raw, id: str(raw?.id) || uid(), name: str(raw?.name) || 'Untitled', kind: raw?.kind || (raw?.imageData ? 'drawing' : raw?.url ? 'link' : 'note'), nodeIds, recordIds: arr<string>(raw?.recordIds).map(str) };
}

// ---------- map workspace ----------
const lngLat = (p: unknown): [number, number] | null => {
  const [x, y] = Array.isArray(p) ? p.map(Number) : [];
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 180 && Math.abs(y) <= 90 ? [x, y] : null;
};
/** A drawing with unusable geometry is dropped rather than breaking the map. */
export function normalizeMapFeature(raw: any): MapFeature | null {
  const g = raw?.geometry, kind = ['marker', 'route', 'area', 'label'].includes(raw?.kind) ? raw.kind : null;
  let geometry: MapGeometry | null = null;
  if (g?.type === 'Point') { const p = lngLat(g.coordinates); if (p) geometry = { type: 'Point', coordinates: p }; }
  if (g?.type === 'LineString') { const c = arr(g.coordinates).map(lngLat); if (c.length >= 2 && c.every(Boolean)) geometry = { type: 'LineString', coordinates: c as [number, number][] }; }
  if (g?.type === 'Polygon') { const ring = arr(arr(g.coordinates)[0]).map(lngLat); if (ring.length >= 4 && ring.every(Boolean)) geometry = { type: 'Polygon', coordinates: [ring as [number, number][]] }; }
  const fits = geometry && (kind === 'route' ? geometry.type === 'LineString' : kind === 'area' ? geometry.type === 'Polygon' : geometry.type === 'Point');
  if (!kind || !geometry || !fits) return null;
  const shape = ['polygon', 'rectangle', 'circle'].includes(raw.shape) ? raw.shape : undefined;
  return {
    id: str(raw.id) || uid(), kind, geometry, ...(shape ? { shape } : {}), symbol: str(raw.symbol), color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#729cf5',
    name: str(raw.name), notes: str(raw.notes), layer: str(raw.layer), createdAt: str(raw.createdAt), updatedAt: str(raw.updatedAt),
  };
}
const normalizeMapLayer = (raw: any): MapLayer => ({ id: str(raw?.id) || uid(), name: str(raw?.name) || 'Layer', visible: raw?.visible !== false, locked: raw?.locked === true });
const normalizeResource = (raw: any): Resource => ({ id: str(raw?.id) || uid(), name: str(raw?.name) || 'Resource', type: str(raw?.type) || 'Other', status: str(raw?.status) || 'Ready', position: lngLat(raw?.position), notes: str(raw?.notes), updatedAt: str(raw?.updatedAt) });
const normalizeTask = (raw: any): OpsTask => ({
  id: str(raw?.id) || uid(), title: str(raw?.title) || 'Task', type: str(raw?.type), resourceId: str(raw?.resourceId), featureId: str(raw?.featureId), status: str(raw?.status) || 'Requested',
  log: arr<any>(raw?.log).map(l => ({ at: str(l?.at), status: str(l?.status), note: str(l?.note), by: str(l?.by) })), createdAt: str(raw?.createdAt), updatedAt: str(raw?.updatedAt),
});

export function normalizeBoard(raw: any): Board {
  return {
    ...raw,
    id: str(raw?.id) || uid(), name: str(raw?.name) || 'Board', kind: str(raw?.kind) || 'graph',
    nodes: arr(raw?.nodes), edges: arr(raw?.edges),
    events: arr<any>(raw?.events).map(normalizeEvent),
    folders: arr<any>(raw?.folders).map((f): Folder => ({ ...f, id: str(f?.id) || uid(), name: str(f?.name) || 'Folder', items: arr<any>(f?.items).map(normalizeFolderItem) })),
    links: arr(raw?.links), imports: arr(raw?.imports),
    mapFeatures: arr<any>(raw?.mapFeatures).map(normalizeMapFeature).filter((f): f is MapFeature => !!f),
    mapLayers: arr<any>(raw?.mapLayers).map(normalizeMapLayer),
    resources: arr<any>(raw?.resources).map(normalizeResource),
    tasks: arr<any>(raw?.tasks).map(normalizeTask),
  };
}

export function normalizeProjects(raw: unknown): Project[] {
  return arr<any>(raw).filter(p => p && typeof p === 'object').map(p => ({
    ...p, id: str(p.id) || uid(), name: str(p.name) || 'Untitled project', description: str(p.description),
    boards: arr<any>(p.boards).map(normalizeBoard),
    // Only present once the user made a decision, so loading never makes every project look changed.
    ...(p.entityDecisions != null ? { entityDecisions: normalizeDecisions(p.entityDecisions) } : {}),
  }));
}

/** Entity merge and "not the same" decisions; malformed entries are dropped. */
export function normalizeDecisions(raw: unknown): EntityDecisions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keys = (v: unknown) => arr<unknown>(v).filter((k): k is string => typeof k === 'string' && !!k);
  const merges = arr<any>(r.merges).filter(m => m && typeof m === 'object' && str(m.id) && keys(m.keys).length >= 2)
    .map(m => ({ id: str(m.id), keys: keys(m.keys), name: str(m.name), at: str(m.at), by: str(m.by) }));
  const distinct = arr<unknown>(r.distinct).map(keys).filter(k => k.length === 2).map(k => [k[0], k[1]] as [string, string]);
  return { merges, distinct };
}

// ---------- dates ----------
/** Accepts YYYY, YYYY-MM, YYYY-MM-DD, YYYY/MM/DD or an ISO timestamp. Rejects ambiguous forms like 03/04/2010. */
export function parseDateInput(input: string): { ok: boolean; value: string; error?: string } {
  const s = input.trim();
  if (!s) return { ok: true, value: '' };
  let m = s.match(/^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) {
    const [, y, mo, d] = m;
    if (mo && (Number(mo) < 1 || Number(mo) > 12)) return { ok: false, value: '', error: `Month out of range in “${s}”` };
    if (d) {
      const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
      if (dt.getUTCMonth() !== Number(mo) - 1) return { ok: false, value: '', error: `Day out of range in “${s}”` };
    }
    return { ok: true, value: [y, mo?.padStart(2, '0'), d?.padStart(2, '0')].filter(Boolean).join('-') };
  }
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return { ok: false, value: '', error: `Ambiguous date “${s}” (day/month order unknown); use YYYY-MM-DD` };
  return { ok: false, value: '', error: `Unrecognised date “${s}”; use YYYY, YYYY-MM or YYYY-MM-DD` };
}

/** Converts a (possibly partial) date into the span of time it covers, in ms. Year-only = whole year. */
export function dateSpan(start: string, end?: string): [number, number] | null {
  const bound = (s: string, upper: boolean): number | null => {
    const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return null;
    const y = Number(m[1]);
    if (!m[2]) return upper ? Date.UTC(y + 1, 0, 1) - 1 : Date.UTC(y, 0, 1);
    const mo = Number(m[2]) - 1;
    if (!m[3]) return upper ? Date.UTC(y, mo + 1, 1) - 1 : Date.UTC(y, mo, 1);
    const d = Number(m[3]);
    return upper ? Date.UTC(y, mo, d + 1) - 1 : Date.UTC(y, mo, d);
  };
  const a = bound(start, false);
  if (a == null) return null;
  const b = bound(end || start, true) ?? bound(start, true)!;
  return [a, Math.max(a, b)];
}
export const yearOf = (s: string) => { const y = Number(s?.slice(0, 4)); return Number.isFinite(y) && y > 0 ? y : null; };
export function formatDateRange(e: Pick<EventItem, 'date' | 'endDate'>): string {
  if (!e.date) return 'Undated';
  return e.endDate && e.endDate !== e.date ? `${e.date} – ${e.endDate}` : e.date;
}

// ---------- geo + text ----------
export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const hasCoords = (e: EventItem): e is EventItem & { longitude: number; latitude: number } =>
  Number.isFinite(e.longitude) && Number.isFinite(e.latitude);
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'near', 'were', 'was', 'are', 'has', 'have', 'had', 'its', 'their', 'event', 'record', 'reported', 'report']);
/**
 * Search matching used by every search box: ignores case, accents, punctuation and extra spaces, needs every
 * word in any order, and ignores spaces inside names, so "binladen" finds "bin Laden" and the other way round.
 */
export function matchesQuery(text: string, query: string): boolean {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const t = normalizeName(text), compact = t.replace(/ /g, '');
  return words.every(w => t.includes(w) || compact.includes(w));
}
/** The record fields every record search looks at. */
export const recordSearchText = (e: EventItem) => [e.name, e.place, e.description, e.conflictName, e.classification, ...e.countries, ...e.actors.map(a => a.name), ...e.tags].join(' ');
export function tokens(s: string): Set<string> {
  return new Set(normalizeName(s).split(' ').filter(t => t.length > 2 && !STOP.has(t)));
}
export function normalizeUrl(u: string): string {
  return u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
}

export function formatFigure(c: CasualtyFigure): string {
  const f = (n: number | null) => (n == null ? '?' : n.toLocaleString('en-US'));
  if (c.low == null && c.high == null) return c.best == null ? 'no figure' : `best ${f(c.best)}`;
  return `${f(c.low)}–${f(c.high)}${c.best != null ? `, best ${f(c.best)}` : ''}`;
}

// ---------- map layers ----------
const DEDICATED = new Set(['Conflict', 'Actor', 'Armed organization', 'State force', 'Casualty figure', 'Equipment', 'Source']);
export type LayerDef = { key: string; rule: string; test?: (e: EventItem) => boolean };
/** A record is shown when it matches at least one enabled layer. "Countries" controls basemap labels/borders. */
export const LAYERS: LayerDef[] = [
  { key: 'Events', rule: 'Records in general categories (event, incident, country, political, humanitarian).', test: e => !DEDICATED.has(e.category) },
  { key: 'Countries', rule: 'Basemap country labels and borders (does not filter records).' },
  { key: 'Conflicts', rule: 'Category Conflict, or any record with a conflict classification or conflict name.', test: e => e.category === 'Conflict' || !!e.classification || !!e.conflictName },
  { key: 'Actors', rule: 'Category Actor, or any record listing at least one actor.', test: e => e.category === 'Actor' || e.actors.length > 0 },
  { key: 'Armed groups', rule: 'Category Armed organization, or a listed actor of type Armed group.', test: e => e.category === 'Armed organization' || e.actors.some(a => a.type === 'Armed group') },
  { key: 'State forces', rule: 'Category State force, or a listed actor of type State force.', test: e => e.category === 'State force' || e.actors.some(a => a.type === 'State force') },
  { key: 'Casualties', rule: 'Records with a casualty figure. When on, reported figures draw a proportional ring.', test: e => e.category === 'Casualty figure' || e.casualties.length > 0 },
  { key: 'Equipment', rule: 'Category Equipment, or any record with an equipment reference.', test: e => e.category === 'Equipment' || e.equipment.length > 0 },
  { key: 'Sources', rule: 'Category Source, or any record citing at least one source.', test: e => e.category === 'Source' || e.evidence.length > 0 },
];
export const ALL_LAYERS = LAYERS.map(l => l.key);
export function visibleByLayers(e: EventItem, layers: string[]): boolean {
  return LAYERS.some(l => layers.includes(l.key) && l.test?.(e));
}

// ---------- data quality ----------
export type Issue = { level: 'error' | 'warning' | 'info'; text: string };
const EMOTIVE = /\b(barbaric|heroic|evil|savage|cowardly|glorious|martyr(?:dom|s)?|butcher(?:ed|s)?)\b/i;

export function recordIssues(e: EventItem): Issue[] {
  const out: Issue[] = [];
  if (!e.name.trim()) out.push({ level: 'error', text: 'Add a title.' });
  for (const [k, v] of [['Start date', e.date], ['End date', e.endDate]] as const) {
    const p = parseDateInput(v);
    if (!p.ok) out.push({ level: 'error', text: `${k}: ${p.error}` });
  }
  const span = dateSpan(e.date), endSpan = e.endDate ? dateSpan(e.endDate) : null;
  if (span && endSpan && endSpan[1] < span[0]) out.push({ level: 'error', text: 'End date is before the start date.' });
  if (!hasCoords(e)) out.push({ level: 'warning', text: 'No coordinates: the record will not appear on the globe.' });
  if (!e.evidence.length) out.push({ level: 'warning', text: 'No sources attached.' });
  e.evidence.forEach((s, i) => {
    const label = s.title || s.url || `Source ${i + 1}`;
    if (!s.title && !s.url) out.push({ level: 'error', text: `Source ${i + 1}: add a title or URL.` });
    if (s.url && !/^https?:\/\//i.test(s.url)) out.push({ level: 'warning', text: `${label}: URL should start with http:// or https://.` });
    if (!s.supports.length) out.push({ level: 'warning', text: `${label}: not linked to any field or claim.` });
    if (!s.claim.trim()) out.push({ level: 'info', text: `${label}: state the specific claim this source makes.` });
  });
  const sourced = (key: string) => evidenceFor(e, key).length > 0;
  for (const a of e.actors) {
    if (!a.name.trim()) out.push({ level: 'error', text: 'An actor has no name.' });
    if (['Confirmed', 'Claimed'].includes(a.attribution) && !sourced(`actor:${a.id}`)) out.push({ level: 'warning', text: `Actor “${a.name}” is marked ${a.attribution} but no source supports it.` });
  }
  for (const c of e.casualties) {
    if (c.low != null && c.best != null && c.low > c.best) out.push({ level: 'error', text: `${c.metric}: low is greater than best estimate.` });
    if (c.best != null && c.high != null && c.best > c.high) out.push({ level: 'error', text: `${c.metric}: best is greater than high estimate.` });
    if (c.low != null && c.high != null && c.low > c.high) out.push({ level: 'error', text: `${c.metric}: low is greater than high estimate.` });
    if ([c.low, c.best, c.high].some(n => n != null && n < 0)) out.push({ level: 'error', text: `${c.metric}: figures cannot be negative.` });
    if (!c.definition.trim()) out.push({ level: 'warning', text: `${c.metric} (${c.population}): define what the figure counts and who reported it.` });
    if (!sourced(`casualty:${c.id}`)) out.push({ level: 'warning', text: `${c.metric} (${c.population}): no source supports this figure.` });
  }
  for (const q of e.equipment) if (q.status === 'Confirmed' && !sourced(`equipment:${q.id}`)) out.push({ level: 'warning', text: `Equipment “${q.name}” is marked Confirmed without a supporting source.` });
  const occurrence = evidenceFor(e, 'title').length;
  if (['Corroborated', 'Verified'].includes(e.verification) && occurrence < 2) out.push({ level: 'warning', text: `Marked ${e.verification} but fewer than two sources support the event itself.` });
  if (e.verification === 'Single source' && occurrence === 0) out.push({ level: 'warning', text: 'Marked Single source but no source supports the event itself.' });
  if (EMOTIVE.test(`${e.name} ${e.description}`)) out.push({ level: 'info', text: 'Wording may read as a characterisation; attribute it to a source or use neutral terms.' });
  return out;
}

const PLACEHOLDER_NAMES = new Set(['new event marker', 'new historical research item', '']);
/** Untouched markers created by older versions (e.g. accidental map clicks). */
export const isPlaceholder = (e: EventItem) => PLACEHOLDER_NAMES.has(e.name.trim().toLowerCase()) && !e.evidence.length && !e.date && !e.description && !e.actors.length && !e.casualties.length;

// ---------- misc ----------
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
export const emptyDataset = () => ({ name: '', publisher: '', url: '', license: '', citation: '', accessedDate: today(), version: '', notes: '' });
