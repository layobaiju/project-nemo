import type { Edge, Node } from '@xyflow/react';

/** A source attached to a record. `supports` names the exact fields/items it is evidence for. */
export type Evidence = {
  id: string;
  title: string;
  publisher: string;
  url: string;
  publishedDate: string;
  accessedDate: string;
  sourceType: string;
  reliability: string;
  /** Supports | Contradicts | Context only */
  stance: string;
  /** The specific claim this source makes about the record. */
  claim: string;
  /** Field keys ('title','date','location',…) or item refs ('actor:<id>','casualty:<id>','equipment:<id>'). */
  supports: string[];
  license: string;
  notes: string;
};

export type ActorRef = { id: string; name: string; type: string; role: string; attribution: string; note: string };

/** A casualty figure is always a reported/estimated range with an explicit definition, never a bare number. */
export type CasualtyFigure = {
  id: string; metric: string; population: string;
  low: number | null; best: number | null; high: number | null;
  status: string; definition: string;
};

export type EquipmentRef = { id: string; name: string; type: string; status: string; note: string };

export type Provenance = {
  origin: string; createdAt: string; updatedAt: string;
  importBatchId?: string; dataset?: string; datasetLicense?: string; datasetUrl?: string;
  originalId?: string; possibleDuplicateOf?: string;
};

export type EventItem = {
  id: string; name: string; category: string; place: string;
  date: string; endDate: string; datePrecision: string;
  /** Legacy flat-map position (percent). Kept so older records are never lost. */
  x: number; y: number;
  longitude?: number; latitude?: number; locationPrecision: string;
  countries: string[]; description: string; classification: string; conflictName: string;
  actors: ActorRef[]; casualties: CasualtyFigure[]; equipment: EquipmentRef[];
  evidence: Evidence[];
  /** Legacy summary of evidence (title or URL), kept for older exports. */
  sources: string[];
  confidence: string; verification: string; attributionNote: string; analystNotes: string; tags: string[];
  nodeId?: string;
  provenance: Provenance;
};

export type FolderItem = {
  id: string; name: string; kind?: string; body?: string; url?: string; imageData?: string;
  /** Legacy single link. */
  nodeId?: string;
  nodeIds?: string[]; recordIds?: string[]; createdAt?: string;
};
export type Folder = { id: string; name: string; items: FolderItem[] };

/** Analyst-created comparison between two records. Never implies coordination, responsibility or causation. */
export type RecordLink = { id: string; a: string; b: string; kind: 'comparison'; score: number; reasons: string[]; note: string; createdAt: string };

export type DatasetMeta = { name: string; publisher: string; url: string; license: string; citation: string; accessedDate: string; version: string; notes: string };

export type ImportBatch = {
  id: string; importedAt: string; fileName: string; fingerprint: string; format: string; preset: string;
  dataset: DatasetMeta; rowsRead: number; imported: number; skipped: number; flaggedDuplicates: number;
  /** Set when the user removed this batch's records; the log entry is kept for transparency. */
  removedAt?: string;
};

/** A drawing on the Map workspace. Geometry is GeoJSON with [longitude, latitude] positions. */
export type MapGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'Polygon'; coordinates: [number, number][][] };
export type MapFeature = {
  id: string; kind: 'marker' | 'route' | 'area' | 'label'; geometry: MapGeometry;
  /** How an area was drawn, so it can be reshaped the same way. */
  shape?: 'polygon' | 'rectangle' | 'circle';
  symbol: string; color: string; name: string; notes: string; layer: string; createdAt: string; updatedAt: string;
};
export type MapLayer = { id: string; name: string; visible: boolean; locked: boolean };
export type Resource = { id: string; name: string; type: string; status: string; position: [number, number] | null; notes: string; updatedAt: string };
export type TaskLogEntry = { at: string; status: string; note: string; by: string };
export type OpsTask = { id: string; title: string; type: string; resourceId: string; featureId: string; status: string; log: TaskLogEntry[]; createdAt: string; updatedAt: string };

export type Board = {
  id: string; name: string; kind: string; updatedAt?: string;
  nodes: Node[]; edges: Edge[]; events: EventItem[]; folders: Folder[];
  links: RecordLink[]; imports: ImportBatch[];
  /** Map workspace; filled with empty lists when an older board is loaded. */
  mapFeatures?: MapFeature[]; mapLayers?: MapLayer[]; resources?: Resource[]; tasks?: OpsTask[];
};

/** The user's own entity decisions (Investigate page). Records and nodes are never changed by them. */
export type MergeDecision = { id: string; keys: string[]; name: string; at: string; by: string };
export type EntityDecisions = { merges: MergeDecision[]; distinct: [string, string][] };

export type Project = {
  id: string; name: string; description: string; createdAt?: string; boards: Board[];
  /** Saved with the project's settings; absent until the first decision. */
  entityDecisions?: EntityDecisions;
};
