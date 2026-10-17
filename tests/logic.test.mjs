// Run with: npm.cmd test   (Node 22.18+ / 24 strips TypeScript types natively)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectSource, autoMapping, detectPreset, rowsFromSource, buildCandidates, ucdpRow, UCDP_DATASET } from '../src/importer.ts';
import { normalizeProjects, parseDateInput, dateSpan, recordIssues, newEvent, emptyEvidence, emptyFigure, visibleByLayers, isPlaceholder, matchesQuery } from '../src/model.ts';
import { nodeSearchText } from '../src/graph.ts';
import { compareRecords, findSimilar, gapDays } from '../src/similarity.ts';
import { boardCSV, csvCell } from '../src/exporters.ts';

test('CSV parser handles quotes, escaped quotes, CRLF, embedded newlines and BOM', () => {
  const rows = [];
  parseCSV('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line1\nline2",\r\n', r => { rows.push(r); });
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"'], ['2', 'line1\nline2', '']]);
});

test('semicolon-delimited CSV is detected', () => {
  const d = detectSource('x.csv', 'title;date;latitude;longitude\nA;2020-01-01;10;20\n');
  assert.equal(d.kind, 'csv');
  assert.equal(d.delimiter, ';');
  assert.deepEqual(d.headers, ['title', 'date', 'latitude', 'longitude']);
});

test('dates: partial dates allowed, ambiguous rejected, spans cover whole period', () => {
  assert.deepEqual(parseDateInput('1995'), { ok: true, value: '1995' });
  assert.deepEqual(parseDateInput('1995/7/11'), { ok: true, value: '1995-07-11' });
  assert.equal(parseDateInput('2014-07-17T10:00:00Z').value, '2014-07-17');
  assert.equal(parseDateInput('03/04/2010').ok, false);
  assert.equal(parseDateInput('2010-02-30').ok, false);
  const [a, b] = dateSpan('2001');
  assert.equal(new Date(a).toISOString().slice(0, 10), '2001-01-01');
  assert.equal(new Date(b).toISOString().slice(0, 10), '2001-12-31');
});

test('legacy records migrate without losing fields', () => {
  const [p] = normalizeProjects([{ id: 'p', name: 'P', boards: [{ id: 'b', name: 'B', kind: 'world', nodes: [], edges: [], events: [
    { id: 'ev1', name: 'Old', place: 'Somewhere', date: '', confidence: 'Unverified', category: 'Event', x: 51, y: 42, sources: ['https://example.org/a', 'Archive box 4'] },
  ], folders: [{ id: 'f', name: 'F', items: [{ id: 'i', name: 'N', nodeId: 'n1' }] }] }] }]);
  const e = p.boards[0].events[0];
  assert.equal(e.x, 51); assert.equal(e.y, 42); assert.equal(e.place, 'Somewhere');
  assert.equal(e.evidence.length, 2);
  assert.equal(e.evidence[0].url, 'https://example.org/a');
  assert.equal(e.evidence[1].title, 'Archive box 4');
  assert.deepEqual(e.sources, ['https://example.org/a', 'Archive box 4']);
  assert.deepEqual(p.boards[0].folders[0].items[0].nodeIds, ['n1']);
  assert.equal(e.longitude, undefined);
  assert.ok(isPlaceholder(normalizeProjects([{ id: 'q', boards: [{ events: [{ name: 'New event marker', sources: [] }] }] }])[0].boards[0].events[0]));
});

test('record issues flag unsourced figures and confirmed attribution', () => {
  const e = newEvent({ name: 'Test', verification: 'Verified' });
  e.casualties = [{ ...emptyFigure(), low: 10, best: 5, high: 20 }];
  e.actors = [{ id: 'a1', name: 'Org', type: 'Armed group', role: 'Party to event', attribution: 'Confirmed', note: '' }];
  const texts = recordIssues(e).map(i => i.text).join('\n');
  assert.match(texts, /low is greater than best/);
  assert.match(texts, /no source supports this figure/);
  assert.match(texts, /marked Confirmed but no source/);
  assert.match(texts, /fewer than two sources/);
});

test('similarity is explainable and missing data never raises the score', () => {
  const a = newEvent({ name: 'Shelling of market', category: 'Incident', date: '2015-03-01', longitude: 30, latitude: 50, countries: ['Ukraine'] });
  const b = newEvent({ name: 'Shelling near market', category: 'Incident', date: '2015-03-03', longitude: 30.05, latitude: 50.02, countries: ['Ukraine'] });
  const c = newEvent({ name: 'Unrelated', category: 'Incident' });
  const ab = compareRecords(a, b), ac = compareRecords(a, c);
  assert.ok(ab.score > 50, `expected high score, got ${ab.score}`);
  assert.ok(ac.score <= 10, `missing data should not raise score, got ${ac.score}`);
  assert.ok(ab.reasons.some(r => r.startsWith('Time proximity: 2 days apart')), ab.reasons.join('|'));
  assert.equal(gapDays(newEvent({ date: '2001-03-04' }), newEvent({ date: '2001-03-05' })), 1, 'consecutive days are 1 day apart');
  assert.ok(ab.reasons.some(r => r.startsWith('Location distance')));
  assert.equal(gapDays(a, newEvent({ date: '2015' })), 0, 'year-only date overlaps');
  assert.equal(findSimilar(a, [a, b, c], undefined, 40).length, 1);
});

test('layers use any-match semantics', () => {
  const e = newEvent({ name: 'x', category: 'Event' });
  e.actors = [{ id: 'a', name: 'G', type: 'Armed group', role: '', attribution: 'Alleged', note: '' }];
  assert.ok(visibleByLayers(e, ['Armed groups']));
  assert.ok(visibleByLayers(e, ['Events']));
  assert.ok(!visibleByLayers(e, ['State forces', 'Countries']));
  assert.ok(!visibleByLayers(newEvent({ category: 'Country' }), ['Countries']), 'Countries only controls the basemap');
});

const ctx = (over = {}) => ({ dataset: { ...UCDP_DATASET, version: '26.1', accessedDate: '2026-10-15' }, supports: ['title', 'date', 'location', 'actors', 'casualties'], batchId: 'b1', preset: 'atlas', ownResearch: false, ...over });

test('generic import validates rows and detects duplicates within the file and project', () => {
  const csv = 'title,date,latitude,longitude,source_titles,source_urls,casualties_best\n' +
    'Flood response,2020-05-01,10,20,Report A | Report B,https://a.example | https://b.example,3\n' +
    'Flood response,2020-05-01,10,20,Report A,https://a.example,\n' +
    ',2020-05-02,95,20,,,\n' +
    'Bad date,05/06/2020,,,,,abc\n';
  const d = detectSource('t.csv', csv);
  const mapping = autoMapping(d.headers);
  assert.equal(detectPreset(d.headers), 'atlas');
  assert.equal(detectPreset(['event', 'when', 'lat', 'lon']), 'generic');
  const { rows } = rowsFromSource(d, { from: '', to: '', contains: '' }, mapping, 'generic');
  const c = buildCandidates(rows, 'generic', mapping, ctx({ ownResearch: true }), []);
  assert.equal(c.length, 4);
  assert.equal(c[0].include, true);
  assert.equal(c[0].record.evidence.length, 2);
  assert.equal(c[0].record.evidence[1].url, 'https://b.example');
  assert.equal(c[1].duplicate?.kind, 'same-title-date');
  assert.equal(c[1].include, false);
  assert.ok(c[2].issues.some(i => /Missing title/.test(i.text)));
  assert.ok(c[2].issues.some(i => /out of range/.test(i.text)));
  assert.ok(c[3].issues.some(i => /Ambiguous date/.test(i.text)));
  assert.ok(c[3].issues.some(i => /not a number/.test(i.text)));
});

test('UCDP GED rows keep coded values, ranges and provenance', () => {
  const row = { id: '12345', type_of_violence: '3', conflict_name: 'X: Civilians', dyad_name: 'X - Civilians', side_a: 'Government of X', side_b: 'Civilians', gwnoa: '999', gwnob: '',
    date_start: '2001-02-03 00:00:00.000', date_end: '2001-02-04 00:00:00.000', date_prec: '2', where_prec: '2', where_coordinates: 'Town', adm_1: 'Prov', adm_2: '', country: 'Xland',
    latitude: '1.5', longitude: '2.5', low: '3', best: '4', high: '9', deaths_a: '0', deaths_b: '0', deaths_civilians: '4', deaths_unknown: '0', source_headline: 'Wire report', source_office: 'Agency', source_date: '2001-02-05', source_article: 'Agency 2001-02-05', event_clarity: '1', code_status: 'Clear' };
  assert.equal(detectPreset(Object.keys(row)), 'ucdp-ged');
  const { record, issues } = ucdpRow(row, ctx({ preset: 'ucdp-ged' }));
  assert.equal(issues.filter(i => i.level === 'error').length, 0);
  assert.equal(record.classification, 'One-sided violence');
  assert.equal(record.date, '2001-02-03'); assert.equal(record.endDate, '2001-02-04');
  assert.equal(record.locationPrecision, 'Within ~25 km');
  assert.equal(record.actors[0].attribution, 'Coded by dataset');
  assert.equal(record.actors[0].type, 'State force');
  assert.equal(record.actors[1].role, 'Affected party');
  assert.deepEqual([record.casualties[0].low, record.casualties[0].best, record.casualties[0].high], [3, 4, 9]);
  assert.equal(record.casualties[0].status, 'Estimate');
  assert.equal(record.provenance.originalId, '12345');
  assert.equal(record.evidence[0].license, 'CC BY 4.0');
  assert.ok(record.evidence[0].supports.includes(`casualty:${record.casualties[0].id}`));
  assert.equal(recordIssues(record).filter(i => i.level === 'error').length, 0);
});

test('CSV export neutralises formulas and re-imports', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-12.5'), '-12.5');
  const e = newEvent({ name: '=cmd', date: '1999-01-01', longitude: -3.2, latitude: 55.9 });
  e.evidence = [{ ...emptyEvidence(), title: 'Src', url: 'https://s.example', claim: 'Date', supports: ['date'] }];
  const csv = boardCSV({ id: 'b', name: 'B', kind: 'world', nodes: [], edges: [], events: [e], folders: [], links: [], imports: [] });
  const d = detectSource('b.csv', csv.replace(/^﻿/, ''));
  assert.equal(detectPreset(d.headers), 'atlas');
  const mapping = autoMapping(d.headers);
  const { rows } = rowsFromSource(d, { from: '', to: '', contains: '' }, mapping, 'atlas');
  const [c] = buildCandidates(rows, 'atlas', mapping, ctx({ ownResearch: true }), []);
  assert.equal(c.record.name, '=cmd');
  assert.equal(c.record.longitude, -3.2);
  assert.equal(c.record.evidence[0].url, 'https://s.example');
});

test('search ignores case, accents, extra spaces, word order and spacing inside names', () => {
  const node = { id: 'n', position: { x: 0, y: 0 }, data: { label: 'osama binladen', kind: 'Source', detail: 'terrorist' } };
  for (const q of ['osama binladen', 'osama binladen ', '  Osama  ', 'OSAMA BIN LADEN', 'bin laden', 'binladen osama', 'terrorist', 'source', ''])
    assert.ok(matchesQuery(nodeSearchText(node), q), `"${q}" should find the node`);
  for (const q of ['Usāma bin Lādin', 'binladin', 'osama x']) assert.ok(!matchesQuery(nodeSearchText(node), q), `"${q}" should not match`);
  assert.ok(matchesQuery('Osama bin Laden', 'binladen'));
  assert.ok(matchesQuery('Usāma bin Lādin', 'usama bin ladin'));
  assert.ok(matchesQuery('Shelling — Kyiv, Ukraine', 'ukraine kyiv'));
});
