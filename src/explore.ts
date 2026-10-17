// Explore page data: the shapes the host returns (server/explore.mjs) and how a topic becomes Atlas records,
// graph nodes and folder links. Pure functions, so the saving rules can be unit-tested.
import type { Node } from '@xyflow/react';
import type { Board, EventItem, Evidence, FolderItem, Project } from './types.ts';
import { emptyEvidence, matchesQuery, newEvent, nowIso, parseDateInput, recordSearchText, uid } from './model.ts';
import { makeNode, nodeSearchText } from './graph.ts';

export type Candidate = { id: string; label: string; description: string; wikipediaTitle: string | null };
export type FactValue = { text: string; id?: string; date?: string; coord?: [number, number] };
export type TopicEvent = { id: string; label: string; date: string; endDate: string; coord: [number, number] | null; place: string };
export type TopicLink = { url: string; label: string; note: string };
export type Topic = {
  id: string; label: string; description: string; aliases: string[]; types: string[]; isHuman: boolean;
  wikipedia: { title: string; url: string; extract: string; thumbnail: string | null } | null;
  facts: { property: string; label: string; values: FactValue[] }[];
  coord: [number, number] | null;
  dates: { start: string; end: string; kind: 'life' | 'event' | '' };
  links: { references: TopicLink[]; databases: TopicLink[]; languages: TopicLink[] };
  attribution: string; errors: Record<string, string>; fetchedAt: string;
};
export type NewsArticle = { title: string; url: string; domain: string; date: string; language: string; country: string };
export type NewsResult = { articles: NewsArticle[]; busy?: boolean; retryAfter?: number; error?: string };
export type WorkspaceMatch = { kind: 'record' | 'node' | 'item'; projectId: string; boardId: string; id: string; label: string; where: string };

const ORIGIN = 'Explore (Wikidata/Wikipedia)';
const wikidataUrl = (id: string) => `https://www.wikidata.org/wiki/${id}`;
/** Only dates Atlas can read (YYYY, YYYY-MM, YYYY-MM-DD) are kept; others stay visible on the Explore page only. */
const atlasDate = (d: string) => (d && parseDateInput(d).ok ? parseDateInput(d).value : '');
const precisionOf = (d: string) => (d.length === 10 ? 'Exact day' : d.length === 7 ? 'Month' : d ? 'Year' : '');

/** Record category from Wikidata's "instance of" labels; specific phrases ("armed conflict", "armed forces") are tested before "armed". */
export function categoryFor(topic: Topic): string {
  const has = (re: RegExp) => topic.types.some(t => re.test(t));
  if (topic.isHuman) return 'Actor';
  if (has(/\bwar\b|conflict|battle|insurgency/i)) return 'Conflict';
  if (has(/military unit|armed forces|\barmy\b|\bnavy\b|air force|police/i)) return 'State force';
  if (has(/armed|militant|terroris|paramilitar|rebel|guerrilla|insurgent/i)) return 'Armed organization';
  if (has(/\bcountry\b|sovereign state/i)) return 'Country';
  if (has(/weapon|aircraft|vehicle|missile|firearm/i)) return 'Equipment';
  return topic.dates.kind === 'event' ? 'Event' : 'Actor';
}

function wikidataEvidence(id: string, accessed: string, supports: string[]): Evidence {
  return { ...emptyEvidence(), title: `Wikidata ${id}`, publisher: 'Wikidata', url: wikidataUrl(id), accessedDate: accessed, sourceType: 'Dataset', claim: `Structured data as accessed on ${accessed}`, supports, license: 'CC0 / Public domain' };
}
const provenance = (id: string) => { const t = nowIso(); return { origin: ORIGIN, createdAt: t, updatedAt: t, dataset: 'Wikidata', datasetLicense: 'CC0 / Public domain', datasetUrl: wikidataUrl(id), originalId: id }; };
const place = (coord: [number, number] | null) => (coord ? { longitude: coord[0], latitude: coord[1] } : {});

/** The whole topic as one record: unverified, with Wikipedia and Wikidata as its sources. People get no map position. */
export function topicToRecord(topic: Topic, accessed: string): EventItem {
  const date = atlasDate(topic.dates.start), endDate = atlasDate(topic.dates.end);
  const coord = topic.isHuman ? null : topic.coord;
  const supports = ['title', ...(date ? ['date'] : []), ...(coord ? ['location'] : [])];
  const wp = topic.wikipedia;
  const evidence: Evidence[] = [
    ...(wp ? [{ ...emptyEvidence(), title: wp.title, publisher: 'Wikipedia', url: wp.url, accessedDate: accessed, sourceType: 'Other', claim: `Summary as accessed on ${accessed}`, supports, license: 'CC BY-SA 4.0' }] : []),
    wikidataEvidence(topic.id, accessed, supports),
  ];
  const description = [`${topic.dates.kind === 'life' ? 'Life span (birth–death). ' : ''}${wp?.extract || ''}`.trim(), topic.description ? `Wikidata: ${topic.description}` : ''].filter(Boolean).join('\n\n');
  return newEvent({
    name: topic.label, category: categoryFor(topic), date, endDate, datePrecision: precisionOf(date), ...place(coord),
    description, evidence, tags: ['Explore'], verification: 'Unverified', confidence: 'Unverified', provenance: provenance(topic.id),
  });
}

/** A related event as its own record, linked to the topic by tag (not by an attribution claim). */
export function eventToRecord(ev: TopicEvent, topic: Topic, accessed: string): EventItem {
  const date = atlasDate(ev.date), endDate = atlasDate(ev.endDate);
  const supports = ['title', ...(date ? ['date'] : []), ...(ev.coord ? ['location'] : [])];
  return newEvent({
    name: ev.label, category: 'Event', date, endDate, datePrecision: precisionOf(date), place: ev.place, ...place(ev.coord),
    description: `Linked to ${topic.label} in Wikidata.`, evidence: [wikidataEvidence(ev.id, accessed, supports)],
    tags: ['Explore', topic.label], verification: 'Unverified', confidence: 'Unverified', provenance: provenance(ev.id),
  });
}

export function topicToNode(topic: Topic, id: string, x: number, y: number): Node {
  const category = categoryFor(topic);
  const kind = topic.isHuman ? 'Actor' : category === 'Armed organization' || category === 'State force' ? 'Organisation'
    : category === 'Event' || category === 'Conflict' ? 'Historical event' : category === 'Country' ? 'Place' : 'Note';
  const node = makeNode(id, x, y, topic.label, kind, 'Unverified', topic.description || 'From Wikidata');
  return { ...node, data: { ...node.data, wikidata: topic.id, url: topic.wikipedia?.url || wikidataUrl(topic.id) } };
}

export const newsToLinks = (articles: NewsArticle[]): TopicLink[] =>
  articles.map(a => ({ url: a.url, label: a.title, note: [a.domain, a.date, a.language].filter(Boolean).join(', ') }));

/** Adds links to the board's "Explore: <topic>" folder (or the folder named), creating it once; URLs already in it are skipped. */
export function saveLinks(board: Board, topicLabel: string, links: TopicLink[], folderName = `Explore: ${topicLabel}`): { board: Board; added: number } {
  const name = folderName;
  const folder = board.folders.find(f => f.name === name) || { id: uid(), name, items: [] };
  const seen = new Set(folder.items.map(i => i.url).filter(Boolean));
  const added: FolderItem[] = [];
  for (const l of links) {
    if (!/^https?:\/\/\S+$/i.test(l.url) || seen.has(l.url)) continue; // only plain web links, never javascript: or data:
    seen.add(l.url);
    added.push({ id: uid(), name: l.label || l.url, kind: 'link', url: l.url, body: l.note, nodeIds: [], recordIds: [], createdAt: nowIso() });
  }
  const next = { ...folder, items: [...folder.items, ...added] };
  const folders = board.folders.some(f => f.id === folder.id) ? board.folders.map(f => (f.id === folder.id ? next : f)) : [...board.folders, next];
  return { board: { ...board, folders }, added: added.length };
}

export const findDuplicate = (board: Board, qid: string) => board.events.find(e => e.provenance?.originalId === qid);

/** Records, graph nodes and folder items in every project that match the query (at most 50). */
export function workspaceMatches(projects: Project[], query: string): WorkspaceMatch[] {
  if (!query.trim()) return [];
  const out: WorkspaceMatch[] = [];
  for (const p of projects) for (const b of p.boards) {
    const where = (what: string) => `${p.name} › ${b.name} › ${what}`;
    for (const e of b.events) if (matchesQuery(recordSearchText(e), query)) out.push({ kind: 'record', projectId: p.id, boardId: b.id, id: e.id, label: e.name || 'Untitled record', where: where('record') });
    for (const n of b.nodes) if (matchesQuery(nodeSearchText(n), query)) out.push({ kind: 'node', projectId: p.id, boardId: b.id, id: n.id, label: String((n.data as Record<string, unknown>)?.label || 'Node'), where: where('graph') });
    for (const f of b.folders) for (const i of f.items) if (matchesQuery(`${i.name} ${i.body || ''} ${i.url || ''}`, query)) out.push({ kind: 'item', projectId: p.id, boardId: b.id, id: i.id, label: i.name, where: where(`folder ${f.name}`) });
  }
  return out.slice(0, 50);
}
