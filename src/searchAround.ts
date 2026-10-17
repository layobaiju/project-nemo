// Search around: expands a graph node into its Wikidata connections (host: /api/explore/neighbors/:qid).
// Pure functions over a board, so placement, reuse, link direction and undo can be unit-tested.
import type { Edge, Node } from '@xyflow/react';
import type { Board } from './types.ts';
import { uid } from './model.ts';
import { makeEdge, makeNode } from './graph.ts';

export type NeighborItem = { id: string; label: string; description: string; kind: string };
export type NeighborGroup = { key: string; property: string; relation: string; direction: 'out' | 'in'; items: NeighborItem[] };
export type Neighbors = { id: string; label: string; groups: NeighborGroup[]; capped: boolean; errors: Record<string, string> };
export type Pick = { group: NeighborGroup; item: NeighborItem };
/** What one expansion added, so it can be undone exactly. */
export type Expansion = { nodeIds: string[]; edgeIds: string[] };

const PLACEHOLDER = 'Add a summary and public source.';
const RING = 260, OUTER_RING = 420, RING_SIZE = 16;
export const wikidataUrl = (id: string) => `https://www.wikidata.org/wiki/${id}`;
const dataOf = (n: Node) => (n.data || {}) as Record<string, unknown>;

export function wikidataIdOf(node: Node): string | undefined {
  const id = dataOf(node).wikidata;
  return typeof id === 'string' && /^Q\d+$/.test(id) ? id : undefined;
}

/** Links a hand-made node to a Wikidata item, keeping the user's own label. */
export function linkNodeToWikidata(board: Board, nodeId: string, c: { id: string; description: string }): Board {
  return { ...board, nodes: board.nodes.map(n => {
    if (n.id !== nodeId) return n;
    const d = dataOf(n), detail = String(d.detail || '');
    return { ...n, data: { ...d, wikidata: c.id, url: wikidataUrl(c.id), detail: !detail || detail === PLACEHOLDER ? c.description || detail : detail } };
  }) };
}

const sameLink = (e: Edge, source: string, target: string, relation: string) => e.source === source && e.target === target && (e.data as Record<string, unknown> | undefined)?.relation === relation;

/**
 * Adds the picked neighbours around a node: new typed nodes on a ring (a second ring beyond 16), labelled links in the
 * direction of the Wikidata statement. A neighbour already on the board is linked, not duplicated, and a link that
 * already exists is not added again.
 */
export function expandNode(board: Board, nodeId: string, picks: Pick[]): { board: Board; added: Expansion } {
  const center = board.nodes.find(n => n.id === nodeId);
  const added: Expansion = { nodeIds: [], edgeIds: [] };
  if (!center) return { board, added };
  const byItem = new Map<string, Node>();
  for (const n of board.nodes) { const q = wikidataIdOf(n); if (q && !byItem.has(q)) byItem.set(q, n); }
  const fresh = [...new Set(picks.map(p => p.item.id).filter(id => !byItem.has(id)))];
  const nodes: Node[] = [], edges: Edge[] = [];
  for (const { group, item } of picks) {
    let node = byItem.get(item.id);
    if (!node) {
      const i = fresh.indexOf(item.id);
      const inner = i < RING_SIZE, ringCount = inner ? Math.min(fresh.length, RING_SIZE) : fresh.length - RING_SIZE;
      const slot = inner ? i : i - RING_SIZE, r = inner ? RING : OUTER_RING;
      const angle = (2 * Math.PI * slot) / ringCount - Math.PI / 2;
      const made = makeNode(uid(), center.position.x + r * Math.cos(angle), center.position.y + r * Math.sin(angle), item.label, item.kind, 'Unverified', item.description || 'From Wikidata');
      node = { ...made, data: { ...made.data, wikidata: item.id, url: wikidataUrl(item.id) } };
      nodes.push(node);
      byItem.set(item.id, node);
      added.nodeIds.push(node.id);
    }
    const [source, target] = group.direction === 'out' ? [center.id, node.id] : [node.id, center.id];
    if ([...board.edges, ...edges].some(e => sameLink(e, source, target, group.relation))) continue;
    const edge = makeEdge(source, target, group.relation, 'many-to-many', {
      data: { relation: group.relation, cardinality: 'many-to-many', origin: 'Wikidata', property: group.property, note: 'From Wikidata (unverified)' },
      style: { strokeDasharray: '5 4' },
    });
    edges.push(edge);
    added.edgeIds.push(edge.id);
  }
  return { board: { ...board, nodes: [...board.nodes, ...nodes], edges: [...board.edges, ...edges] }, added };
}

/** Removes exactly what one expansion added (plus any links later drawn to those nodes); reused nodes stay. */
export function undoExpansion(board: Board, added: Expansion): Board {
  const nodes = new Set(added.nodeIds), edges = new Set(added.edgeIds);
  return {
    ...board,
    nodes: board.nodes.filter(n => !nodes.has(n.id)),
    edges: board.edges.filter(e => !edges.has(e.id) && !nodes.has(e.source) && !nodes.has(e.target)),
  };
}
