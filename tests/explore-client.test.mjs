// Explore page conversions: topics and events into records, nodes and folder links. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProjects, recordIssues } from '../src/model.ts';
import { categoryFor, eventToRecord, findDuplicate, newsToLinks, saveLinks, topicToNode, topicToRecord, workspaceMatches } from '../src/explore.ts';
import { emptyBoard } from './fixtures.mjs';

const TOPIC = JSON.parse(readFileSync(new URL('./fixtures/explore/topic-Q1317.json', import.meta.url), 'utf8'));
const EVENTS = JSON.parse(readFileSync(new URL('./fixtures/explore/events-Q1317.json', import.meta.url), 'utf8'));
const board = (id = 'b') => normalizeProjects([{ id: 'p', boards: [emptyBoard(id, 'Board')] }])[0].boards[0];

test('a topic becomes an unverified, sourced record', () => {
  const r = topicToRecord(TOPIC, '2026-10-16');
  assert.equal(r.name, 'Osama bin Laden');
  assert.equal(r.category, 'Actor');
  assert.deepEqual([r.date, r.endDate], ['1957-03-10', '2011-05-02']);
  assert.equal(r.longitude, undefined, 'a person is not placed at a birthplace');
  assert.deepEqual(r.evidence.map(e => e.license), ['CC BY-SA 4.0', 'CC0 / Public domain']);
  assert.equal(r.evidence[0].url, 'https://en.wikipedia.org/wiki/Osama_bin_Laden');
  assert.equal(r.evidence[0].claim, 'Summary as accessed on 2026-10-16');
  assert.equal(r.evidence[1].url, 'https://www.wikidata.org/wiki/Q1317');
  assert.deepEqual([r.verification, r.confidence], ['Unverified', 'Unverified']);
  assert.equal(r.provenance.originalId, 'Q1317');
  assert.equal(r.provenance.origin, 'Explore (Wikidata/Wikipedia)');
  assert.match(r.provenance.createdAt, /^\d{4}-\d\d-\d\dT/, 'saved records keep their creation time');
  assert.match(r.description, /^Life span \(birth–death\)\. Osama bin Laden was the founder/);
  assert.match(r.description, /\n\nWikidata: founder of al-Qaeda/);
  assert.deepEqual(recordIssues(r).filter(i => i.level === 'error'), []);
});

test('an event becomes a mapped record', () => {
  const killing = EVENTS.find(e => e.id === 'Q19085');
  const r = eventToRecord(killing, TOPIC, '2026-10-16');
  assert.equal(r.category, 'Event');
  assert.equal(r.date, '2011-05-02');
  assert.equal(Math.round(r.longitude * 100) / 100, 73.24);
  assert.equal(Math.round(r.latitude * 100) / 100, 34.17);
  assert.ok(r.tags.includes('Osama bin Laden'));
  assert.deepEqual(r.evidence.map(e => [e.publisher, e.license, e.url]), [['Wikidata', 'CC0 / Public domain', 'https://www.wikidata.org/wiki/Q19085']]);
  assert.equal(r.provenance.originalId, 'Q19085');
  assert.equal(eventToRecord(EVENTS[0], TOPIC, '2026-10-16').date, '1991', 'year-only dates stay year-only');
  assert.deepEqual(recordIssues(r).filter(i => i.level === 'error'), []);
});

test('categories follow the spec rules', () => {
  const t = (types, extra = {}) => categoryFor({ ...TOPIC, isHuman: false, types, dates: { start: '', end: '', kind: '' }, ...extra });
  assert.equal(categoryFor(TOPIC), 'Actor');
  assert.equal(t(['terrorist organization']), 'Armed organization');
  assert.equal(t(['military unit']), 'State force');
  assert.equal(t(['armed forces']), 'State force');
  assert.equal(t(['war']), 'Conflict');
  assert.equal(t(['armed conflict']), 'Conflict');
  assert.equal(t(['sovereign state']), 'Country');
  assert.equal(t(['missile']), 'Equipment');
  assert.equal(t([], { dates: { start: '2001-09-11', end: '', kind: 'event' } }), 'Event');
  assert.equal(t([]), 'Actor');
});

test('duplicates are detected per board', () => {
  const a = board('a'), b = board('b');
  a.events.push(topicToRecord(TOPIC, '2026-10-16'));
  assert.ok(findDuplicate(a, 'Q1317'));
  assert.equal(findDuplicate(b, 'Q1317'), undefined);

  const refs = TOPIC.links.references;
  const first = saveLinks(a, TOPIC.label, refs);
  assert.equal(first.added, refs.length);
  const again = saveLinks(first.board, TOPIC.label, [...refs, ...newsToLinks([{ title: 'Story', url: 'https://news.example.com/a', domain: 'news.example.com', date: '2026-05-01', language: 'English', country: '' }])]);
  assert.equal(again.added, 1, 'links already in the folder are skipped');
  const folders = again.board.folders.filter(f => f.name === 'Explore: Osama bin Laden');
  assert.equal(folders.length, 1);
  assert.equal(folders[0].items.length, refs.length + 1);
  assert.deepEqual(Object.keys(folders[0].items[0]).sort(), ['body', 'createdAt', 'id', 'kind', 'name', 'nodeIds', 'recordIds', 'url']);
  assert.equal(folders[0].items.at(-1).body, 'news.example.com, 2026-05-01, English');
});

test('workspace matches cover records, nodes and folder items in every project', () => {
  const projects = normalizeProjects([
    { id: 'P1', name: 'Field Notes', boards: [emptyBoard('b1', 'World overview', [{ id: 'e1', name: 'Abbottabad raid', place: 'Pakistan', tags: ['bin Laden'] }])] },
    { id: 'P2', name: 'Military', boards: [{ ...emptyBoard('b2', 'Global research map'), nodes: [{ id: 'n1', type: 'research', position: { x: 0, y: 0 }, data: { label: 'osama binladen', kind: 'Source' } }], folders: [{ id: 'f', name: 'Sources', items: [{ id: 'i1', name: 'FBI page', url: 'https://www.fbi.gov/wanted/topten/usama-bin-laden', body: 'Osama bin Laden wanted poster' }] }] }] },
  ]);
  const found = workspaceMatches(projects, 'Osama bin Laden');
  assert.deepEqual(found.map(m => [m.kind, m.projectId, m.boardId, m.id]), [['node', 'P2', 'b2', 'n1'], ['item', 'P2', 'b2', 'i1']]);
  assert.equal(found[0].where, 'Military › Global research map › graph');
  assert.deepEqual(workspaceMatches(projects, 'bin laden').map(m => m.id), ['e1', 'n1', 'i1']);
  assert.deepEqual(workspaceMatches(projects, '  '), []);
});

test('a topic becomes a graph node', () => {
  const n = topicToNode(TOPIC, 'n9', 100, 200);
  assert.deepEqual(n.position, { x: 100, y: 200 });
  assert.equal(n.data.kind, 'Actor');
  assert.equal(n.data.label, 'Osama bin Laden');
  assert.equal(n.data.wikidata, 'Q1317');
  assert.equal(n.data.url, 'https://en.wikipedia.org/wiki/Osama_bin_Laden');
});

test('only web links are saved to folders', () => {
  const { added, board: b } = saveLinks(board(), 'X', [{ url: 'javascript:alert(1)', label: 'bad', note: '' }, { url: 'data:text/html,hi', label: 'bad', note: '' }, { url: 'https://ok.example/', label: 'ok', note: '' }]);
  assert.equal(added, 1);
  assert.deepEqual(b.folders.find(f => f.name === 'Explore: X').items.map(i => i.url), ['https://ok.example/']);
});
