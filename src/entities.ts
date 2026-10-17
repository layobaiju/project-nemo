// Connected investigation view: people, organisations, places and events derived from a project's graph nodes,
// record actors and record countries. Nothing here changes records or nodes; only the user's merge and
// "not the same" decisions are stored (project.entityDecisions).
import type { EntityDecisions, EventItem, Evidence, FolderItem, Project } from './types.ts';
import { normalizeName, normalizeUrl, nowIso, uid } from './model.ts';

export type Family = 'actor' | 'place' | 'event';
export type EntityKind = 'Person' | 'Organisation' | 'Other actor' | 'Place' | 'Event';
export type Mention =
  | { type: 'node'; boardId: string; nodeId: string; name: string; kind: EntityKind; qid?: string }
  | { type: 'actor'; boardId: string; recordId: string; name: string; kind: EntityKind; role: string; attribution: string }
  | { type: 'country'; boardId: string; recordId: string; name: string; kind: 'Place' };
export type RecordRef = { boardId: string; recordId: string; role: string };
export type NodeRef = { boardId: string; nodeId: string };
export type Entity = {
  key: string; keys: string[]; name: string; kind: EntityKind; family: Family; aliases: string[];
  qids: string[]; mentions: Mention[]; records: RecordRef[]; nodes: NodeRef[];
  /** Set when the user merged this entity from several. */
  mergeId?: string;
  /** For a plain name that matches several Wikidata entities: their keys. */
  ambiguous?: string[];
};
export type EntityIndex = { entities: Entity[]; byKey: Map<string, Entity> };

export const FAMILY: Record<EntityKind, Family> = { Person: 'actor', Organisation: 'actor', 'Other actor': 'actor', Place: 'place', Event: 'event' };
const NODE_KIND: Record<string, EntityKind> = { Actor: 'Person', Organisation: 'Organisation', Place: 'Place', Event: 'Event', 'Historical event': 'Event' };

export const nodeEntityKind = (kind: string): EntityKind | null => NODE_KIND[kind] ?? null;
export function actorEntityKind(type: string): EntityKind {
  if (type === 'Individual') return 'Person';
  if (!type || type === 'Other / unknown') return 'Other actor';
  return 'Organisation';
}
export const nameKey = (family: Family, name: string) => `n:${family}:${normalizeName(name)}`;

const cleanName = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const qidOf = (v: unknown) => (typeof v === 'string' && /^Q\d+$/.test(v) ? v : undefined);
const at = (boardId: string, id: string) => `${boardId}\u0000${id}`;

/** The most frequent value; ties go to the one seen first. */
function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined, bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { best = v; bestN = n; }
  }
  return best;
}

type Group = { keys: Set<string>; mentions: Mention[]; family: Family; ambiguous?: string[] };

/** Every mention in board order, nodes before records, plus which records each node stands for. */
function collect(project: Project) {
  const mentions: Mention[] = [];
  const nodeRecords = new Map<string, string[]>();
  for (const b of project.boards) {
    const ids = new Set(b.events.map(e => e.id));
    for (const n of b.nodes) {
      const d = (n.data || {}) as Record<string, unknown>;
      const kind = nodeEntityKind(String(d.kind ?? '')), name = cleanName(d.label);
      if (!kind || !normalizeName(name)) continue;
      mentions.push({ type: 'node', boardId: b.id, nodeId: n.id, name, kind, qid: qidOf(d.wikidata) });
      const rid = typeof d.recordId === 'string' && ids.has(d.recordId) ? [d.recordId] : [];
      nodeRecords.set(at(b.id, n.id), rid);
    }
    for (const e of b.events) {
      if (e.nodeId && nodeRecords.has(at(b.id, e.nodeId))) {
        const list = nodeRecords.get(at(b.id, e.nodeId))!;
        if (!list.includes(e.id)) list.push(e.id);
      }
      for (const a of e.actors) {
        const name = cleanName(a.name);
        if (normalizeName(name)) mentions.push({ type: 'actor', boardId: b.id, recordId: e.id, name, kind: actorEntityKind(a.type), role: a.role, attribution: a.attribution });
      }
      for (const c of e.countries) {
        const name = cleanName(c);
        if (normalizeName(name)) mentions.push({ type: 'country', boardId: b.id, recordId: e.id, name, kind: 'Place' });
      }
    }
  }
  return { mentions, nodeRecords };
}

/** Groups mentions: one Wikidata ID is one entity; a plain name joins the single Wikidata entity carrying it. */
function group(mentions: Mention[]): Group[] {
  const groups: Group[] = [];
  const byQid = new Map<string, Group>(), byName = new Map<string, Group>(), nameQids = new Map<string, Set<string>>();
  for (const m of mentions) {
    if (m.type !== 'node' || !m.qid) continue;
    let g = byQid.get(m.qid);
    if (!g) { g = { keys: new Set([`wd:${m.qid}`]), mentions: [], family: FAMILY[m.kind] }; byQid.set(m.qid, g); groups.push(g); }
    g.mentions.push(m);
    const k = nameKey(FAMILY[m.kind], m.name);
    g.keys.add(k);
    if (!nameQids.has(k)) nameQids.set(k, new Set());
    nameQids.get(k)!.add(m.qid);
  }
  for (const m of mentions) {
    if (m.type === 'node' && m.qid) continue;
    const k = nameKey(FAMILY[m.kind], m.name), qids = nameQids.get(k);
    if (qids?.size === 1) { const g = byQid.get([...qids][0])!; g.mentions.push(m); continue; }
    let g = byName.get(k);
    if (!g) {
      g = { keys: new Set([k]), mentions: [], family: FAMILY[m.kind], ambiguous: qids ? [...qids].map(q => `wd:${q}`) : undefined };
      byName.set(k, g); groups.push(g);
    }
    g.mentions.push(m);
  }
  return groups;
}

type AppliedMerge = { id: string; name: string; keys: string[] };

function toEntity(parts: Group[], order: Map<Mention, number>, nodeRecords: Map<string, string[]>, merge?: AppliedMerge): Entity {
  const mentions = parts.flatMap(g => g.mentions).sort((a, b) => order.get(a)! - order.get(b)!);
  const qidNodes = mentions.filter(m => m.type === 'node' && m.qid) as Extract<Mention, { type: 'node' }>[];
  const qids = [...new Set(qidNodes.map(m => m.qid!))];
  const keys = new Set(parts.flatMap(g => [...g.keys]));
  const key = merge ? `m:${merge.id}` : qids.length ? `wd:${qids[0]}` : [...parts[0].keys][0];
  keys.add(key);
  // Keys of earlier merges folded into this one, so a remembered selection still finds the entity.
  for (const k of merge?.keys || []) if (k.startsWith('m:')) keys.add(k);
  const name = merge?.name || mostCommon(qidNodes.map(m => m.name)) || mostCommon(mentions.map(m => m.name)) || '';
  const kind = qidNodes[0]?.kind || mostCommon(mentions.map(m => m.kind)) || 'Other actor';
  const records: RecordRef[] = [], seen = new Set<string>(), nodes: NodeRef[] = [];
  const addRecord = (boardId: string, recordId: string, role: string) => {
    const k = at(boardId, recordId);
    if (!seen.has(k)) { seen.add(k); records.push({ boardId, recordId, role }); }
  };
  for (const m of mentions) {
    if (m.type === 'actor') addRecord(m.boardId, m.recordId, `Actor · ${m.attribution || 'Unknown'}`);
    else if (m.type === 'country') addRecord(m.boardId, m.recordId, 'Country');
    else {
      nodes.push({ boardId: m.boardId, nodeId: m.nodeId });
      for (const rid of nodeRecords.get(at(m.boardId, m.nodeId)) || []) addRecord(m.boardId, rid, 'Linked node');
    }
  }
  const aliases = [...new Set(mentions.map(m => m.name))].filter(n => n !== name);
  const ambiguous = parts.length === 1 ? parts[0].ambiguous : undefined;
  return { key, keys: [...keys], name, kind, family: parts[0].family, aliases, qids, mentions, records, nodes, ...(merge ? { mergeId: merge.id } : {}), ...(ambiguous ? { ambiguous } : {}) };
}

/** Joins the groups that a merge decision names (union-find). Merges across families are ignored. */
function applyMerges(groups: Group[], decisions?: EntityDecisions): { parts: Group[]; merge?: AppliedMerge }[] {
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  groups.forEach((g, i) => g.keys.forEach(k => owner.set(k, i)));
  const mergeOf = new Map<number, AppliedMerge>();
  for (const m of decisions?.merges || []) {
    const hit = [...new Set(m.keys.map(k => owner.get(k)).filter((i): i is number => i != null))];
    if (hit.length < 2 || hit.some(i => groups[i].family !== groups[hit[0]].family)) continue;
    for (const i of hit.slice(1)) parent[find(i)] = find(hit[0]);
    mergeOf.set(find(hit[0]), { id: m.id, name: m.name, keys: m.keys });
  }
  const comps = new Map<number, Group[]>();
  groups.forEach((g, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r)!.push(g); });
  return [...comps.entries()].map(([root, parts]) => ({ parts, merge: parts.length > 1 ? mergeOf.get(root) : undefined }));
}

export function buildEntities(project: Project, decisions?: EntityDecisions): EntityIndex {
  const { mentions, nodeRecords } = collect(project);
  const order = new Map(mentions.map((m, i) => [m, i]));
  const entities = applyMerges(group(mentions), decisions).map(c => toEntity(c.parts, order, nodeRecords, c.merge));
  const byKey = new Map<string, Entity>();
  for (const e of entities) for (const k of e.keys) byKey.set(k, e);
  return { entities, byKey };
}

/** The entity's records, resolved, with its role on each. */
export function entityRecords(project: Project, e: Entity): { boardId: string; record: EventItem; role: string }[] {
  const boards = new Map(project.boards.map(b => [b.id, b]));
  const cache = new Map<string, Map<string, EventItem>>();
  const lookup = (bid: string) => {
    if (!cache.has(bid)) cache.set(bid, new Map((boards.get(bid)?.events || []).map(r => [r.id, r])));
    return cache.get(bid)!;
  };
  return e.records.flatMap(r => { const record = lookup(r.boardId).get(r.recordId); return record ? [{ boardId: r.boardId, record, role: r.role }] : []; });
}

/** Sources across the entity's records, de-duplicated by URL (or title), with how many records each supports. */
export function entitySources(project: Project, e: Entity): { evidence: Evidence; count: number }[] {
  const out = new Map<string, { evidence: Evidence; count: number }>();
  for (const { record } of entityRecords(project, e)) {
    const keys = new Set<string>();
    for (const ev of record.evidence) {
      const k = ev.url ? `u:${normalizeUrl(ev.url)}` : normalizeName(ev.title) ? `t:${normalizeName(ev.title)}` : '';
      if (!k || keys.has(k)) continue;
      keys.add(k);
      const row = out.get(k);
      if (row) row.count++; else out.set(k, { evidence: ev, count: 1 });
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

/** Folder items linked to the entity's nodes, or to the records those nodes stand for. */
export function entityFolderItems(project: Project, e: Entity): { boardId: string; folder: string; item: FolderItem }[] {
  const nodes = new Set(e.nodes.map(n => at(n.boardId, n.nodeId)));
  const records = new Set(e.records.filter(r => r.role === 'Linked node').map(r => at(r.boardId, r.recordId)));
  const out: { boardId: string; folder: string; item: FolderItem }[] = [];
  for (const b of project.boards) for (const f of b.folders) for (const item of f.items) {
    const nodeIds = [...(item.nodeIds || []), ...(item.nodeId ? [item.nodeId] : [])];
    if (nodeIds.some(id => nodes.has(at(b.id, id))) || (item.recordIds || []).some(id => records.has(at(b.id, id)))) out.push({ boardId: b.id, folder: f.name, item });
  }
  return out;
}

// ---------- connections ----------
export type GraphLink = { boardId: string; edgeId: string; relation: string; outgoing: boolean };
export type Connection = { key: string; name: string; kind: EntityKind; graph: GraphLink[]; shared: { boardId: string; recordId: string }[] };

/**
 * What an entity is connected to: graph edges between its nodes and another entity's nodes, and entities listed on
 * the same records. Being listed together is not evidence of a relationship; the page says so.
 */
export function connectionsOf(project: Project, index: EntityIndex, key: string, limit = 24): { shown: Connection[]; total: number } {
  const me = index.byKey.get(key);
  if (!me) return { shown: [], total: 0 };
  const nodeOwner = new Map<string, Entity>(), recordOwners = new Map<string, Entity[]>();
  for (const e of index.entities) {
    for (const n of e.nodes) nodeOwner.set(at(n.boardId, n.nodeId), e);
    for (const r of e.records) { const k = at(r.boardId, r.recordId); if (!recordOwners.has(k)) recordOwners.set(k, []); recordOwners.get(k)!.push(e); }
  }
  const conns = new Map<Entity, Connection>();
  const get = (o: Entity) => { let c = conns.get(o); if (!c) { c = { key: o.key, name: o.name, kind: o.kind, graph: [], shared: [] }; conns.set(o, c); } return c; };
  for (const b of project.boards) for (const edge of b.edges) {
    const s = nodeOwner.get(at(b.id, edge.source)), t = nodeOwner.get(at(b.id, edge.target));
    if (!s || !t || s === t || (s !== me && t !== me)) continue;
    const relation = String((edge.data as Record<string, unknown> | undefined)?.relation || String(edge.label || '').split(' · ')[0] || 'related to');
    get(s === me ? t : s).graph.push({ boardId: b.id, edgeId: edge.id, relation, outgoing: s === me });
  }
  for (const r of me.records) for (const o of recordOwners.get(at(r.boardId, r.recordId)) || []) if (o !== me) get(o).shared.push({ boardId: r.boardId, recordId: r.recordId });
  const all = [...conns.values()].sort((a, b) => Number(b.graph.length > 0) - Number(a.graph.length > 0) || b.shared.length - a.shared.length || b.graph.length - a.graph.length || a.name.localeCompare(b.name));
  return { shown: all.slice(0, limit), total: all.length };
}

// ---------- possible duplicates ----------
export type DuplicateSuggestion = { a: string; b: string; reason: 'spelling' | 'contains' | 'same-name' };

/** Levenshtein distance, giving up as soon as it must exceed `max` (then returns max + 1). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return Math.min(prev[b.length], max + 1);
}

const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
const MAX_PER_FAMILY = 3000;

/**
 * Pairs that may be the same entity: names within 2 letters of each other, one name containing the other, or a plain
 * name that matches several Wikidata entities. Never merged automatically; the user decides.
 */
export function suggestDuplicates(index: EntityIndex, decisions?: EntityDecisions, limit = 200): DuplicateSuggestion[] {
  const distinct = new Set((decisions?.distinct || []).map(([a, b]) => pairKey(a, b)));
  const isDistinct = (x: Entity, y: Entity) => distinct.size > 0 && x.keys.some(a => y.keys.some(b => distinct.has(pairKey(a, b))));
  const out: (DuplicateSuggestion & { weight: number })[] = [], seen = new Set<string>();
  const add = (x: Entity, y: Entity, reason: DuplicateSuggestion['reason']) => {
    const k = pairKey(x.key, y.key);
    if (seen.has(k) || isDistinct(x, y)) return;
    seen.add(k);
    out.push({ a: x.key, b: y.key, reason, weight: x.mentions.length + y.mentions.length });
  };
  for (const e of index.entities) for (const k of e.ambiguous || []) { const o = index.byKey.get(k); if (o && o !== e) add(e, o, 'same-name'); }
  for (const family of ['actor', 'place', 'event'] as Family[]) {
    const list = index.entities.filter(e => e.family === family).sort((a, b) => b.mentions.length - a.mentions.length).slice(0, MAX_PER_FAMILY).map(e => {
      const n = normalizeName(e.name), compact = n.replace(/ /g, ''), words = n.split(' ');
      return { e, n, letters: compact.length, words, set: new Set(words), digits: n.replace(/\D/g, '') };
    });
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.digits !== b.digits || a.n === b.n) continue;
      if (a.e.qids.length && b.e.qids.length && !a.e.qids.some(q => b.e.qids.includes(q))) continue;
      if (a.letters >= 6 && b.letters >= 6 && Math.abs(a.n.length - b.n.length) <= 2 && editDistance(a.n, b.n, 2) <= 2) { add(a.e, b.e, 'spelling'); continue; }
      const [s, l] = a.letters <= b.letters ? [a, b] : [b, a];
      if (s.letters >= 5 && s.words.every(w => l.set.has(w))) add(a.e, b.e, 'contains');
    }
  }
  return out.sort((x, y) => y.weight - x.weight).slice(0, limit).map(({ weight: _w, ...s }) => s);
}

// ---------- the user's decisions (saved in project.entityDecisions) ----------
export const emptyDecisions = (): EntityDecisions => ({ merges: [], distinct: [] });

/** Records that two entities are one. Returns null for an actor and a place (or event): those never merge. */
export function mergeEntities(d: EntityDecisions, a: Entity, b: Entity, name: string, by: string, at = nowIso()): EntityDecisions | null {
  if (a.family !== b.family || a === b) return null;
  const keys = new Set([...a.keys, ...b.keys]);
  // Merges that share a key with this one are folded into it, so each entity belongs to one merge at most.
  const kept = d.merges.filter(m => { if (!m.keys.some(k => keys.has(k))) return true; m.keys.forEach(k => keys.add(k)); return false; });
  return { ...d, merges: [...kept, { id: uid(), keys: [...keys], name: name.trim() || a.name, at, by }] };
}
export const unmerge = (d: EntityDecisions, mergeId: string): EntityDecisions => ({ ...d, merges: d.merges.filter(m => m.id !== mergeId) });

/** A key that outlives merges: the Wikidata ID, else the displayed name's key. Never the `m:` key of a merge. */
function lastingKey(e: Entity): string {
  const own = nameKey(e.family, e.name);
  return e.keys.find(k => k.startsWith('wd:')) || (e.keys.includes(own) ? own : e.keys.find(k => k.startsWith('n:'))) || e.key;
}

/** "Not the same": the pair is never suggested again, even after a merge or unmerge. */
export function markDistinct(d: EntityDecisions, a: Entity, b: Entity): EntityDecisions {
  const pair = [lastingKey(a), lastingKey(b)].sort() as [string, string];
  if (d.distinct.some(([x, y]) => pairKey(x, y) === pairKey(...pair))) return d;
  return { ...d, distinct: [...d.distinct, pair] };
}
