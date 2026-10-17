import type { Edge, Node } from '@xyflow/react';
import type { EventItem, RecordLink } from './types.ts';
import { formatDateRange, normalizeName, normalizeUrl } from './model.ts';

/** The text a graph search looks at: label, kind and summary. */
export const nodeSearchText = (n: Node) => { const d = (n.data || {}) as Record<string, unknown>; return `${d.label ?? ''} ${d.kind ?? ''} ${d.detail ?? ''}`; };

export const NODE_KINDS = ['Note', 'Historical event', 'Source', 'Actor', 'Organisation', 'Place', 'Claim', 'Question', 'Idea', 'Task', 'Requirement', 'Component', 'Decision', 'Event'];
export const CARDINALITIES = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'];
export const CARD_SHORT: Record<string, string> = { 'one-to-one': '1:1', 'one-to-many': '1:N', 'many-to-one': 'N:1', 'many-to-many': 'N:M' };

export const makeNode = (id: string, x: number, y: number, label: string, kind = 'Note', confidence = 'Unverified', detail = 'Add a summary and public source.'): Node =>
  ({ id, type: 'research', position: { x, y }, data: { label, kind, detail, confidence } });

export const recordNode = (id: string, e: EventItem, x: number, y: number): Node =>
  ({ id, type: 'research', position: { x, y }, data: { label: e.name || 'Untitled record', kind: 'Historical event', confidence: e.verification, detail: `${e.place || 'No place'} · ${formatDateRange(e)} · ${e.evidence.length} sources`, recordId: e.id } });

export function edgeLabel(relation: string, cardinality: string) {
  return `${relation || 'related to'} · ${CARD_SHORT[cardinality] || cardinality}`;
}
export function makeEdge(source: string, target: string, relation: string, cardinality: string, extra: Partial<Edge> = {}): Edge {
  return { id: `e-${Math.random().toString(36).slice(2, 10)}`, source, target, type: 'smoothstep', label: edgeLabel(relation, cardinality), data: { relation, cardinality }, ...extra };
}

export function layoutGrid(nodes: Node[]): Node[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  return nodes.map((n, i) => ({ ...n, position: { x: 80 + (i % cols) * 280, y: 80 + Math.floor(i / cols) * 190 } }));
}
export function layoutCircle(nodes: Node[]): Node[] {
  const r = Math.max(220, nodes.length * 42);
  return nodes.map((n, i) => ({ ...n, position: { x: r + 120 + r * Math.cos((2 * Math.PI * i) / nodes.length), y: r + 80 + r * Math.sin((2 * Math.PI * i) / nodes.length) } }));
}
/** Left-to-right layers following edge direction; cycles fall back to discovery order. */
export function layoutLayered(nodes: Node[], edges: Edge[]): Node[] {
  const out = new Map<string, string[]>(), indeg = new Map(nodes.map(n => [n.id, 0]));
  for (const e of edges) { if (!indeg.has(e.source) || !indeg.has(e.target)) continue; out.set(e.source, [...(out.get(e.source) || []), e.target]); indeg.set(e.target, (indeg.get(e.target) || 0) + 1); }
  const level = new Map<string, number>();
  const queue = nodes.filter(n => !indeg.get(n.id)).map(n => n.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  queue.forEach(id => level.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    for (const t of out.get(queue[i]) || []) if (!level.has(t)) { level.set(t, level.get(queue[i])! + 1); queue.push(t); }
    if (i === queue.length - 1) { const rest = nodes.find(n => !level.has(n.id)); if (rest) { level.set(rest.id, 0); queue.push(rest.id); } }
  }
  const rows = new Map<number, number>();
  return nodes.map(n => { const l = level.get(n.id) || 0, r = rows.get(l) || 0; rows.set(l, r + 1); return { ...n, position: { x: 80 + l * 300, y: 80 + r * 170 } }; });
}

export type LinkSuggestion = { source: string; target: string; reason: string; relation: string };
/** Suggests reviewable edges between record nodes. Shared attributes are research leads, not findings. */
export function suggestLinks(nodes: Node[], edges: Edge[], events: EventItem[], links: RecordLink[]): LinkSuggestion[] {
  const byNode = new Map<string, EventItem>();
  const byId = new Map(events.map(e => [e.id, e]));
  for (const n of nodes) {
    const rid = (n.data as any)?.recordId as string | undefined;
    const e = (rid && byId.get(rid)) || events.find(x => x.nodeId === n.id);
    if (e) byNode.set(n.id, e);
  }
  const connected = new Set(edges.flatMap(e => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]));
  const ids = [...byNode.keys()].slice(0, 250);
  const out: LinkSuggestion[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (connected.has(`${ids[i]}|${ids[j]}`)) continue;
    const a = byNode.get(ids[i])!, b = byNode.get(ids[j])!;
    const link = links.find(l => (l.a === a.id && l.b === b.id) || (l.a === b.id && l.b === a.id));
    if (link) { out.push({ source: ids[i], target: ids[j], reason: `Saved comparison link (score ${link.score})`, relation: 'comparison (analyst-created)' }); continue; }
    const actorsB = new Map(b.actors.map(x => [normalizeName(x.name), x.name]));
    const sharedActor = a.actors.find(x => x.name && actorsB.has(normalizeName(x.name)));
    if (sharedActor) { out.push({ source: ids[i], target: ids[j], reason: `Both records list “${sharedActor.name}” (as recorded; attribution may differ)`, relation: `both list ${sharedActor.name}` }); continue; }
    const key = (s: EventItem['evidence'][number]) => (s.url ? normalizeUrl(s.url) : normalizeName(s.title));
    const sb = new Set(b.evidence.map(key).filter(Boolean));
    const sharedSrc = a.evidence.find(s => key(s) && sb.has(key(s)));
    if (sharedSrc) { out.push({ source: ids[i], target: ids[j], reason: `Cite the same source “${sharedSrc.title || sharedSrc.url}”`, relation: 'share a source' }); continue; }
    if (a.conflictName && normalizeName(a.conflictName) === normalizeName(b.conflictName)) out.push({ source: ids[i], target: ids[j], reason: `Same conflict name “${a.conflictName}”`, relation: 'same conflict context' });
    if (out.length >= 60) return out;
  }
  return out;
}
