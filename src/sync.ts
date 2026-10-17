// Per-board saving and sync with the Windows host. Pure functions, so the save and conflict rules can be unit-tested.
import type { Board, Project } from './types.ts';
import { normalizeBoard, normalizeProjects } from './model.ts';

export type ProjectMeta = Omit<Project, 'boards'>;
/** What the host holds right now: a revision per project's settings and per board, in the host's order. */
export type Manifest = { revision: string; projects: { id: string; revision: string; meta: Record<string, unknown>; boards: { id: string; revision: string }[] }[] };

export type SavedBoard = { pid: string; bid: string; board: Board; revision: string };
/**
 * What this device last loaded from or saved to the host. Boards are compared by object identity: React state
 * is immutable, so a board nobody touched keeps its object and is never serialised or sent again.
 */
export type Baseline = { boards: Map<string, SavedBoard>; projects: Map<string, { json: string; revision: string }> };

export const NEW = 'new';
export const boardKey = (pid: string, bid: string) => JSON.stringify([pid, bid]);
export const projectKey = (pid: string) => JSON.stringify([pid]);
export function projectMeta(p: Project): ProjectMeta {
  const { boards: _boards, ...meta } = p;
  return meta;
}
const metaJson = (p: Project) => JSON.stringify(projectMeta(p));

export function baselineFrom(projects: Project[], manifest: Manifest): Baseline {
  const base: Baseline = { boards: new Map(), projects: new Map() };
  for (const p of projects) {
    const rp = manifest.projects.find(x => x.id === p.id);
    if (!rp) continue;
    base.projects.set(p.id, { json: metaJson(p), revision: rp.revision });
    for (const b of p.boards) {
      const rb = rp.boards.find(x => x.id === b.id);
      if (rb) base.boards.set(boardKey(p.id, b.id), { pid: p.id, bid: b.id, board: b, revision: rb.revision });
    }
  }
  return base;
}

export type SaveOp =
  | { kind: 'project'; key: string; pid: string; name: string; meta: ProjectMeta; json: string; baseRevision: string }
  | { kind: 'board'; key: string; pid: string; bid: string; name: string; board: Board; baseRevision: string }
  | { kind: 'delete'; key: string; pid: string; bid: string; name: string; baseRevision: string }
  | { kind: 'delete-project'; key: string; pid: string; name: string; baseRevision: string; boardRevisions: Record<string, string> };

/**
 * Everything that differs from the baseline: project settings first (so a new project exists before its boards),
 * then changed or new boards, then deleted boards, then deleted projects (one request each, carrying the revision of
 * every board this device saw). Keys in `blocked` (unresolved conflicts) are left alone.
 */
export function planSave(projects: Project[], base: Baseline, blocked: ReadonlySet<string> = new Set()): SaveOp[] {
  const metas: SaveOp[] = [], boards: SaveOp[] = [], deletes: SaveOp[] = [];
  for (const p of projects) {
    const pk = projectKey(p.id), saved = base.projects.get(p.id);
    if (!saved && blocked.has(pk)) continue; // creating this project failed, so its boards must wait
    const json = metaJson(p);
    if (!blocked.has(pk) && saved?.json !== json) metas.push({ kind: 'project', key: pk, pid: p.id, name: p.name, meta: projectMeta(p), json, baseRevision: saved?.revision ?? NEW });
    const present = new Set<string>();
    for (const b of p.boards) {
      const key = boardKey(p.id, b.id), sb = base.boards.get(key);
      present.add(b.id);
      if (sb?.board === b || blocked.has(key)) continue;
      boards.push({ kind: 'board', key, pid: p.id, bid: b.id, name: b.name, board: b, baseRevision: sb?.revision ?? NEW });
    }
    for (const sb of base.boards.values()) {
      const key = boardKey(sb.pid, sb.bid);
      if (sb.pid === p.id && !present.has(sb.bid) && !blocked.has(key)) deletes.push({ kind: 'delete', key, pid: sb.pid, bid: sb.bid, name: sb.board.name, baseRevision: sb.revision });
    }
  }
  const here = new Set(projects.map(p => p.id));
  for (const [pid, saved] of base.projects) {
    const key = projectKey(pid);
    if (here.has(pid) || blocked.has(key)) continue;
    const boardRevisions = Object.fromEntries([...base.boards.values()].filter(b => b.pid === pid).map(b => [b.bid, b.revision]));
    deletes.push({ kind: 'delete-project', key, pid, name: String(JSON.parse(saved.json).name || 'Untitled project'), baseRevision: saved.revision, boardRevisions });
  }
  return [...metas, ...boards, ...deletes];
}

/** Forgets everything the host was known to hold for a project (it was deleted, or will be created again). */
export function forgetProject(base: Baseline, pid: string) {
  base.projects.delete(pid);
  for (const [key, b] of base.boards) if (b.pid === pid) base.boards.delete(key);
}

/** Records a successful save, so the same object is not sent again. */
export function applySaved(base: Baseline, op: SaveOp, revision: string) {
  if (op.kind === 'project') base.projects.set(op.pid, { json: op.json, revision });
  else if (op.kind === 'board') base.boards.set(op.key, { pid: op.pid, bid: op.bid, board: op.board, revision });
  else if (op.kind === 'delete-project') forgetProject(base, op.pid);
  else base.boards.delete(op.key);
}

// ---------- conflicts ----------
export type ConflictReason = 'changed' | 'deleted' | 'exists' | 'deleted-here' | 'last-board' | 'project-missing' | 'protected';
export type Conflict = { key: string; kind: 'board' | 'project'; pid: string; bid?: string; name: string; reason: ConflictReason };

/** Turns a host refusal (HTTP 409) into a conflict that names the board or project it is about. */
export function conflictFor(op: SaveOp, reason: ConflictReason): Conflict {
  if (op.kind === 'delete-project') return { key: op.key, kind: 'project', pid: op.pid, name: op.name, reason: reason === 'changed' ? 'deleted-here' : reason };
  if (op.kind === 'project') return { key: op.key, kind: 'project', pid: op.pid, name: op.name, reason: reason === 'deleted' ? 'project-missing' : reason };
  return { key: op.key, kind: 'board', pid: op.pid, bid: op.bid, name: op.name, reason: op.kind === 'delete' && reason === 'changed' ? 'deleted-here' : reason };
}
export const mergeConflicts = (list: Conflict[], add: Conflict[]) => {
  const keys = new Set(add.map(c => c.key));
  return [...list.filter(c => !keys.has(c.key)), ...add];
};

export function conflictMessage(c: Conflict): string {
  const n = `“${c.name || 'Untitled'}”`;
  if (c.kind === 'project') {
    if (c.reason === 'project-missing') return `Project ${n} no longer exists on the host.`;
    if (c.reason === 'exists') return `A different project with the same ID as ${n} already exists on the host.`;
    if (c.reason === 'deleted') return `Project ${n} was deleted on another device. Your edits to it here are not saved yet.`;
    if (c.reason === 'deleted-here') return `Project ${n} was deleted on this device, but another device changed it in the meantime.`;
    if (c.reason === 'protected') return `Project ${n} is Atlas’s default workspace and cannot be deleted.`;
    return `The name or description of project ${n} was changed on another device. Your edits to them here are not saved yet.`;
  }
  switch (c.reason) {
    case 'deleted': return `Board ${n} was deleted on another device. Your edits to it here are not saved yet.`;
    case 'deleted-here': return `Board ${n} was deleted on this device, but another device changed it in the meantime.`;
    case 'exists': return `A different board with the same ID as ${n} already exists on the host.`;
    case 'last-board': return `Board ${n} was not deleted: it is the last board of its project on the host.`;
    case 'project-missing': return `The project that holds board ${n} no longer exists on the host.`;
    default: return `Board ${n} was changed on another device. Your recent edits to it here are not saved yet.`;
  }
}
/** Which resolution buttons make sense for a conflict; `keep` is null when forcing would not help. */
export function conflictActions(c: Conflict): { download: boolean; load: string; keep: string | null } {
  const keep = 'Keep this device’s version';
  switch (c.reason) {
    case 'deleted': return { download: true, load: 'Accept the deletion', keep };
    case 'deleted-here': return { download: false, load: 'Restore the host’s version', keep: 'Delete it anyway' };
    case 'last-board': case 'protected': return { download: false, load: 'Restore it here', keep: null };
    case 'project-missing': return { download: true, load: 'Reload the workspace', keep: null };
    case 'exists': return { download: true, load: c.kind === 'board' ? 'Load latest from host' : 'Reload the workspace', keep: c.kind === 'board' ? keep : null };
    default: return { download: true, load: 'Load latest from host', keep };
  }
}

// ---------- changes saved by other devices ----------
export type RemotePlan = {
  fetch: { pid: string; bid: string }[];
  remove: { pid: string; bid: string }[];
  metas: { pid: string; meta: Record<string, unknown>; revision: string }[];
  conflicts: Conflict[];
  /** Projects deleted on another device that are untouched here. */
  removeProjects?: string[];
};
export const remoteIsEmpty = (r: RemotePlan) => !r.fetch.length && !r.remove.length && !r.metas.length && !r.conflicts.length && !r.removeProjects?.length;
/** True when nothing in the project was changed here since it was last loaded or saved. */
function projectClean(p: Project, base: Baseline) {
  const sp = base.projects.get(p.id);
  const known = [...base.boards.values()].filter(b => b.pid === p.id);
  return !!sp && metaJson(p) === sp.json && known.length === p.boards.length && p.boards.every(b => base.boards.get(boardKey(p.id, b.id))?.board === b);
}

/** Compares the host's manifest with the baseline: clean boards are fetched or removed, edited ones become conflicts. */
export function diffRemote(m: Manifest, base: Baseline, projects: Project[]): RemotePlan {
  const plan: RemotePlan = { fetch: [], remove: [], metas: [], conflicts: [], removeProjects: [] };
  const local = new Map(projects.map(p => [p.id, p]));
  for (const rp of m.projects) {
    const lp = local.get(rp.id), sp = base.projects.get(rp.id);
    if (!sp) {
      // A project another device created; it is added once it has a board. A local project that is not on the host yet is saved by the next flush.
      if (!lp && rp.boards.length) { plan.metas.push({ pid: rp.id, meta: rp.meta, revision: rp.revision }); for (const rb of rp.boards) plan.fetch.push({ pid: rp.id, bid: rb.id }); }
      continue;
    }
    if (!lp) continue;
    if (sp.revision !== rp.revision) {
      if (metaJson(lp) === sp.json) plan.metas.push({ pid: rp.id, meta: rp.meta, revision: rp.revision });
      else plan.conflicts.push({ key: projectKey(rp.id), kind: 'project', pid: rp.id, name: lp.name, reason: 'changed' });
    }
    const remoteIds = new Set(rp.boards.map(b => b.id));
    for (const rb of rp.boards) {
      const key = boardKey(rp.id, rb.id), sb = base.boards.get(key), lb = lp.boards.find(b => b.id === rb.id);
      if (!sb) { if (!lb) plan.fetch.push({ pid: rp.id, bid: rb.id }); continue; }
      if (sb.revision === rb.revision) continue;
      if (!lb) plan.conflicts.push({ key, kind: 'board', pid: rp.id, bid: rb.id, name: sb.board.name, reason: 'deleted-here' });
      else if (lb !== sb.board) plan.conflicts.push({ key, kind: 'board', pid: rp.id, bid: rb.id, name: lb.name, reason: 'changed' });
      else plan.fetch.push({ pid: rp.id, bid: rb.id });
    }
    for (const sb of base.boards.values()) {
      if (sb.pid !== rp.id || remoteIds.has(sb.bid)) continue;
      const lb = lp.boards.find(b => b.id === sb.bid);
      if (lb && lb !== sb.board) plan.conflicts.push({ key: boardKey(sb.pid, sb.bid), kind: 'board', pid: sb.pid, bid: sb.bid, name: lb.name, reason: 'deleted' });
      else plan.remove.push({ pid: sb.pid, bid: sb.bid });
    }
  }
  const onHost = new Set(m.projects.map(p => p.id));
  for (const pid of base.projects.keys()) {
    if (onHost.has(pid)) continue;
    const lp = local.get(pid);
    if (!lp || projectClean(lp, base)) plan.removeProjects!.push(pid);
    else plan.conflicts.push({ key: projectKey(pid), kind: 'project', pid, name: lp.name, reason: 'deleted' });
  }
  return plan;
}

export type Fetched = { pid: string; bid: string; board: Board | null; revision: string };

/**
 * Merges what another device saved into this device's state and baseline. A board or project edited here after
 * diffRemote ran becomes a conflict instead of being replaced, unless its key is in `takeTheirs` (the user chose
 * "Load latest from host"). Boards follow the host's order; boards not on the host yet stay at the end.
 */
export function applyRemote(projects: Project[], base: Baseline, m: Manifest, plan: RemotePlan, fetched: Fetched[], takeTheirs: ReadonlySet<string> = new Set()) {
  const conflicts = [...plan.conflicts], updated: string[] = [];
  const cleanBoard = (pid: string, bid: string, lb: Board | undefined) => {
    const key = boardKey(pid, bid), sb = base.boards.get(key);
    return takeTheirs.has(key) || (sb ? lb === sb.board : !lb);
  };
  let next = projects.slice();
  for (const x of plan.metas) {
    const i = next.findIndex(p => p.id === x.pid), sp = base.projects.get(x.pid);
    const [np] = normalizeProjects([{ ...x.meta, id: x.pid, boards: [] }]);
    if (i < 0) {
      if (sp && !takeTheirs.has(projectKey(x.pid))) continue;
      next.push(np);
    } else {
      const lp = next[i];
      if (!takeTheirs.has(projectKey(x.pid)) && (!sp || metaJson(lp) !== sp.json)) { conflicts.push({ key: projectKey(x.pid), kind: 'project', pid: x.pid, name: lp.name, reason: 'changed' }); continue; }
      next[i] = { ...np, boards: lp.boards };
    }
    base.projects.set(x.pid, { json: metaJson(np), revision: x.revision });
    updated.push(np.name);
  }
  for (const f of fetched) {
    const i = next.findIndex(p => p.id === f.pid);
    if (i < 0) continue;
    const p = next[i], key = boardKey(f.pid, f.bid), lb = p.boards.find(b => b.id === f.bid);
    if (!cleanBoard(f.pid, f.bid, lb)) { conflicts.push({ key, kind: 'board', pid: f.pid, bid: f.bid, name: lb?.name || f.board?.name || 'Board', reason: 'changed' }); continue; }
    if (!f.board) { // gone from the host since the manifest was read
      if (lb) { next[i] = { ...p, boards: p.boards.filter(b => b !== lb) }; updated.push(lb.name); }
      base.boards.delete(key);
      continue;
    }
    const nb = normalizeBoard(f.board);
    next[i] = { ...p, boards: lb ? p.boards.map(b => (b === lb ? nb : b)) : [...p.boards, nb] };
    base.boards.set(key, { pid: f.pid, bid: f.bid, board: nb, revision: f.revision });
    updated.push(nb.name);
  }
  for (const r of plan.remove) {
    const i = next.findIndex(p => p.id === r.pid);
    if (i < 0) continue;
    const p = next[i], key = boardKey(r.pid, r.bid), lb = p.boards.find(b => b.id === r.bid);
    if (!cleanBoard(r.pid, r.bid, lb)) { conflicts.push({ key, kind: 'board', pid: r.pid, bid: r.bid, name: lb?.name || 'Board', reason: 'deleted' }); continue; }
    if (lb) { next[i] = { ...p, boards: p.boards.filter(b => b !== lb) }; updated.push(lb.name); }
    base.boards.delete(key);
  }
  for (const pid of plan.removeProjects || []) {
    const lp = next.find(p => p.id === pid);
    if (lp && !takeTheirs.has(projectKey(pid)) && !projectClean(lp, base)) { conflicts.push({ key: projectKey(pid), kind: 'project', pid, name: lp.name, reason: 'deleted' }); continue; }
    if (lp) { next = next.filter(p => p !== lp); updated.push(lp.name); }
    forgetProject(base, pid);
  }
  next = next.map(p => {
    const rp = m.projects.find(x => x.id === p.id);
    if (!rp) return p;
    const pos = new Map(rp.boards.map((b, i) => [b.id, i]));
    const at = (b: Board) => pos.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...p.boards].sort((a, b) => at(a) - at(b));
    return sorted.every((b, i) => b === p.boards[i]) ? p : { ...p, boards: sorted };
  });
  return { projects: next, conflicts, updated };
}
