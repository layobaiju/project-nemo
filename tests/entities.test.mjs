// Connected investigation view: entities, connections, duplicate suggestions and merge decisions. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyEvidence, newEvent, normalizeProjects } from '../src/model.ts';
import { buildEntities, connectionsOf, editDistance, entityFolderItems, entityRecords, entitySources, nameKey, suggestDuplicates } from '../src/entities.ts';
import { emptyBoard, ucdpRecords } from './fixtures.mjs';

const proj = boards => normalizeProjects([{ id: 'p', name: 'P', description: '', boards }])[0];
const node = (id, label, kind, extra = {}) => ({ id, type: 'research', position: { x: 0, y: 0 }, data: { label, kind, detail: '', confidence: 'Unverified', ...extra } });
const actor = (name, type = 'Individual', attribution = 'Alleged', role = '') => ({ id: `a-${Math.random()}`, name, type, role, attribution, note: '' });
const rec = (id, fields = {}) => newEvent({ id, name: `Record ${id}`, ...fields });
const board = (id, { nodes = [], edges = [], events = [], folders } = {}) => ({ ...emptyBoard(id, `Board ${id}`, events), nodes, edges, ...(folders ? { folders } : {}) });

test('a Wikidata ID makes one entity across boards, and plain names join it', () => {
  const p = proj([
    board('A', { nodes: [node('n1', 'Osama bin Laden', 'Actor', { wikidata: 'Q1317' })] }),
    board('B', { nodes: [node('n2', 'Usama bin Laden', 'Actor', { wikidata: 'Q1317' })], events: [rec('r1', { actors: [actor('osama  BIN laden')] })] }),
  ]);
  const ix = buildEntities(p);
  const e = ix.byKey.get('wd:Q1317');
  assert.equal(e.name, 'Osama bin Laden');
  assert.equal(e.kind, 'Person');
  assert.deepEqual(e.qids, ['Q1317']);
  assert.equal(e.nodes.length, 2);
  assert.deepEqual(e.records, [{ boardId: 'B', recordId: 'r1', role: 'Actor · Alleged' }]);
  assert.ok(e.aliases.includes('Usama bin Laden'));
  assert.equal(ix.byKey.get(nameKey('actor', 'Osama bin Laden')), e);
  assert.equal(ix.entities.length, 1);
});

test('Person, Organisation and Other actor share names; places stay apart', () => {
  const p = proj([board('A', {
    nodes: [node('n1', 'Al-Qaeda', 'Organisation')],
    events: [
      rec('r1', { actors: [actor('Al-Qaeda', 'Armed group', 'Claimed')] }),
      rec('r2', { actors: [actor('al qaeda', '', 'Unknown')] }),
      rec('r3', { countries: ['Georgia'], actors: [actor('Georgia', 'Individual', 'Confirmed')] }),
    ],
  })]);
  const ix = buildEntities(p);
  const aq = ix.byKey.get(nameKey('actor', 'Al-Qaeda'));
  assert.equal(aq.kind, 'Organisation');
  assert.equal(aq.nodes.length, 1);
  assert.equal(aq.records.length, 2);
  const place = ix.byKey.get(nameKey('place', 'Georgia')), person = ix.byKey.get(nameKey('actor', 'Georgia'));
  assert.equal(place.kind, 'Place');
  assert.equal(person.kind, 'Person');
  assert.notEqual(place, person);
  assert.deepEqual(place.records, [{ boardId: 'A', recordId: 'r3', role: 'Country' }]);
});

test('a name shared by two Wikidata entities is not guessed', () => {
  const p = proj([board('A', {
    nodes: [node('n1', 'John Smith', 'Actor', { wikidata: 'Q1' }), node('n2', 'John Smith', 'Actor', { wikidata: 'Q2' })],
    events: [rec('r1', { actors: [actor('John Smith')] })],
  })]);
  const ix = buildEntities(p);
  const plain = ix.byKey.get(nameKey('actor', 'John Smith'));
  assert.deepEqual([...plain.ambiguous].sort(), ['wd:Q1', 'wd:Q2']);
  assert.notEqual(plain, ix.byKey.get('wd:Q1'));
  assert.notEqual(ix.byKey.get('wd:Q1'), ix.byKey.get('wd:Q2'));
  assert.equal(ix.entities.length, 3);
});

test('display name prefers the Wikidata label, then the most common spelling', () => {
  const p = proj([board('A', { events: [rec('r1', { actors: [actor('HAMAS', 'Armed group')] }), rec('r2', { actors: [actor('Hamas', 'Armed group')] }), rec('r3', { actors: [actor('Hamas', 'Armed group')] })] })]);
  const e = buildEntities(p).byKey.get(nameKey('actor', 'hamas'));
  assert.equal(e.name, 'Hamas');
  assert.deepEqual(e.aliases, ['HAMAS']);
  const q = buildEntities(proj([board('A', { nodes: [node('n1', 'Islamic State', 'Organisation', { wikidata: 'Q2429253' })], events: [rec('r1', { actors: [actor('islamic state', 'Armed group')] }), rec('r2', { actors: [actor('islamic state', 'Armed group')] })] })]));
  assert.equal(q.byKey.get('wd:Q2429253').name, 'Islamic State');
});

test('blank actors are skipped and a record counts once per entity', () => {
  const p = proj([board('A', { events: [rec('r1', { actors: [actor('  '), actor('Group X', 'Armed group', 'Alleged', 'Side A'), actor('group x', 'Armed group', 'Confirmed', 'Side B')], countries: ['Iraq', 'Iraq'] })] })]);
  const ix = buildEntities(p);
  assert.ok(ix.entities.every(e => e.name.trim()));
  assert.equal(ix.entities.length, 2);
  assert.equal(ix.byKey.get(nameKey('actor', 'Group X')).records.length, 1);
  assert.equal(ix.byKey.get(nameKey('place', 'Iraq')).records.length, 1);
});

test('records linked through nodes, folder items and sources', () => {
  const ev = (url, title = 'Report') => ({ ...emptyEvidence(), id: `ev-${Math.random()}`, url, title, publisher: 'Agency' });
  const p = proj([board('A', {
    nodes: [node('N', 'Siege of X', 'Historical event', { recordId: 'R1' })],
    events: [
      rec('R1', { evidence: [ev('https://example.org/a'), ev('https://example.org/b')] }),
      rec('R2', { nodeId: 'N', evidence: [ev('https://example.org/a')] }),
      rec('R3', { evidence: [ev('https://example.org/c')] }),
    ],
    folders: [{ id: 'f', name: 'Sources', items: [
      { id: 'i1', name: 'Linked to node', kind: 'note', nodeIds: ['N'], recordIds: [] },
      { id: 'i2', name: 'Linked to record', kind: 'note', nodeIds: [], recordIds: ['R1'] },
      { id: 'i3', name: 'Unrelated', kind: 'note', nodeIds: [], recordIds: ['R3'] },
    ] }],
  })]);
  const e = buildEntities(p).byKey.get(nameKey('event', 'Siege of X'));
  assert.equal(e.kind, 'Event');
  assert.deepEqual(e.records.map(r => [r.recordId, r.role]), [['R1', 'Linked node'], ['R2', 'Linked node']]);
  assert.deepEqual(entityRecords(p, e).map(r => r.record.id), ['R1', 'R2']);
  assert.deepEqual(entityFolderItems(p, e).map(x => x.item.id), ['i1', 'i2']);
  const src = entitySources(p, e);
  assert.deepEqual(src.map(s => [s.evidence.url, s.count]), [['https://example.org/a', 2], ['https://example.org/b', 1]]);
});

test('other node kinds make no entities', () => {
  const p = proj([board('A', { nodes: [node('n1', 'A note', 'Note'), node('n2', 'A source', 'Source'), node('n3', 'A claim', 'Claim')] })]);
  assert.equal(buildEntities(p).entities.length, 0);
});

test('a project with a 5,000-record board builds quickly', () => {
  const p = proj([emptyBoard('big', 'UCDP', ucdpRecords(5000))]);
  buildEntities(p); // warm-up, as the page builds on every change
  const t = performance.now();
  const ix = buildEntities(p);
  const ms = performance.now() - t;
  assert.ok(ms < 300, `took ${ms.toFixed(0)} ms`);
  assert.equal(ix.byKey.get(nameKey('place', 'Country 3')).records.length, 125);
  assert.equal(ix.byKey.get(nameKey('actor', 'Group 4')).kind, 'Organisation');
});

const edge = (id, source, target, relation) => ({ id, source, target, label: `${relation} · N:M`, data: { relation, cardinality: 'many-to-many' } });
const described = (ix, list) => list.map(s => `${[ix.byKey.get(s.a).name, ix.byKey.get(s.b).name].sort().join(' + ')} : ${s.reason}`).sort();

test('graph links and listed-together connections, ranked', () => {
  const p = proj([board('A', {
    nodes: [node('A1', 'Abu X', 'Actor', { wikidata: 'Q1' }), node('A2', 'Abu X', 'Actor', { wikidata: 'Q1' }), node('B', 'Org B', 'Organisation', { wikidata: 'Q2' }), node('C', 'Person C', 'Actor', { wikidata: 'Q3' })],
    edges: [edge('e1', 'A1', 'B', 'member of'), edge('e2', 'A1', 'A2', 'same as'), edge('e3', 'A1', 'missing', 'knows')],
    events: [
      rec('r1', { actors: [actor('Abu X'), actor('Group Z', 'Armed group')] }),
      rec('r2', { actors: [actor('Abu X'), actor('Group Z', 'Armed group')] }),
      rec('r3', { actors: [actor('Abu X')], countries: ['Iraq'] }),
    ],
  })]);
  const ix = buildEntities(p);
  const { shown, total } = connectionsOf(p, ix, 'wd:Q1');
  assert.equal(total, 3);
  assert.equal(shown[0].key, 'wd:Q2');
  assert.deepEqual(shown[0].graph.map(g => [g.relation, g.outgoing, g.edgeId]), [['member of', true, 'e1']]);
  assert.equal(shown[1].name, 'Group Z');
  assert.deepEqual(shown[1].shared.map(s => s.recordId), ['r1', 'r2']);
  assert.equal(shown[2].name, 'Iraq');
  assert.ok(!shown.some(c => c.key === 'wd:Q1'), 'no self-connection');
  assert.equal(connectionsOf(p, ix, 'wd:Q1', 1).shown.length, 1);
  assert.deepEqual(connectionsOf(p, ix, 'wd:Q2').shown.map(c => [c.key, c.graph[0].outgoing]), [['wd:Q1', false]]);
  assert.deepEqual(connectionsOf(p, ix, 'nothing'), { shown: [], total: 0 });
});

test('duplicate suggestions: spelling, containment, same name', () => {
  const p = proj([board('A', {
    nodes: [node('n1', 'John Smith', 'Actor', { wikidata: 'Q1' }), node('n2', 'John Smith', 'Actor', { wikidata: 'Q2' })],
    events: [rec('r1', { actors: [actor('Usama bin Ladin')] }), rec('r2', { actors: [actor('Osama bin Laden'), actor('John Smith')] }), rec('r3', { actors: [actor('bin Laden')] })],
  })]);
  const ix = buildEntities(p);
  assert.deepEqual(described(ix, suggestDuplicates(ix)), [
    'John Smith + John Smith : same-name', 'John Smith + John Smith : same-name',
    'Osama bin Laden + Usama bin Ladin : spelling', 'Osama bin Laden + bin Laden : contains',
  ]);
  assert.equal(suggestDuplicates(ix, undefined, 1).length, 1);
});

test('no suggestions for numbered names, short names, different Wikidata IDs, other families or distinct pairs', () => {
  const p = proj([board('A', {
    nodes: [node('n1', 'Paris', 'Place', { wikidata: 'Q90' }), node('n2', 'Paris', 'Place', { wikidata: 'Q830149' })],
    events: [
      rec('r1', { actors: [actor('Group 1', 'Armed group'), actor('Group 11', 'Armed group'), actor('Brigade 4', 'Armed group'), actor('Brigade 5', 'Armed group')] }),
      rec('r2', { actors: [actor('Hamas', 'Armed group'), actor('Hama', 'Armed group'), actor('Georgie')], countries: ['Georgia'] }),
      rec('r3', { actors: [actor('Usama bin Ladin'), actor('Osama bin Laden')] }),
    ],
  })]);
  const ix = buildEntities(p);
  const usama = ix.byKey.get(nameKey('actor', 'Usama bin Ladin')), osama = ix.byKey.get(nameKey('actor', 'Osama bin Laden'));
  assert.deepEqual(described(ix, suggestDuplicates(ix)), ['Osama bin Laden + Usama bin Ladin : spelling']);
  assert.deepEqual(suggestDuplicates(ix, { merges: [], distinct: [[osama.key, usama.key]] }), []);
});

test('edit distance stops early', () => {
  assert.equal(editDistance('usama bin ladin', 'osama bin laden', 2), 2);
  assert.equal(editDistance('abcdef', 'uvwxyz', 2), 3);
  assert.equal(editDistance('same', 'same', 2), 0);
});

import { emptyDecisions, markDistinct, mergeEntities, unmerge } from '../src/entities.ts';
import { normalizeDecisions } from '../src/model.ts';

const ladens = () => proj([board('A', { events: [
  rec('r1', { actors: [actor('Usama bin Ladin')] }), rec('r2', { actors: [actor('Osama bin Laden')] }), rec('r3', { actors: [actor('bin Laden')] }),
  rec('r4', { countries: ['Iraq'] }),
] })]);

test('merge, overlapping merges, unmerge and remembered keys', () => {
  const p = ladens();
  let ix = buildEntities(p);
  const usama = ix.byKey.get(nameKey('actor', 'Usama bin Ladin')), osama = ix.byKey.get(nameKey('actor', 'Osama bin Laden'));
  const binLaden = ix.byKey.get(nameKey('actor', 'bin Laden')), iraq = ix.byKey.get(nameKey('place', 'Iraq'));
  let d = mergeEntities(emptyDecisions(), usama, osama, 'Osama bin Laden', 'Windows', '2026-10-17T10:00:00.000Z');
  assert.deepEqual(Object.keys(d.merges[0]).sort(), ['at', 'by', 'id', 'keys', 'name']);
  assert.equal(d.merges[0].at, '2026-10-17T10:00:00.000Z');
  ix = buildEntities(p, d);
  const m = ix.byKey.get(osama.key);
  assert.equal(m, ix.byKey.get(usama.key));
  assert.equal(m.name, 'Osama bin Laden');
  assert.equal(m.key, `m:${d.merges[0].id}`);
  assert.equal(m.mergeId, d.merges[0].id);
  assert.equal(m.records.length, 2);
  assert.deepEqual(m.aliases, ['Usama bin Ladin']);
  assert.equal(ix.entities.length, 3);

  const firstKey = m.key;
  d = mergeEntities(d, m, ix.byKey.get(binLaden.key), 'Osama bin Laden', 'iPad');
  assert.equal(d.merges.length, 1, 'overlapping merges are combined');
  ix = buildEntities(p, d);
  assert.equal(ix.byKey.get(firstKey), ix.byKey.get(binLaden.key), 'a remembered key from the earlier merge still resolves');
  assert.equal(ix.byKey.get(binLaden.key).records.length, 3);
  assert.equal(mergeEntities(d, ix.byKey.get(binLaden.key), iraq, 'x', 'Windows'), null, 'an actor and a place cannot be merged');

  ix = buildEntities(p, unmerge(d, d.merges[0].id));
  assert.notEqual(ix.byKey.get(usama.key), ix.byKey.get(osama.key));
  assert.equal(ix.byKey.get(firstKey), undefined);
  assert.equal(ix.entities.length, 4);
});

test('a merge survives a node gaining a Wikidata ID and is inert when one side is gone', () => {
  const make = (qid, withAbou = true) => proj([board('A', {
    nodes: [node('n1', 'Abu Y', 'Actor', qid ? { wikidata: qid } : {})],
    events: [rec('r1', { actors: [actor('Abu Y')] }), rec('r2', { actors: withAbou ? [actor('Abou Y')] : [] })],
  })]);
  const ix0 = buildEntities(make());
  const d = mergeEntities(emptyDecisions(), ix0.byKey.get(nameKey('actor', 'Abu Y')), ix0.byKey.get(nameKey('actor', 'Abou Y')), 'Abu Y', 'Windows');
  const ix1 = buildEntities(make('Q5'), d);
  const e = ix1.byKey.get('wd:Q5');
  assert.equal(e.key, `m:${d.merges[0].id}`);
  assert.equal(e, ix1.byKey.get(nameKey('actor', 'Abou Y')));
  assert.equal(e.records.length, 2);
  const ix2 = buildEntities(make('Q5', false), d);
  assert.equal(ix2.entities.length, 1);
  assert.equal(ix2.entities[0].mergeId, undefined);
  assert.equal(ix2.entities[0].key, 'wd:Q5');
});

test('not the same', () => {
  const p = ladens();
  const ix = buildEntities(p);
  const usama = ix.byKey.get(nameKey('actor', 'Usama bin Ladin')), osama = ix.byKey.get(nameKey('actor', 'Osama bin Laden'));
  assert.equal(suggestDuplicates(ix).length, 2);
  const d = markDistinct(emptyDecisions(), usama, osama);
  assert.deepEqual(d.distinct, [[nameKey('actor', 'Osama bin Laden'), nameKey('actor', 'Usama bin Ladin')]]);
  assert.deepEqual(described(ix, suggestDuplicates(buildEntities(p, d), d)), ['Osama bin Laden + bin Laden : contains']);
  assert.equal(markDistinct(d, osama, usama).distinct.length, 1, 'marking the same pair twice stores it once');
});

test('malformed decisions are dropped and absent decisions stay absent', () => {
  assert.deepEqual(normalizeDecisions({ merges: [{ keys: ['a'] }, null, { id: 'm', keys: ['a', 'b', 7], name: 'X', at: '', by: '' }], distinct: [['a'], ['a', 'b'], 7] }),
    { merges: [{ id: 'm', keys: ['a', 'b'], name: 'X', at: '', by: '' }], distinct: [['a', 'b']] });
  assert.deepEqual(normalizeDecisions('junk'), { merges: [], distinct: [] });
  assert.ok(!('entityDecisions' in normalizeProjects([{ id: 'p', name: 'P', boards: [] }])[0]));
  assert.deepEqual(normalizeProjects([{ id: 'p', name: 'P', boards: [], entityDecisions: { merges: 'x' } }])[0].entityDecisions, { merges: [], distinct: [] });
});

test('not the same on a merged entity outlives the merge', () => {
  const p = ladens();
  let ix = buildEntities(p);
  const usama = ix.byKey.get(nameKey('actor', 'Usama bin Ladin')), osama = ix.byKey.get(nameKey('actor', 'Osama bin Laden'));
  let d = mergeEntities(emptyDecisions(), usama, osama, 'Osama bin Laden', 'Windows');
  ix = buildEntities(p, d);
  d = markDistinct(d, ix.byKey.get(osama.key), ix.byKey.get(nameKey('actor', 'bin Laden')));
  assert.ok(d.distinct.flat().every(k => !k.startsWith('m:')), 'stored with lasting keys, not the merge key');
  d = unmerge(d, d.merges[0].id);
  assert.deepEqual(described(buildEntities(p, d), suggestDuplicates(buildEntities(p, d), d)), ['Osama bin Laden + Usama bin Ladin : spelling']);
});
