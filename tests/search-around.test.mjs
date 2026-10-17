// Search around on the graph: expanding a node into its Wikidata connections, linking and undo. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProjects } from '../src/model.ts';
import { makeNode, makeEdge } from '../src/graph.ts';
import { expandNode, linkNodeToWikidata, undoExpansion, wikidataIdOf } from '../src/searchAround.ts';
import { emptyBoard } from './fixtures.mjs';

const N = JSON.parse(readFileSync(new URL('./fixtures/explore/neighbors-Q1317.json', import.meta.url), 'utf8'));
const pick = (key, label) => { const group = N.groups.find(g => g.key === key); return { group, item: group.items.find(i => i.label === label) }; };
function board() {
  const center = makeNode('c', 500, 400, 'osama binladen', 'Source');
  center.data = { ...center.data, wikidata: 'Q1317' };
  const riyadh = makeNode('x', 100, 100, 'Riyadh (my note)', 'Place');
  riyadh.data = { ...riyadh.data, wikidata: 'Q3692' };
  const other = makeNode('o', 0, 0, 'Other note');
  const b = normalizeProjects([{ id: 'p', boards: [emptyBoard('b', 'Board')] }])[0].boards[0];
  return { ...b, nodes: [center, riyadh, other], edges: [makeEdge('x', 'o', 'mentioned in', 'one-to-one')] };
}
const dist = (a, b) => Math.round(Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y));

test('expansion adds typed nodes on a ring and directed, labelled links', () => {
  const b = board();
  const { board: next, added } = expandNode(b, 'c', [pick('out:P463', 'Al-Qaeda'), pick('in:P533', 'killing of Osama bin Laden'), pick('out:P27', 'Saudi Arabia')]);
  assert.equal(added.nodeIds.length, 3);
  assert.equal(added.edgeIds.length, 3);
  const center = next.nodes.find(n => n.id === 'c');
  const created = next.nodes.filter(n => added.nodeIds.includes(n.id));
  assert.deepEqual(created.map(n => dist(n, center)), [260, 260, 260]);
  const alQaeda = created.find(n => n.data.label === 'Al-Qaeda');
  assert.deepEqual([alQaeda.data.kind, alQaeda.data.wikidata, alQaeda.data.url], ['Organisation', 'Q34490', 'https://www.wikidata.org/wiki/Q34490']);
  const killing = created.find(n => n.data.label === 'killing of Osama bin Laden');
  const edges = next.edges.filter(e => added.edgeIds.includes(e.id));
  const member = edges.find(e => e.target === alQaeda.id);
  assert.deepEqual([member.source, member.label], ['c', 'member of · N:M'], 'outgoing: the expanded node points to its neighbour');
  const target = edges.find(e => e.source === killing.id);
  assert.equal(target.target, 'c', 'incoming: the neighbour points to the expanded node');
  assert.deepEqual([member.data.origin, member.data.property, member.data.note], ['Wikidata', 'P463', 'From Wikidata (unverified)']);
  assert.ok(member.style?.strokeDasharray, 'Wikidata links are dashed');
});

test('expanding twice reuses nodes and adds no duplicate links', () => {
  const first = expandNode(board(), 'c', [pick('out:P463', 'Al-Qaeda'), pick('out:P19', 'Riyadh')]);
  assert.equal(first.added.nodeIds.length, 1, 'Riyadh is already on the board, so only Al-Qaeda is new');
  assert.ok(first.board.edges.some(e => e.source === 'c' && e.target === 'x' && e.data.relation === 'place of birth'), 'the existing Riyadh node is linked');
  const second = expandNode(first.board, 'c', [pick('out:P463', 'Al-Qaeda'), pick('out:P19', 'Riyadh')]);
  assert.deepEqual(second.added, { nodeIds: [], edgeIds: [] });
  assert.equal(second.board.nodes.length, first.board.nodes.length);
  assert.equal(second.board.edges.length, first.board.edges.length);
});

test('undo removes only what the expansion created', () => {
  const b = board();
  const { board: expanded, added } = expandNode(b, 'c', [pick('out:P463', 'Al-Qaeda'), pick('out:P19', 'Riyadh')]);
  const undone = undoExpansion(expanded, added);
  assert.deepEqual(undone.nodes.map(n => n.id), ['c', 'x', 'o'], 'the reused Riyadh node stays');
  assert.deepEqual(undone.edges.map(e => [e.source, e.target]), [['x', 'o']], 'links that existed before stay');
});

test('a big expansion uses a second ring', () => {
  const group = { key: 'in:P276', property: 'P276', relation: 'location', direction: 'in', items: Array.from({ length: 20 }, (_, i) => ({ id: `Q${700 + i}`, label: `Event ${i}`, description: '', kind: 'Historical event' })) };
  const { board: next, added } = expandNode(board(), 'c', group.items.map(item => ({ group, item })));
  const center = next.nodes.find(n => n.id === 'c');
  const rings = next.nodes.filter(n => added.nodeIds.includes(n.id)).map(n => dist(n, center));
  assert.equal(rings.filter(d => d === 260).length, 16);
  assert.equal(rings.filter(d => d === 420).length, 4);
});

test('linkNodeToWikidata sets the id and keeps the node own label', () => {
  const b = board();
  b.nodes.push(makeNode('u', 0, 0, 'al qaeda', 'Note'));
  assert.equal(wikidataIdOf(b.nodes[3]), undefined);
  const linked = linkNodeToWikidata(b, 'u', { id: 'Q34490', description: 'Salafi jihadist militant organization' });
  const u = linked.nodes.find(n => n.id === 'u');
  assert.equal(wikidataIdOf(u), 'Q34490');
  assert.equal(u.data.label, 'al qaeda');
  assert.equal(u.data.url, 'https://www.wikidata.org/wiki/Q34490');
  assert.equal(u.data.detail, 'Salafi jihadist militant organization', 'the placeholder summary is replaced by the description');
});
