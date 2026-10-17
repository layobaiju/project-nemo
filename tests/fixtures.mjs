// Shared test data: a realistic large board built from UCDP GED-style rows.
import { ucdpRow, UCDP_DATASET } from '../src/importer.ts';

export const emptyBoard = (id, name, events = []) => ({ id, name, kind: 'world', nodes: [], edges: [], events, links: [], imports: [], folders: [{ id: `${id}-f`, name: 'Sources', items: [] }] });

export function ucdpRecords(count) {
  const ctx = { dataset: { ...UCDP_DATASET, version: '26.1', accessedDate: '2026-10-15' }, supports: ['title', 'date', 'location', 'actors', 'casualties'], batchId: 'batch-1', preset: 'ucdp-ged', ownResearch: false };
  const out = [];
  for (let i = 0; i < count; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0'), month = String(1 + (i % 12)).padStart(2, '0');
    out.push(ucdpRow({
      id: String(100000 + i), type_of_violence: String(1 + (i % 3)), conflict_name: `Conflict ${i % 40}`, dyad_name: `Side A ${i % 40} - Side B ${i % 17}`,
      side_a: `Government of Country ${i % 40}`, side_b: `Group ${i % 17}`, gwnoa: '999', gwnob: '',
      date_start: `20${10 + (i % 10)}-${month}-${day} 00:00:00.000`, date_end: `20${10 + (i % 10)}-${month}-${day} 00:00:00.000`, date_prec: '1', where_prec: String(1 + (i % 4)),
      where_coordinates: `Town ${i}`, adm_1: `Province ${i % 30}`, adm_2: '', country: `Country ${i % 40}`,
      latitude: String(-40 + (i % 80)), longitude: String(-120 + (i % 240)), low: String(Math.min(i % 5, i % 7)), best: String(i % 7), high: String(i % 11 + 7),
      deaths_a: '0', deaths_b: String(i % 3), deaths_civilians: String(i % 4), deaths_unknown: '0',
      source_headline: `Wire report ${i}`, source_office: 'Agency', source_date: '2015-01-01', source_article: `Agency report ${i}`, event_clarity: '1', code_status: 'Clear',
    }, ctx).record);
  }
  return out;
}
