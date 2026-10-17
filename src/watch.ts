// Watchlists in the app: types for the host's /api/watch answers and small display helpers.

export type WatchKind = 'entity' | 'keyword';
export type Watch = {
  id: string; kind: WatchKind; label: string; query: string; qid?: string; projectId?: string; entityKey?: string;
  englishOnly: boolean; paused: boolean; createdAt: string; lastCheckedAt?: string; lastError?: string; unseen: number;
};
export type NewsHit = { title: string; url: string; domain: string; date: string; language: string };
export type WatchChange = { property?: string; label: string; added: string[]; removed: string[]; text: string };
export type Alert = { id: string; watchId: string; at: string; kind: 'news' | 'wikidata'; qid?: string; news?: NewsHit; change?: WatchChange; seen: boolean };
export type WatchStatus = { running: boolean; done: number; total: number; current: string; lastRoundAt: string | null; nextRoundAt: string | null };
export type WatchList = { settings: { intervalHours: number }; status: WatchStatus; watches: Watch[]; alerts: Alert[] };
export type Watched = { id: string; label: string; query: string; qid?: string };
export type WatchSummary = { unseen: number; running: boolean; watched: Watched[] };
export type NewWatch = { kind: WatchKind; label: string; query?: string; qid?: string; projectId?: string; entityKey?: string; englishOnly?: boolean };

export const INTERVAL_LABELS: [number, string][] = [[1, 'Every hour'], [6, 'Every 6 hours'], [24, 'Every day'], [0, 'Only when I press Check now']];
export const EMPTY_SUMMARY: WatchSummary = { unseen: 0, running: false, watched: [] };

const norm = (q: string) => String(q).toLowerCase().replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();

/** The watch for an entity (by Wikidata ID) or a phrase, as the host would count a duplicate. */
export function findWatch(watched: Watched[], { qid, query }: { qid?: string; query?: string }): Watched | undefined {
  if (qid) return watched.find(w => w.qid === qid);
  return query ? watched.find(w => !w.qid && norm(w.query) === norm(query)) : undefined;
}

/** "just now", "15 min ago", "2 h ago", "3 days ago", or "never". */
export function ago(at: string | null | undefined, now = Date.now()): string {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return 'never';
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** The heading an alert is grouped under: Today, Yesterday or its date (local time). */
export function alertDay(at: string, now = Date.now()): string {
  const day = localDay(Date.parse(at));
  if (day === localDay(now)) return 'Today';
  if (day === localDay(now - 86400000)) return 'Yesterday';
  return day;
}
export const historyUrl = (qid: string) => `https://www.wikidata.org/w/index.php?title=${encodeURIComponent(qid)}&action=history`;
