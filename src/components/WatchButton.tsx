// "Watch" on an Investigate profile or an Explore topic; "Watching" once the host has it, opening the Watchlist.
import { useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { addWatch } from '../api.ts';
import { findWatch, type NewWatch } from '../watch.ts';

export const SELECTED_WATCH_KEY = 'atlas.watch.selected';

export default function WatchButton({ ctx, watch, small }: { ctx: Ctx; watch: NewWatch; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const found = findWatch(ctx.watch.watched, watch.qid ? { qid: watch.qid } : { query: watch.query || watch.label });
  const cls = `button subtle${small ? ' small' : ''}`;
  if (found) return <button className={cls} title="Open it in the Watchlist" onClick={() => {
    try { localStorage.setItem(SELECTED_WATCH_KEY, JSON.stringify(found.id)); } catch {}
    ctx.setView('Watchlist');
  }}><BellRing size={13} /> Watching</button>;
  const add = async () => {
    setBusy(true);
    try {
      await addWatch(watch);
      ctx.refreshWatch();
      ctx.notify(`Watching “${watch.label}”. The Windows host checks news${watch.qid ? ' and Wikidata' : ''} on its schedule; the first check only records what is already there.`);
    } catch (e) { ctx.notify(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <button className={cls} disabled={ctx.readOnly || busy} onClick={add}><Bell size={13} /> Watch</button>;
}
