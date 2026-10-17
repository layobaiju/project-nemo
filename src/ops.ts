// Map workspace rules: drawings, layers, resources and the task log. Pure functions over a board.
import type { Board, MapFeature, MapLayer, OpsTask, Resource } from './types.ts';
import { nowIso, uid } from './model.ts';
import { formatArea, formatDistance, lineKm, polygonKm2 } from './geo.ts';

export const SYMBOLS: { id: string; label: string }[] = [
  { id: 'safe', label: 'Safe location' }, { id: 'embassy', label: 'Embassy / consulate' }, { id: 'hospital', label: 'Hospital' },
  { id: 'school', label: 'School' }, { id: 'worship', label: 'Place of worship' }, { id: 'shelter', label: 'Shelter / camp' },
  { id: 'checkpoint', label: 'Checkpoint' }, { id: 'roadblock', label: 'Roadblock' }, { id: 'hazard', label: 'Hazard' },
  { id: 'fire', label: 'Fire' }, { id: 'flood', label: 'Flood' }, { id: 'damage', label: 'Damage' },
  { id: 'team', label: 'Team' }, { id: 'vehicle', label: 'Vehicle' }, { id: 'aircraft', label: 'Aircraft' },
  { id: 'landing', label: 'Landing site' }, { id: 'meeting', label: 'Meeting point' }, { id: 'observation', label: 'Observation' },
  { id: 'note', label: 'Note' }, { id: 'flag', label: 'Flag' },
];
export const COLORS = ['#e5656f', '#ff8c42', '#e9b670', '#5fc98a', '#58c4dd', '#729cf5', '#b18cff', '#f4f7fb'];
export const RESOURCE_TYPES = ['Team', 'Vehicle', 'Aircraft', 'Boat', 'Equipment', 'Other'];
export const RESOURCE_STATUS: Record<string, string> = { Ready: '#5fc98a', 'In use': '#729cf5', 'Needs attention': '#e9b670', Offline: '#7f8ca0' };
export const TASK_STATUS = ['Requested', 'Accepted', 'In progress', 'Done', 'Cancelled'];
export const TASK_TYPES = ['Survey', 'Delivery', 'Movement', 'Inspection', 'Meeting', 'Evacuation', 'Other'];
export const DEFAULT_LAYER = 'Drawings';

const TRANSITIONS: Record<string, string[]> = {
  Requested: ['Accepted', 'Cancelled'], Accepted: ['In progress', 'Cancelled'], 'In progress': ['Done', 'Cancelled'], Done: ['Reopen'], Cancelled: ['Reopen'],
};
/** The statuses a task can move to next. "Reopen" sends a finished or cancelled task back to Requested. */
export const nextStatuses = (status: string) => TRANSITIONS[status] || [];

const featuresOf = (b: Board) => b.mapFeatures || [];
const layersOf = (b: Board) => b.mapLayers || [];
const resourcesOf = (b: Board) => b.resources || [];
const tasksOf = (b: Board) => b.tasks || [];

/** The "Drawings" layer, created on first use. */
function withDefaultLayer(b: Board): { board: Board; id: string } {
  const found = layersOf(b).find(l => l.name === DEFAULT_LAYER);
  if (found) return { board: b, id: found.id };
  const layer: MapLayer = { id: uid(), name: DEFAULT_LAYER, visible: true, locked: false };
  return { board: { ...b, mapLayers: [...layersOf(b), layer] }, id: layer.id };
}

// ---------- drawings ----------
export type NewFeature = Omit<MapFeature, 'id' | 'createdAt' | 'updatedAt' | 'layer'> & { id?: string; layer?: string };
export function addFeature(b: Board, f: NewFeature): { board: Board; id: string } {
  let board = b, layer = f.layer && layersOf(b).some(l => l.id === f.layer) ? f.layer : '';
  if (!layer) ({ board, id: layer } = withDefaultLayer(b));
  const t = nowIso(), feature: MapFeature = { ...f, id: f.id || uid(), layer, createdAt: t, updatedAt: t };
  return { board: { ...board, mapFeatures: [...featuresOf(board), feature] }, id: feature.id };
}
export const updateFeature = (b: Board, id: string, patch: Partial<MapFeature>): Board =>
  ({ ...b, mapFeatures: featuresOf(b).map(f => (f.id === id ? { ...f, ...patch, id, updatedAt: nowIso() } : f)) });
/** Deletes a drawing; tasks that pointed to it keep their history but lose the link. */
export const deleteFeature = (b: Board, id: string): Board => ({
  ...b, mapFeatures: featuresOf(b).filter(f => f.id !== id),
  tasks: tasksOf(b).map(t => (t.featureId === id ? { ...t, featureId: '' } : t)),
});

// ---------- layers ----------
export function addLayer(b: Board, name: string): { board: Board; id: string } {
  const layer: MapLayer = { id: uid(), name: name.trim() || 'Layer', visible: true, locked: false };
  return { board: { ...b, mapLayers: [...layersOf(b), layer] }, id: layer.id };
}
export const updateLayer = (b: Board, id: string, patch: Partial<MapLayer>): Board => ({ ...b, mapLayers: layersOf(b).map(l => (l.id === id ? { ...l, ...patch, id } : l)) });
/** Deletes a layer and moves its drawings to "Drawings". "Drawings" itself cannot be deleted. */
export function deleteLayer(b: Board, id: string): Board {
  const layer = layersOf(b).find(l => l.id === id);
  if (!layer || layer.name === DEFAULT_LAYER) return b;
  const { board, id: fallback } = withDefaultLayer(b);
  return { ...board, mapLayers: layersOf(board).filter(l => l.id !== id), mapFeatures: featuresOf(board).map(f => (f.layer === id ? { ...f, layer: fallback, updatedAt: nowIso() } : f)) };
}

// ---------- resources ----------
export function addResource(b: Board, r: Partial<Resource> & { name: string }): { board: Board; id: string } {
  const resource: Resource = { type: 'Other', status: 'Ready', position: null, notes: '', ...r, id: r.id || uid(), updatedAt: nowIso() };
  return { board: { ...b, resources: [...resourcesOf(b), resource] }, id: resource.id };
}
export const updateResource = (b: Board, id: string, patch: Partial<Resource>): Board =>
  ({ ...b, resources: resourcesOf(b).map(r => (r.id === id ? { ...r, ...patch, id, updatedAt: nowIso() } : r)) });
export const deleteResource = (b: Board, id: string): Board => ({
  ...b, resources: resourcesOf(b).filter(r => r.id !== id),
  tasks: tasksOf(b).map(t => (t.resourceId === id ? { ...t, resourceId: '' } : t)),
});

// ---------- tasks ----------
export function createTask(b: Board, t: { id?: string; title: string; type: string; resourceId: string; featureId: string; note?: string }, by: string): { board: Board; id: string } {
  const at = nowIso();
  const task: OpsTask = { id: t.id || uid(), title: t.title.trim() || 'Task', type: t.type, resourceId: t.resourceId, featureId: t.featureId, status: 'Requested', log: [{ at, status: 'Requested', note: t.note || '', by }], createdAt: at, updatedAt: at };
  return { board: { ...b, tasks: [...tasksOf(b), task] }, id: task.id };
}
/** Moves a task along the workflow and logs who did it and when. A move the workflow does not allow changes nothing. */
export function setTaskStatus(b: Board, id: string, status: string, by: string, note = ''): Board {
  const task = tasksOf(b).find(t => t.id === id);
  if (!task || !nextStatuses(task.status).includes(status)) return b;
  const next = status === 'Reopen' ? 'Requested' : status, at = nowIso();
  return { ...b, tasks: tasksOf(b).map(t => (t.id === id ? { ...t, status: next, updatedAt: at, log: [...t.log, { at, status: next, note: note || (status === 'Reopen' ? 'Reopened' : ''), by }] } : t)) };
}
export const deleteTask = (b: Board, id: string): Board => ({ ...b, tasks: tasksOf(b).filter(t => t.id !== id) });

// ---------- measuring and export ----------
/** Length of a route or size of an area, ready to display; empty for points. */
export function measureOf(f: Pick<MapFeature, 'geometry'>): string {
  if (f.geometry.type === 'LineString') return formatDistance(lineKm(f.geometry.coordinates));
  if (f.geometry.type === 'Polygon') return formatArea(polygonKm2(f.geometry.coordinates[0]));
  return '';
}
export function drawingsGeoJSON(b: Board) {
  const names = new Map(layersOf(b).map(l => [l.id, l.name]));
  return {
    type: 'FeatureCollection' as const,
    features: featuresOf(b).map(f => ({
      type: 'Feature' as const, id: f.id, geometry: f.geometry,
      properties: { id: f.id, kind: f.kind, shape: f.shape || null, symbol: f.symbol, color: f.color, name: f.name, notes: f.notes, layer: names.get(f.layer) || '', ...(f.kind === 'route' ? { length: measureOf(f) } : f.kind === 'area' ? { area: measureOf(f) } : {}) },
    })),
  };
}
