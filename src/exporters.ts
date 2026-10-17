import type { Board, EventItem, Project } from './types.ts';
import { formatFigure, hasCoords, supportLabel, today } from './model.ts';
import { TEMPLATE_HEADERS } from './importer.ts';

/** Quote a CSV cell and neutralise spreadsheet formulas (a leading ' that Atlas import strips again). */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r;|]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCSV = (header: string[], rows: unknown[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const safeName = (s: string) => (s || 'atlas').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'atlas';

const join = (xs: string[]) => xs.join(' | ');

/** One row per record; columns match the Atlas CSV import template so the file can be re-imported. */
export function recordRow(e: EventItem): unknown[] {
  const c = e.casualties[0];
  const values: Record<string, unknown> = {
    id: e.provenance.originalId || e.id, title: e.name, category: e.category, classification: e.classification, conflict_name: e.conflictName,
    date: e.date, end_date: e.endDate, date_precision: e.datePrecision, place: e.place,
    latitude: hasCoords(e) ? e.latitude : '', longitude: hasCoords(e) ? e.longitude : '', location_precision: e.locationPrecision,
    countries: e.countries.join('; '), description: e.description,
    actors: e.actors.map(a => `${a.name} [${a.type}/${a.attribution}]`).join('; '),
    casualty_metric: c?.metric ?? '', casualty_population: c?.population ?? '', casualties_low: c?.low ?? '', casualties_best: c?.best ?? '', casualties_high: c?.high ?? '',
    casualty_definition: c?.definition ?? '', casualty_status: c?.status ?? '',
    equipment: e.equipment.map(q => q.name).join('; '),
    source_titles: join(e.evidence.map(s => s.title)), source_publishers: join(e.evidence.map(s => s.publisher)), source_urls: join(e.evidence.map(s => s.url)),
    source_dates: join(e.evidence.map(s => s.publishedDate)), source_accessed: join(e.evidence.map(s => s.accessedDate)), source_claims: join(e.evidence.map(s => s.claim)),
    verification: e.verification, confidence: e.confidence, attribution_note: e.attributionNote, analyst_notes: e.analystNotes, tags: e.tags.join('; '),
  };
  return [...TEMPLATE_HEADERS.map(h => values[h]), e.id, e.casualties.map(x => `${x.metric}/${x.population}: ${formatFigure(x)} (${x.status}; ${x.definition})`).join(' | '), e.provenance.origin, e.provenance.dataset || '', e.provenance.datasetLicense || ''];
}
export const RECORD_EXTRA_HEADERS = ['atlas_id', 'all_casualty_figures', 'provenance_origin', 'dataset', 'dataset_license'];
export const boardCSV = (b: Board) => toCSV([...TEMPLATE_HEADERS, ...RECORD_EXTRA_HEADERS], b.events.map(recordRow));
export const templateCSV = () => toCSV(TEMPLATE_HEADERS, []);

export function evidenceCSV(b: Board): string {
  const rows = b.events.flatMap(e => e.evidence.map(s => [
    e.id, e.name, s.id, s.title, s.publisher, s.url, s.publishedDate, s.accessedDate, s.sourceType, s.reliability, s.stance, s.claim,
    s.supports.map(k => supportLabel(e, k)).join('; '), s.license, s.notes,
  ]));
  return toCSV(['record_id', 'record_title', 'source_id', 'source_title', 'publisher', 'url', 'published', 'accessed', 'type', 'reliability', 'stance', 'claim', 'supports_fields', 'license', 'notes'], rows);
}

export function boardGeoJSON(b: Board): string {
  const features = b.events.filter(hasCoords).map(e => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [e.longitude, e.latitude] },
    properties: {
      id: e.id, title: e.name, category: e.category, date: e.date, end_date: e.endDate, place: e.place, verification: e.verification,
      source_count: e.evidence.length, dataset: e.provenance.dataset || '', license: e.provenance.datasetLicense || '',
      // Full record (evidence, actors, figures, provenance) so Atlas can re-import losslessly.
      atlas_record: e,
    },
  }));
  return JSON.stringify({ type: 'FeatureCollection', name: b.name, note: 'Records supplied by the Atlas user; not a complete or live dataset.', features }, null, 2);
}

export const recordsJSON = (b: Board) => JSON.stringify({ format: 'atlas-records', version: 2, exportedAt: new Date().toISOString(), board: b.name, records: b.events, links: b.links, imports: b.imports }, null, 2);
export const projectJSON = (p: Project) => JSON.stringify({ format: 'atlas-project', version: 2, exportedAt: new Date().toISOString(), project: p }, null, 2);

export function exportBoard(kind: 'csv' | 'geojson' | 'evidence' | 'records', b: Board) {
  const base = `${safeName(b.name)}-${today()}`;
  if (kind === 'csv') download(`${base}-records.csv`, 'text/csv;charset=utf-8', '﻿' + boardCSV(b));
  if (kind === 'evidence') download(`${base}-evidence.csv`, 'text/csv;charset=utf-8', '﻿' + evidenceCSV(b));
  if (kind === 'geojson') download(`${base}.geojson`, 'application/geo+json', boardGeoJSON(b));
  if (kind === 'records') download(`${base}-records.json`, 'application/json', recordsJSON(b));
}
