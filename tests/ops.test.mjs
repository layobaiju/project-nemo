// Map workspace rules: geometry, drawings, layers, resources and the task workflow. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBoard } from '../src/model.ts';
import { bearing, formatArea, formatDistance, lineKm, lineMidpoint, polygonCenter, polygonKm2 } from '../src/geo.ts';
import { DEFAULT_LAYER, SYMBOLS, addFeature, addLayer, addResource, createTask, deleteFeature, deleteLayer, deleteResource, drawingsGeoJSON, nextStatuses, setTaskStatus, updateFeature, updateResource } from '../src/ops.ts';

const board = () => normalizeBoard({ id: 'b', name: 'Board', kind: 'world' });
const marker = (name = 'Safe house') => ({ kind: 'marker', geometry: { type: 'Point', coordinates: [73.24, 34.17] }, symbol: 'safe', color: '#6ac6b1', name, notes: '' });
const route = { kind: 'route', geometry: { type: 'LineString', coordinates: [[73.24, 34.17], [73.25, 34.18], [73.27, 34.18]] }, symbol: '', color: '#e9b670', name: 'Route A', notes: '' };

test('distances and areas', () => {
  assert.ok(Math.abs(lineKm([[-0.1276, 51.5072], [2.3522, 48.8566]]) - 343.5) < 1, 'London to Paris');
  const d = 1 / 111.195; // about 1 km of latitude or longitude at the equator
  const km2 = polygonKm2([[0, 0], [d, 0], [d, d], [0, d], [0, 0]]);
  assert.ok(Math.abs(km2 - 1) < 0.01, `1 km square measured ${km2}`);
  assert.ok(Math.abs(polygonKm2([[0, 0], [d, 0], [d, d], [0, d]]) - km2) < 1e-9, 'open and closed rings give the same area');
  assert.equal(formatDistance(0.85), '850 m');
  assert.equal(formatDistance(12.43), '12.4 km');
  assert.equal(formatDistance(1234.5), '1,235 km');
  assert.equal(formatArea(0.00124), '1,240 m²');
  assert.equal(formatArea(3.46), '3.5 km²');
  const mid = lineMidpoint([[0, 0], [0, 2]]);
  assert.ok(Math.abs(mid[1] - 1) < 1e-6 && Math.abs(mid[0]) < 1e-9);
  assert.deepEqual(polygonCenter([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]), [1, 1]);
  assert.equal(Math.round(bearing([0, 0], [0, 1])), 0);
  assert.equal(Math.round(bearing([0, 0], [1, 0])), 90);
  assert.equal(SYMBOLS.length, 20);
});

test('older boards get empty map lists, and damaged drawings are dropped', () => {
  const b = board();
  assert.deepEqual([b.mapFeatures, b.mapLayers, b.resources, b.tasks], [[], [], [], []]);
  const damaged = normalizeBoard({ id: 'b', mapFeatures: [{ id: 'x', kind: 'route' }, { id: 'y', kind: 'marker', geometry: { type: 'Point', coordinates: [1, 2] } }, { id: 'z', kind: 'marker', geometry: { type: 'Point', coordinates: [500, 2] } }] });
  assert.deepEqual(damaged.mapFeatures.map(f => f.id), ['y']);
  assert.equal(damaged.mapFeatures[0].color.startsWith('#'), true);
});

test('features: add, update and delete, with a default layer', () => {
  const first = addFeature(board(), marker());
  assert.deepEqual(first.board.mapLayers.map(l => [l.name, l.visible, l.locked]), [[DEFAULT_LAYER, true, false]]);
  const f = first.board.mapFeatures[0];
  assert.equal(f.id, first.id);
  assert.equal(f.layer, first.board.mapLayers[0].id);
  const second = addFeature(first.board, route);
  assert.equal(second.board.mapLayers.length, 1, 'the default layer is reused');
  const renamed = updateFeature(second.board, first.id, { name: 'Safe house 2' });
  assert.equal(renamed.mapFeatures.find(x => x.id === first.id).name, 'Safe house 2');
  assert.notEqual(renamed.mapFeatures.find(x => x.id === first.id).updatedAt, '');
  assert.deepEqual(deleteFeature(renamed, first.id).mapFeatures.map(x => x.name), ['Route A']);
});

test('deleting a layer moves its drawings to Drawings; Drawings itself stays', () => {
  let { board: b } = addFeature(board(), marker());
  const hazards = addLayer(b, 'Hazards');
  b = hazards.board;
  const placed = addFeature(b, { ...route, layer: hazards.id });
  b = deleteLayer(placed.board, hazards.id);
  assert.deepEqual(b.mapLayers.map(l => l.name), [DEFAULT_LAYER]);
  assert.equal(b.mapFeatures.find(f => f.id === placed.id).layer, b.mapLayers[0].id);
  assert.equal(deleteLayer(b, b.mapLayers[0].id), b, 'the default layer cannot be deleted');
});

test('task status follows the workflow', () => {
  let { board: b, id: res } = addResource(board(), { name: 'Team 1', type: 'Team', status: 'Ready' });
  const t = createTask(b, { title: 'Survey the bridge', type: 'Survey', resourceId: res, featureId: '' }, 'iPad');
  b = t.board;
  assert.deepEqual(nextStatuses('Requested'), ['Accepted', 'Cancelled']);
  assert.equal(setTaskStatus(b, t.id, 'Done', 'iPad'), b, 'Requested → Done is refused');
  for (const s of ['Accepted', 'In progress', 'Done']) b = setTaskStatus(b, t.id, s, 'Windows', s === 'Done' ? 'Bridge passable' : '');
  const task = b.tasks[0];
  assert.equal(task.status, 'Done');
  assert.deepEqual(task.log.map(l => [l.status, l.by]), [['Requested', 'iPad'], ['Accepted', 'Windows'], ['In progress', 'Windows'], ['Done', 'Windows']]);
  assert.equal(task.log[3].note, 'Bridge passable');
  assert.ok(task.log.every(l => /^\d{4}-\d\d-\d\dT/.test(l.at)));
  b = setTaskStatus(b, t.id, 'Reopen', 'iPad');
  assert.equal(b.tasks[0].status, 'Requested');
  assert.equal(b.tasks[0].log.at(-1).note, 'Reopened');
  const updated = updateResource(b, res, { status: 'In use' });
  assert.equal(updated.resources[0].status, 'In use');
});

test('deleting a resource clears it from tasks', () => {
  const r = addResource(board(), { name: 'Truck', type: 'Vehicle', status: 'Ready' });
  const t = createTask(r.board, { title: 'Deliver water', type: 'Delivery', resourceId: r.id, featureId: '' }, 'Windows');
  const b = deleteResource(t.board, r.id);
  assert.deepEqual([b.resources.length, b.tasks[0].resourceId], [0, '']);
});

test('deleting a drawing clears it from tasks', () => {
  const f = addFeature(board(), route);
  const t = createTask(f.board, { title: 'Follow route A', type: 'Movement', resourceId: '', featureId: f.id }, 'Windows');
  assert.equal(deleteFeature(t.board, f.id).tasks[0].featureId, '');
});

test('drawings export as GeoJSON with their properties', () => {
  let { board: b } = addFeature(board(), marker());
  b = addFeature(b, route).board;
  const fc = drawingsGeoJSON(b);
  assert.equal(fc.type, 'FeatureCollection');
  assert.deepEqual(fc.features.map(f => [f.geometry.type, f.properties.name, f.properties.layer]), [['Point', 'Safe house', DEFAULT_LAYER], ['LineString', 'Route A', DEFAULT_LAYER]]);
  assert.equal(fc.features[1].properties.length, formatDistance(lineKm(route.geometry.coordinates)));
});
