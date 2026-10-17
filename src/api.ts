import type { Board, Project } from './types.ts';
import type { ConflictReason, Manifest, ProjectMeta } from './sync.ts';
import type { Candidate, NewsResult, Topic, TopicEvent } from './explore.ts';
import type { Neighbors } from './searchAround.ts';
import type { NewWatch, Watch, WatchList, WatchSummary } from './watch.ts';
import type { Place } from './geo.ts';

export class AccessRequired extends Error {}

async function call<T>(url: string, init?: RequestInit): Promise<{ status: number; data: T }> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  let data: any = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && data?.error === 'access-code-required') throw new AccessRequired();
  return { status: res.status, data };
}

export type Session = { local: boolean; codeRequired: boolean; authorized: boolean };
export const getSession = () => call<Session>('/api/session').then(r => r.data);

export async function submitAccessCode(code: string): Promise<string | null> {
  const r = await call<{ ok?: boolean; error?: string }>('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return r.status === 200 ? null : r.data?.error || 'Could not verify the code.';
}
export const forgetDevice = () => call('/api/access/forget', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

export async function loadWorkspace(): Promise<{ revision: string; projects: Project[]; manifest: Manifest }> {
  const r = await call<{ revision: string; projects: Project[]; manifest?: Manifest; error?: string }>('/api/workspace');
  if (r.status !== 200) throw new Error(r.data?.error || `Host returned ${r.status}`);
  if (!r.data.manifest) throw new Error('This page is newer than the Atlas host that is running. On the Windows PC, stop the host (Ctrl+C), start it again with npm.cmd run host, then reload this page.');
  return r.data as { revision: string; projects: Project[]; manifest: Manifest };
}
export async function getManifest(): Promise<Manifest> {
  const r = await call<Manifest & { error?: string }>('/api/workspace/manifest');
  if (r.status !== 200) throw new Error(r.data?.error || `Host returned ${r.status}`);
  return r.data;
}

const boardUrl = (pid: string, bid: string) => `/api/boards/${encodeURIComponent(pid)}/${encodeURIComponent(bid)}`;
/** One board as the host holds it, or null if the host no longer has it. */
export async function getBoard(pid: string, bid: string): Promise<{ board: Board; revision: string } | null> {
  const r = await call<{ board: Board; revision: string; error?: string }>(boardUrl(pid, bid));
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(r.data?.error || `Host returned ${r.status}`);
  return r.data;
}

/** A save is checked against the revision this device last saw; 'new' means the host should not have it yet. */
export type SaveResult = { ok: true; revision: string; savedAt: string } | { conflict: true; reason: ConflictReason; revision: string };
async function unit(url: string, method: string, body: unknown): Promise<SaveResult> {
  const r = await call<any>(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 409 && r.data?.error === 'conflict') return { conflict: true, reason: r.data.reason || 'changed', revision: r.data.revision };
  if (r.status !== 200) throw new Error(r.data?.error || `Host returned ${r.status}`);
  return r.data;
}
export const saveBoard = (pid: string, board: Board, baseRevision: string, force = false) => unit(boardUrl(pid, board.id), 'PUT', { baseRevision, board, force });
export const deleteBoard = (pid: string, bid: string, baseRevision: string, force = false) => unit(boardUrl(pid, bid), 'DELETE', { baseRevision, force });
export const deleteProjectOnHost = (pid: string, baseRevision: string, boardRevisions: Record<string, string>, force = false) => unit(`/api/projects/${encodeURIComponent(pid)}`, 'DELETE', { baseRevision, boardRevisions, force });
export const saveProjectMeta = (pid: string, project: ProjectMeta, baseRevision: string, force = false) => unit(`/api/projects/${encodeURIComponent(pid)}`, 'PUT', { baseRevision, project, force });

export type HostInfo = {
  version: string; local: boolean; codeRequired: boolean; lanUrls: string[]; port: number; dataBytes: number;
  accessCode?: string | null; storagePath?: string; backupDir?: string; backups?: { name: string; bytes: number; mtime: string }[]; backupCount?: number;
};
export const getHostInfo = () => call<HostInfo>('/api/host-info').then(r => r.data);
export async function rotateAccessCode(): Promise<string> {
  const r = await call<{ accessCode?: string; error?: string }>('/api/access/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (r.status !== 200 || !r.data.accessCode) throw new Error(r.data?.error || 'Could not change the code');
  return r.data.accessCode;
}

// ---------- Explore (live look-ups through the Windows host) ----------
async function getOrThrow<T>(url: string): Promise<T> {
  const r = await call<any>(url);
  if (r.status !== 200) throw new Error(r.data?.error || `Host returned ${r.status}`);
  return r.data as T;
}
export const searchTopics = (q: string) => getOrThrow<Candidate[]>(`/api/explore/search?q=${encodeURIComponent(q)}`);
export const getTopic = (qid: string) => getOrThrow<Topic>(`/api/explore/topic/${encodeURIComponent(qid)}`);
export const getNews = (q: string, before?: string) => getOrThrow<NewsResult>(`/api/explore/news?q=${encodeURIComponent(q)}${before ? `&before=${before}` : ''}`);
export const getEvents = (qid: string) => getOrThrow<{ events: TopicEvent[] }>(`/api/explore/events/${encodeURIComponent(qid)}`).then(r => r.events);
export const getNeighbors = (qid: string) => getOrThrow<Neighbors>(`/api/explore/neighbors/${encodeURIComponent(qid)}`);

// ---------- Watchlists (checked on the Windows host; see server/watch.mjs) ----------
async function watchCall<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await call<any>(url, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status < 200 || r.status > 299) throw new Error(r.data?.error || `Host returned ${r.status}`);
  return r.data as T;
}
export const getWatchList = () => watchCall<WatchList>('/api/watch');
export const getWatchSummary = () => watchCall<WatchSummary>('/api/watch/summary');
export const addWatch = (w: NewWatch) => watchCall<Watch>('/api/watch', 'POST', w);
export const updateWatch = (id: string, patch: Partial<Pick<Watch, 'label' | 'query' | 'englishOnly' | 'paused'>>) => watchCall<Watch>(`/api/watch/${encodeURIComponent(id)}`, 'PUT', patch);
export const removeWatch = (id: string) => watchCall<{ ok: true }>(`/api/watch/${encodeURIComponent(id)}`, 'DELETE');
export const checkWatches = (id?: string) => watchCall<{ started: boolean; reason?: string }>('/api/watch/check', 'POST', id ? { id } : {});
export const markWatchSeen = (sel: { ids: string[] } | { watchId: string } | { all: true }) => watchCall<{ unseen: number }>('/api/watch/seen', 'POST', sel);
export const setWatchSettings = (intervalHours: number) => watchCall<{ intervalHours: number }>('/api/watch/settings', 'PUT', { intervalHours });

// ---------- Place search for the maps (OpenStreetMap Nominatim through the host; see server/geocode.mjs) ----------
export const searchPlaces = (q: string) => getOrThrow<{ places: Place[]; attribution: string }>(`/api/geo/search?q=${encodeURIComponent(q)}`);
