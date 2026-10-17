import type { Board, DatasetMeta, EventItem, Evidence } from './types.ts';
import {
  BASE_FIELDS, CATEGORIES, CONFIDENCE, LOCATION_PRECISION, VERIFICATION, emptyActor, emptyEvidence, emptyFigure, emptyEquipment,
  haversineKm, hasCoords, newEvent, normalizeEvent, normalizeName, nowIso, parseDateInput, type Issue,
} from './model.ts';

export type RawRow = Record<string, string>;
export const MAX_IMPORT = 10_000;
export const LARGE_IMPORT = 2_000;

// ---------- CSV ----------
export function detectDelimiter(text: string): string {
  const line = text.slice(0, 5000).split(/\r?\n/)[0] || '';
  let best = ',', bestCount = -1;
  for (const d of [',', ';', '\t']) {
    let count = 0, quoted = false;
    for (const ch of line) { if (ch === '"') quoted = !quoted; else if (ch === d && !quoted) count++; }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** RFC 4180 parser (quoted fields, escaped quotes, CRLF, embedded newlines). Stops early if onRow returns false. */
export function parseCSV(text: string, onRow: (cells: string[], index: number) => boolean | void, delimiter = detectDelimiter(text)): number {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let field = '', row: string[] = [], quoted = false, index = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field); field = '';
    const blank = row.length === 1 && row[0] === '';
    const r = row; row = [];
    if (blank) return true;
    return onRow(r, index++) !== false;
  };
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (!endRow()) return index;
      continue;
    }
    field += ch; i++;
  }
  if (field !== '' || row.length) endRow();
  return index;
}

/** Undo the spreadsheet formula guard Atlas adds on export ('=… → =…). */
export const cleanCell = (v: unknown) => {
  const s = (v == null ? '' : String(v)).trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
};
export const headerKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

// ---------- field mapping ----------
export type FieldDef = { key: string; label: string; aliases: string[] };
export const FIELDS: FieldDef[] = [
  { key: 'id', label: 'Original record ID', aliases: ['id', 'record_id', 'event_id', 'original_id', 'uid'] },
  { key: 'title', label: 'Title', aliases: ['title', 'name', 'event_name', 'event', 'headline'] },
  { key: 'category', label: 'Category', aliases: ['category', 'event_type', 'type'] },
  { key: 'classification', label: 'Classification', aliases: ['classification', 'conflict_type'] },
  { key: 'conflictName', label: 'Conflict name', aliases: ['conflict_name', 'conflict'] },
  { key: 'date', label: 'Start date', aliases: ['date', 'start_date', 'date_start', 'event_date', 'start'] },
  { key: 'endDate', label: 'End date', aliases: ['end_date', 'date_end', 'end'] },
  { key: 'datePrecision', label: 'Date precision', aliases: ['date_precision'] },
  { key: 'place', label: 'Place name', aliases: ['place', 'location', 'location_name', 'where', 'city', 'site'] },
  { key: 'latitude', label: 'Latitude', aliases: ['latitude', 'lat'] },
  { key: 'longitude', label: 'Longitude', aliases: ['longitude', 'lon', 'lng', 'long'] },
  { key: 'locationPrecision', label: 'Location precision', aliases: ['location_precision'] },
  { key: 'countries', label: 'Countries / regions (; separated)', aliases: ['countries', 'country', 'countries_involved', 'regions'] },
  { key: 'description', label: 'Description', aliases: ['description', 'summary', 'desc'] },
  { key: 'actors', label: 'Actors (; separated, optional [Type/Attribution])', aliases: ['actors', 'actor', 'parties', 'organizations'] },
  { key: 'casualtyMetric', label: 'Casualty metric', aliases: ['casualty_metric'] },
  { key: 'casualtyPopulation', label: 'Casualty population', aliases: ['casualty_population'] },
  { key: 'casualtiesLow', label: 'Casualties – low', aliases: ['casualties_low', 'fatalities_low', 'deaths_low'] },
  { key: 'casualtiesBest', label: 'Casualties – best estimate', aliases: ['casualties_best', 'casualties', 'fatalities', 'fatalities_best', 'deaths'] },
  { key: 'casualtiesHigh', label: 'Casualties – high', aliases: ['casualties_high', 'fatalities_high', 'deaths_high'] },
  { key: 'casualtyDefinition', label: 'Casualty definition', aliases: ['casualty_definition', 'fatality_definition'] },
  { key: 'casualtyStatus', label: 'Casualty status', aliases: ['casualty_status'] },
  { key: 'equipment', label: 'Equipment (; separated)', aliases: ['equipment'] },
  { key: 'sourceTitle', label: 'Source title(s) ( | separated)', aliases: ['source_titles', 'source_title', 'source', 'source_name'] },
  { key: 'sourcePublisher', label: 'Source publisher(s)', aliases: ['source_publishers', 'source_publisher', 'publisher'] },
  { key: 'sourceUrl', label: 'Source URL(s)', aliases: ['source_urls', 'source_url', 'url', 'link'] },
  { key: 'sourceDate', label: 'Source publication date(s)', aliases: ['source_dates', 'source_date', 'publication_date', 'published'] },
  { key: 'sourceAccessed', label: 'Source access date(s)', aliases: ['source_accessed', 'access_date', 'accessed'] },
  { key: 'sourceClaim', label: 'Claim supported by source', aliases: ['source_claims', 'source_claim', 'claim'] },
  { key: 'verification', label: 'Verification status', aliases: ['verification', 'verification_status'] },
  { key: 'confidence', label: 'Analyst confidence', aliases: ['confidence'] },
  { key: 'attributionNote', label: 'Attribution uncertainty note', aliases: ['attribution_note', 'attribution_uncertainty'] },
  { key: 'analystNotes', label: 'Analyst notes', aliases: ['analyst_notes', 'notes'] },
  { key: 'tags', label: 'Tags (; separated)', aliases: ['tags', 'keywords'] },
];
export const TEMPLATE_HEADERS = ['id', 'title', 'category', 'classification', 'conflict_name', 'date', 'end_date', 'date_precision', 'place', 'latitude', 'longitude', 'location_precision', 'countries', 'description', 'actors', 'casualty_metric', 'casualty_population', 'casualties_low', 'casualties_best', 'casualties_high', 'casualty_definition', 'casualty_status', 'equipment', 'source_titles', 'source_publishers', 'source_urls', 'source_dates', 'source_accessed', 'source_claims', 'verification', 'confidence', 'attribution_note', 'analyst_notes', 'tags'];

export function autoMapping(headers: string[]): Record<string, string> {
  const byKey = new Map(headers.map(h => [headerKey(h), h]));
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    for (const a of f.aliases) {
      const h = byKey.get(a);
      if (h && !used.has(h)) { out[f.key] = h; used.add(h); break; }
    }
  }
  return out;
}

// ---------- presets ----------
export type PresetKey = 'atlas' | 'ucdp-ged' | 'generic' | 'atlas-records';
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'atlas', label: 'Atlas CSV template / Atlas CSV export' },
  { key: 'ucdp-ged', label: 'UCDP GED – Georeferenced Event Dataset (CSV)' },
  { key: 'generic', label: 'Other table – map columns manually' },
];
const UCDP_COLUMNS = ['type_of_violence', 'side_a', 'side_b', 'best', 'where_prec', 'date_start'];
export function detectPreset(headers: string[]): PresetKey {
  const keys = new Set(headers.map(headerKey));
  if (UCDP_COLUMNS.every(c => keys.has(c))) return 'ucdp-ged';
  if (keys.has('title') && keys.has('source_urls')) return 'atlas';
  return 'generic';
}
export const UCDP_DATASET: DatasetMeta = {
  name: 'UCDP Georeferenced Event Dataset (GED) Global', version: '', publisher: 'Uppsala Conflict Data Program (UCDP), Uppsala University',
  url: 'https://ucdp.uu.se/downloads/', license: 'CC BY 4.0', accessedDate: '',
  citation: 'Sundberg, Ralph & Erik Melander (2013) Introducing the UCDP Georeferenced Event Dataset. Journal of Peace Research 50(4). Davies, Shawn, Therése Pettersson & Magnus Öberg (2026) Organized violence 1989–2025, and violent political protests. Journal of Peace Research. Cite the GED version used.',
  notes: 'Fatality figures are UCDP estimates (low/best/high). An event requires at least one fatality. See the GED codebook for definitions.',
};

// ---------- source detection ----------
export type Detected =
  | { kind: 'csv'; text: string; headers: string[]; delimiter: string; estimate: number }
  | { kind: 'rows'; format: 'json' | 'geojson'; headers: string[]; rows: RawRow[]; skipped: number }
  | { kind: 'atlas-records'; records: any[]; links: any[]; dataset?: Partial<DatasetMeta> }
  | { kind: 'atlas-backup'; projects: any[] }
  | { kind: 'error'; message: string };

const flatten = (o: Record<string, unknown>): RawRow => {
  const out: RawRow = {};
  for (const [k, v] of Object.entries(o || {})) out[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return out;
};
const looksAtlasRecord = (o: any) => o && typeof o === 'object' && typeof o.name === 'string' && (Array.isArray(o.evidence) || Array.isArray(o.sources)) && 'category' in o;

export function detectSource(fileName: string, text: string): Detected {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (/\.(geo)?json$/i.test(fileName) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: any;
    try { data = JSON.parse(trimmed); } catch (e) { return { kind: 'error', message: `Not valid JSON: ${(e as Error).message}` }; }
    if (data?.format === 'atlas-workspace' || (Array.isArray(data) && data.length && data.every((p: any) => Array.isArray(p?.boards)))) return { kind: 'atlas-backup', projects: Array.isArray(data) ? data : data.projects || [] };
    if (data?.format === 'atlas-project' && data.project) return { kind: 'atlas-backup', projects: [data.project] };
    if (data?.format === 'atlas-records') return { kind: 'atlas-records', records: data.records || [], links: data.links || [], dataset: data.dataset };
    if (data?.type === 'FeatureCollection' && Array.isArray(data.features)) {
      if (data.features.length && data.features.every((f: any) => f?.properties?.atlas_record)) return { kind: 'atlas-records', records: data.features.map((f: any) => f.properties.atlas_record), links: [] };
      let skipped = 0;
      const rows: RawRow[] = [];
      for (const f of data.features) {
        const g = f?.geometry;
        if (g?.type !== 'Point' || !Array.isArray(g.coordinates)) { skipped++; continue; }
        rows.push({ ...flatten(f.properties || {}), longitude: String(g.coordinates[0]), latitude: String(g.coordinates[1]) });
      }
      return { kind: 'rows', format: 'geojson', headers: [...new Set(rows.flatMap(r => Object.keys(r)))], rows, skipped };
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : Array.isArray(data?.data) ? data.data : null;
    if (!list) return { kind: 'error', message: 'JSON must be an array of records, a GeoJSON FeatureCollection, or an Atlas export.' };
    if (list.length && list.every(looksAtlasRecord)) return { kind: 'atlas-records', records: list, links: [] };
    const rows: RawRow[] = list.filter((r: any) => r && typeof r === 'object').map(flatten);
    return { kind: 'rows', format: 'json', headers: [...new Set(rows.flatMap(r => Object.keys(r)))], rows, skipped: list.length - rows.length };
  }
  const delimiter = detectDelimiter(trimmed);
  let headers: string[] = [];
  parseCSV(trimmed, cells => { headers = cells.map(c => c.trim()); return false; }, delimiter);
  if (headers.length < 2) return { kind: 'error', message: 'Could not find a header row with at least two columns.' };
  const newlines = trimmed.match(/\n/g)?.length || 0;
  const estimate = Math.max(0, newlines - (trimmed.endsWith('\n') ? 1 : 0));
  return { kind: 'csv', text: trimmed, headers, delimiter, estimate };
}

// ---------- filters ----------
export type RowFilter = { from: string; to: string; contains: string };
export function rowsFromSource(d: Detected, filter: RowFilter, mapping: Record<string, string>, preset: PresetKey, cap = MAX_IMPORT): { rows: { row: RawRow; line: number }[]; read: number; matched: number } {
  const dateCol = preset === 'ucdp-ged' ? 'date_start' : mapping.date;
  const needle = normalizeName(filter.contains);
  const from = filter.from ? Date.parse(filter.from.length === 4 ? `${filter.from}-01-01` : filter.from) : null;
  const to = filter.to ? Date.parse(filter.to.length === 4 ? `${filter.to}-12-31` : filter.to) : null;
  const keep = (r: RawRow) => {
    if ((from != null || to != null) && dateCol) {
      const t = Date.parse(String(r[dateCol] || '').slice(0, 10));
      if (!Number.isFinite(t) || (from != null && t < from) || (to != null && t > to)) return false;
    }
    if (needle && !normalizeName(Object.values(r).join(' ')).includes(needle)) return false;
    return true;
  };
  const rows: { row: RawRow; line: number }[] = [];
  let read = 0, matched = 0;
  if (d.kind === 'csv') {
    let headers: string[] = [];
    parseCSV(d.text, (cells, i) => {
      if (i === 0) { headers = cells.map(c => c.trim()); return; }
      read++;
      const r: RawRow = {};
      headers.forEach((h, k) => { r[h] = cells[k] ?? ''; });
      if (keep(r)) { matched++; if (rows.length < cap) rows.push({ row: r, line: i + 1 }); }
    }, d.delimiter);
  } else if (d.kind === 'rows') {
    d.rows.forEach((r, i) => { read++; if (keep(r)) { matched++; if (rows.length < cap) rows.push({ row: r, line: i + 1 }); } });
  }
  return { rows, read, matched };
}

// ---------- row -> record ----------
export type BuildCtx = { dataset: DatasetMeta; supports: string[]; batchId: string; preset: PresetKey; ownResearch: boolean };
export const IMPORT_SUPPORT_OPTIONS: [string, string][] = [...BASE_FIELDS, ['actors', 'Actors'], ['casualties', 'Casualty figures'], ['equipment', 'Equipment references']];
const split = (s: string, re = /\s*[;|]\s*/) => (s ? s.split(re).map(x => x.trim()).filter(Boolean) : []);
const splitSources = (s: string) => (s ? s.split(/\s+\|\s+|\n/).map(x => x.trim()) : []);
const intOrNull = (s: string, issues: Issue[], label: string): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[, ]/g, ''));
  if (!Number.isFinite(n)) { issues.push({ level: 'warning', text: `${label} “${s}” is not a number; ignored.` }); return null; }
  return n;
};

function expandSupports(keys: string[], e: EventItem): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'actors') out.push(...e.actors.map(a => `actor:${a.id}`));
    else if (k === 'casualties') out.push(...e.casualties.map(c => `casualty:${c.id}`));
    else if (k === 'equipment') out.push(...e.equipment.map(q => `equipment:${q.id}`));
    else out.push(k);
  }
  return out;
}

function datasetEvidence(ctx: BuildCtx, originalId: string, e: EventItem): Evidence {
  const d = ctx.dataset;
  return {
    ...emptyEvidence(), title: `${d.name}${d.version ? ` v${d.version}` : ''} – record ${originalId || '(no id)'}`,
    publisher: d.publisher, url: d.url, accessedDate: d.accessedDate, sourceType: 'Dataset', reliability: 'Not assessed', license: d.license,
    claim: `Values in this record are as coded/published by ${d.name}. They are not independently verified in Atlas.`,
    supports: expandSupports(ctx.supports, e), notes: d.citation,
  };
}

function coords(lat: string, lng: string, issues: Issue[]): { latitude?: number; longitude?: number } {
  if (!lat && !lng) { issues.push({ level: 'warning', text: 'No coordinates; record will not appear on the globe until located.' }); return {}; }
  const la = Number(lat), lo = Number(lng);
  if (!lat || !lng || !Number.isFinite(la) || !Number.isFinite(lo)) { issues.push({ level: 'error', text: `Invalid coordinates “${lat}, ${lng}”.` }); return {}; }
  if (la < -90 || la > 90 || lo < -180 || lo > 180) { issues.push({ level: 'error', text: `Coordinates out of range (${la}, ${lo}). Check whether latitude and longitude are swapped.` }); return {}; }
  if (la === 0 && lo === 0) issues.push({ level: 'warning', text: '0, 0 coordinates are usually a placeholder.' });
  return { latitude: la, longitude: lo };
}

function provenance(ctx: BuildCtx, originalId: string) {
  const t = nowIso();
  return { origin: 'import', createdAt: t, updatedAt: t, importBatchId: ctx.batchId, dataset: ctx.dataset.name, datasetLicense: ctx.dataset.license, datasetUrl: ctx.dataset.url, originalId };
}

export function genericRow(row: RawRow, mapping: Record<string, string>, ctx: BuildCtx): { record: EventItem; issues: Issue[] } {
  const issues: Issue[] = [];
  const get = (k: string) => (mapping[k] ? cleanCell(row[mapping[k]]) : '');
  const title = get('title');
  if (!title) issues.push({ level: 'error', text: 'Missing title.' });
  const d1 = parseDateInput(get('date')), d2 = parseDateInput(get('endDate'));
  if (!d1.ok) issues.push({ level: 'error', text: d1.error! });
  if (!d2.ok) issues.push({ level: 'error', text: d2.error! });
  if (!get('date')) issues.push({ level: 'warning', text: 'Undated.' });
  const cat = get('category');
  const category = CATEGORIES.find(c => c.toLowerCase() === cat.toLowerCase()) || 'Event';
  const tags = split(get('tags'));
  if (cat && category === 'Event' && cat.toLowerCase() !== 'event') { tags.push(`original-category:${cat}`); issues.push({ level: 'info', text: `Category “${cat}” is not an Atlas category; stored as Event with a tag.` }); }
  const pick = (v: string, list: string[], label: string) => {
    if (!v) return '';
    const hit = list.find(x => x.toLowerCase() === v.toLowerCase());
    if (!hit) issues.push({ level: 'info', text: `${label} “${v}” not recognised; left as default.` });
    return hit || '';
  };
  const actors = split(get('actors')).map(s => {
    const m = s.match(/^(.*?)\s*\[([^\]/]*)(?:\/([^\]]*))?\]\s*$/);
    return { ...emptyActor(), name: (m ? m[1] : s).trim(), type: m?.[2]?.trim() || 'Other / unknown', attribution: m?.[3]?.trim() || 'Unknown' };
  });
  const low = intOrNull(get('casualtiesLow'), issues, 'Casualties low'), best = intOrNull(get('casualtiesBest'), issues, 'Casualties best'), high = intOrNull(get('casualtiesHigh'), issues, 'Casualties high');
  const casualties = low != null || best != null || high != null ? [{
    ...emptyFigure(), low, best, high, metric: get('casualtyMetric') || 'Killed', population: get('casualtyPopulation') || 'All / unspecified',
    status: get('casualtyStatus') || 'Reported', definition: get('casualtyDefinition'),
  }] : [];
  const equipment = split(get('equipment')).map(name => ({ ...emptyEquipment(), name }));
  const record = normalizeEvent({
    ...newEvent(),
    name: title, category, classification: get('classification'), conflictName: get('conflictName'),
    date: d1.value, endDate: d2.value, datePrecision: get('datePrecision'), place: get('place'),
    ...coords(get('latitude'), get('longitude'), issues),
    locationPrecision: LOCATION_PRECISION.find(x => x.toLowerCase() === get('locationPrecision').toLowerCase()) || 'Unknown',
    countries: split(get('countries')), description: get('description'), actors, casualties, equipment,
    verification: pick(get('verification'), VERIFICATION, 'Verification') || 'Unverified',
    confidence: pick(get('confidence'), CONFIDENCE, 'Confidence') || 'Unverified',
    attributionNote: get('attributionNote'), analystNotes: get('analystNotes'), tags,
    provenance: provenance(ctx, get('id')),
  });
  const titles = splitSources(get('sourceTitle')), urls = splitSources(get('sourceUrl')), pubs = splitSources(get('sourcePublisher'));
  const dates = splitSources(get('sourceDate')), accessed = splitSources(get('sourceAccessed')), claims = splitSources(get('sourceClaim'));
  const n = Math.max(titles.length, urls.length);
  const evidence: Evidence[] = [];
  for (let i = 0; i < n; i++) {
    if (!titles[i] && !urls[i]) continue;
    const pd = parseDateInput(dates[i] || '');
    evidence.push({
      ...emptyEvidence(), title: titles[i] || '', url: urls[i] || '', publisher: pubs[i] || '', publishedDate: pd.ok ? pd.value : '',
      accessedDate: accessed[i] || ctx.dataset.accessedDate, claim: claims[i] || '', supports: expandSupports(ctx.supports, record),
      license: '', sourceType: 'Other',
    });
  }
  // Third-party datasets get a provenance source supporting the chosen fields; own research does not.
  if (!ctx.ownResearch) evidence.unshift(datasetEvidence(ctx, get('id'), record));
  if (!evidence.length) issues.push({ level: 'warning', text: 'No source in this row.' });
  if (casualties.length && !casualties[0].definition) issues.push({ level: 'warning', text: 'Casualty figure has no definition.' });
  record.evidence = evidence;
  record.sources = evidence.map(s => s.url || s.title).filter(Boolean);
  return { record, issues };
}

const UCDP_VIOLENCE: Record<string, string> = { '1': 'State-based armed conflict', '2': 'Non-state conflict', '3': 'One-sided violence' };
const UCDP_DATE_PREC: Record<string, string> = { '1': 'Exact day', '2': 'Within a few days', '3': 'Week', '4': 'Month', '5': 'Approximate' };

/** Maps one UCDP GED row. Values are kept as coded by UCDP; actor sides are labelled "as coded", not as findings. */
export function ucdpRow(row: RawRow, ctx: BuildCtx): { record: EventItem; issues: Issue[] } {
  const issues: Issue[] = [];
  const g = (k: string) => cleanCell(row[k]);
  const tv = UCDP_VIOLENCE[g('type_of_violence')] || '';
  const d1 = parseDateInput(g('date_start')), d2 = parseDateInput(g('date_end'));
  if (!d1.ok) issues.push({ level: 'error', text: d1.error! });
  const place = [g('where_coordinates'), g('adm_2'), g('adm_1')].filter(Boolean).join(', ');
  const side = (name: string, gw: string, label: 'A' | 'B') => {
    if (!name) return null;
    const civilians = /^civilians$/i.test(name);
    return {
      ...emptyActor(), name,
      type: gw ? 'State force' : civilians ? 'Other / unknown' : 'Armed group',
      role: civilians ? 'Affected party' : `Side ${label} (as coded)`, attribution: 'Coded by dataset',
      note: gw ? `State actor per UCDP (Gleditsch–Ward no. ${gw}).` : civilians ? 'UCDP code for civilians targeted in one-sided violence.' : 'Organised non-state actor as coded by UCDP.',
    };
  };
  const actors = [side(g('side_a'), g('gwnoa'), 'A'), side(g('side_b'), g('gwnob'), 'B')].filter(Boolean) as EventItem['actors'];
  const n = (k: string) => intOrNull(g(k), issues, k);
  const casualties: EventItem['casualties'] = [];
  const low = n('low'), best = n('best'), high = n('high');
  if (low != null || best != null || high != null) casualties.push({ ...emptyFigure(), metric: 'Killed', population: 'All / unspecified', low, best, high, status: 'Estimate', definition: 'UCDP GED fatality estimates for this event (low / best / high). "best" is the sum of deaths_a, deaths_b, deaths_civilians and deaths_unknown.' });
  const civ = n('deaths_civilians');
  if (civ) casualties.push({ ...emptyFigure(), metric: 'Killed', population: 'Civilians', best: civ, status: 'Estimate', definition: 'UCDP best estimate of civilian deaths in this event (deaths_civilians).' });
  const da = n('deaths_a'), db = n('deaths_b');
  if (da) casualties.push({ ...emptyFigure(), metric: 'Killed', population: 'Side A', best: da, status: 'Estimate', definition: `UCDP best estimate of deaths sustained by side A (${g('side_a')}).` });
  if (db) casualties.push({ ...emptyFigure(), metric: 'Killed', population: 'Side B', best: db, status: 'Estimate', definition: `UCDP best estimate of deaths sustained by side B (${g('side_b')}).` });
  const wp = Number(g('where_prec'));
  const record = normalizeEvent({
    ...newEvent(),
    name: `${g('dyad_name') || g('conflict_name') || 'UCDP event'} – ${g('where_coordinates') || g('country')}`,
    category: 'Conflict', classification: tv, conflictName: g('conflict_name'),
    date: d1.value, endDate: d2.ok && d2.value !== d1.value ? d2.value : '', datePrecision: UCDP_DATE_PREC[g('date_prec')] || '',
    place, ...coords(g('latitude'), g('longitude'), issues), locationPrecision: LOCATION_PRECISION[wp] || 'Unknown',
    countries: [g('country')].filter(Boolean),
    description: `As coded by UCDP GED: ${tv ? tv.toLowerCase() : 'organised violence'} event${g('dyad_name') ? ` (${g('dyad_name')})` : ''} at ${place || g('country')}${g('country') ? `, ${g('country')}` : ''}.${g('where_description') ? ` Location note: ${g('where_description')}.` : ''}`,
    actors, casualties, verification: 'Single source', confidence: 'Unverified',
    attributionNote: 'Sides are as coded by UCDP for this dyad; see the UCDP GED codebook for coding rules.',
    tags: [g('event_clarity') && `ucdp:event_clarity=${g('event_clarity')}`, g('code_status') && `ucdp:code_status=${g('code_status')}`, g('region') && `region:${g('region')}`].filter(Boolean) as string[],
    provenance: provenance(ctx, g('id')),
  });
  const evidence = [datasetEvidence(ctx, g('id'), record)];
  if (g('source_headline') || g('source_office') || g('source_article')) {
    const pd = parseDateInput(g('source_date').slice(0, 10));
    evidence.push({
      ...emptyEvidence(), title: g('source_headline') || 'Source cited by UCDP', publisher: g('source_office'), publishedDate: pd.ok ? pd.value : '',
      accessedDate: '', sourceType: 'Other', claim: 'Cited by UCDP as source material for this event (not reviewed in Atlas).',
      supports: ['title', 'date'], notes: g('source_article').slice(0, 1500),
    });
  }
  record.evidence = evidence;
  record.sources = evidence.map(s => s.url || s.title).filter(Boolean);
  return { record, issues };
}

// ---------- duplicates ----------
export type Dup = { kind: 'same-dataset-id' | 'same-atlas-id' | 'same-title-date' | 'near'; text: string; existingId: string };
type Entry = { e: EventItem; where: string };
export type DupIndex = { byOriginal: Map<string, Entry>; byId: Map<string, Entry>; byTitleDate: Map<string, Entry>; byDate: Map<string, Entry[]> };

export function buildDupIndex(boards: Board[]): DupIndex {
  const idx: DupIndex = { byOriginal: new Map(), byId: new Map(), byTitleDate: new Map(), byDate: new Map() };
  for (const b of boards) for (const e of b.events) addToIndex(idx, e, `board “${b.name}”`);
  return idx;
}
const day = (d: string) => d.slice(0, 10);
export function addToIndex(idx: DupIndex, e: EventItem, where: string) {
  const entry = { e, where };
  if (e.provenance.originalId && e.provenance.dataset) idx.byOriginal.set(`${normalizeName(e.provenance.dataset)}#${e.provenance.originalId}`, entry);
  idx.byId.set(e.id, entry);
  if (e.name && e.date) idx.byTitleDate.set(`${normalizeName(e.name)}#${day(e.date)}`, entry);
  if (e.date) { const k = day(e.date); idx.byDate.set(k, [...(idx.byDate.get(k) || []), entry]); }
}
const shiftDay = (d: string, n: number) => { const t = Date.parse(d); return Number.isFinite(t) && d.length >= 10 ? new Date(t + n * 86_400_000).toISOString().slice(0, 10) : null; };

export function findDuplicate(e: EventItem, idx: DupIndex, checkAtlasId = false): Dup | null {
  const p = e.provenance;
  if (p.originalId && p.dataset) {
    const hit = idx.byOriginal.get(`${normalizeName(p.dataset)}#${p.originalId}`);
    if (hit) return { kind: 'same-dataset-id', text: `Same ${p.dataset} record ID (${p.originalId}) already in ${hit.where}.`, existingId: hit.e.id };
  }
  if (checkAtlasId) { const hit = idx.byId.get(e.id); if (hit) return { kind: 'same-atlas-id', text: `A record with the same Atlas ID exists in ${hit.where} (“${hit.e.name}”).`, existingId: hit.e.id }; }
  if (e.name && e.date) {
    const hit = idx.byTitleDate.get(`${normalizeName(e.name)}#${day(e.date)}`);
    if (hit) return { kind: 'same-title-date', text: `Same title and date as “${hit.e.name}” in ${hit.where}.`, existingId: hit.e.id };
  }
  if (e.date && hasCoords(e)) {
    for (const d of [day(e.date), shiftDay(e.date, -1), shiftDay(e.date, 1)]) {
      for (const hit of (d && idx.byDate.get(d)) || []) {
        if (hit.e.category === e.category && hasCoords(hit.e) && haversineKm([e.longitude, e.latitude], [hit.e.longitude, hit.e.latitude]) < 2) {
          return { kind: 'near', text: `Possible duplicate: same category within 1 day and 2 km of “${hit.e.name}” (${hit.where}).`, existingId: hit.e.id };
        }
      }
    }
  }
  return null;
}

// ---------- candidates ----------
export type Candidate = { line: number; record: EventItem; issues: Issue[]; duplicate: Dup | null; include: boolean };

export function buildCandidates(rows: { row: RawRow; line: number }[], preset: PresetKey, mapping: Record<string, string>, ctx: BuildCtx, boards: Board[]): Candidate[] {
  const idx = buildDupIndex(boards);
  return rows.map(({ row, line }) => {
    const { record, issues } = preset === 'ucdp-ged' ? ucdpRow(row, ctx) : genericRow(row, mapping, ctx);
    const duplicate = findDuplicate(record, idx);
    addToIndex(idx, record, `this file (line ${line})`);
    const hasError = issues.some(i => i.level === 'error');
    return { line, record, issues, duplicate, include: !hasError && !duplicate };
  });
}

/** Atlas JSON records keep their evidence/actors/provenance; colliding IDs get new IDs. */
export function buildAtlasCandidates(records: any[], boards: Board[], batchId: string): Candidate[] {
  const idx = buildDupIndex(boards);
  return records.map((raw, i) => {
    const record = normalizeEvent(raw);
    const issues: Issue[] = [];
    if (!record.name) issues.push({ level: 'error', text: 'Missing title.' });
    if (!hasCoords(record)) issues.push({ level: 'warning', text: 'No coordinates.' });
    if (!record.evidence.length) issues.push({ level: 'warning', text: 'No sources.' });
    const duplicate = findDuplicate(record, idx, true);
    record.provenance = { ...record.provenance, importBatchId: batchId, updatedAt: nowIso(), createdAt: record.provenance.createdAt || nowIso(), origin: record.provenance.origin === 'legacy' ? 'import' : record.provenance.origin || 'import' };
    addToIndex(idx, record, `this file (item ${i + 1})`);
    return { line: i + 1, record, issues, duplicate, include: !issues.some(x => x.level === 'error') && !duplicate };
  });
}

export function summarize(c: Candidate[]) {
  return {
    total: c.length,
    errors: c.filter(x => x.issues.some(i => i.level === 'error')).length,
    warnings: c.filter(x => !x.issues.some(i => i.level === 'error') && x.issues.some(i => i.level === 'warning')).length,
    duplicates: c.filter(x => x.duplicate).length,
    included: c.filter(x => x.include).length,
    unplaced: c.filter(x => !hasCoords(x.record)).length,
  };
}
