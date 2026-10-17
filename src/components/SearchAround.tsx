import { useEffect, useMemo, useState } from 'react';
import type { Node } from '@xyflow/react';
import { Check, Compass, ExternalLink, Loader2, Plus, RefreshCw, Search, TriangleAlert, Undo2 } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { AccessRequired, getNeighbors, searchTopics } from '../api.ts';
import type { Candidate } from '../explore.ts';
import { matchesQuery } from '../model.ts';
import { expandNode, linkNodeToWikidata, undoExpansion, wikidataIdOf, wikidataUrl, type Expansion, type Neighbors, type Pick } from '../searchAround.ts';

export type LastExpansion = { nodeLabel: string; added: Expansion } | null;
const errorText = (e: unknown) => (e instanceof AccessRequired ? 'This device needs the access code again. Reload the page.' : (e as Error)?.message || 'The Windows host did not answer.');
const pickKey = (groupKey: string, itemId: string) => `${groupKey}|${itemId}`;

/** Graph inspector section: link a node to Wikidata, then pull its connections into the board, hop by hop. */
export default function SearchAround({ ctx, node, last, setLast }: { ctx: Ctx; node: Node; last: LastExpansion; setLast: (l: LastExpansion) => void }) {
  const qid = wikidataIdOf(node);
  const label = String((node.data as Record<string, unknown>)?.label || '');
  const [around, setAround] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data?: Neighbors; message?: string }>({ status: 'idle' });
  const [matches, setMatches] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; list: Candidate[]; message?: string }>({ status: 'idle', list: [] });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  useEffect(() => { setAround({ status: 'idle' }); setMatches({ status: 'idle', list: [] }); setPicked(new Set()); setFilter(''); }, [node.id, qid]);

  const onBoard = useMemo(() => new Set(ctx.board.nodes.map(wikidataIdOf).filter(Boolean) as string[]), [ctx.board.nodes]);
  const groups = (around.data?.groups || []).map(g => ({ ...g, items: g.items.filter(i => matchesQuery(`${i.label} ${i.description} ${i.kind} ${g.relation}`, filter)) })).filter(g => g.items.length);
  const picks: Pick[] = groups.flatMap(g => g.items.filter(i => picked.has(pickKey(g.key, i.id))).map(item => ({ group: g, item })));

  const load = async () => {
    if (!qid) return;
    setAround({ status: 'loading' });
    try { setAround({ status: 'done', data: await getNeighbors(qid) }); } catch (e) { setAround({ status: 'error', message: errorText(e) }); }
  };
  const findMatches = async () => {
    setMatches({ status: 'loading', list: [] });
    try { setMatches({ status: 'done', list: (await searchTopics(label)).slice(0, 6) }); } catch (e) { setMatches({ status: 'error', list: [], message: errorText(e) }); }
  };
  const link = (c: Candidate) => {
    ctx.patchBoard(b => linkNodeToWikidata(b, node.id, c));
    ctx.notify(`Linked “${label}” to Wikidata ${c.id} (${c.label}).`);
  };
  // Computed once against the board shown, then merged into the latest board, so undo knows the exact ids it added.
  const add = (list: Pick[]) => {
    if (!list.length) return;
    const { board: expanded, added } = expandNode(ctx.board, node.id, list);
    if (!added.nodeIds.length && !added.edgeIds.length) { ctx.notify('Everything you picked is already linked on this board.'); return; }
    const nodes = new Set(added.nodeIds), edges = new Set(added.edgeIds);
    const newNodes = expanded.nodes.filter(n => nodes.has(n.id)), newEdges = expanded.edges.filter(e => edges.has(e.id));
    ctx.patchBoard(b => ({ ...b, nodes: [...b.nodes, ...newNodes], edges: [...b.edges, ...newEdges] }));
    setLast({ nodeLabel: label, added });
    setPicked(new Set());
    ctx.notify(`Added ${added.nodeIds.length} node${added.nodeIds.length === 1 ? '' : 's'} and ${added.edgeIds.length} link${added.edgeIds.length === 1 ? '' : 's'} around “${label}”.`);
  };
  const undo = () => {
    if (!last) return;
    ctx.patchBoard(b => undoExpansion(b, last.added));
    ctx.notify(`Removed what the last expansion around “${last.nodeLabel}” added.`);
    setLast(null);
  };
  const toggle = (key: string) => setPicked(s => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const ro = ctx.readOnly;

  return <div className="around">
    <label className="field-caption">SEARCH AROUND</label>
    {!qid ? <>
      <small className="muted">Link this node to Wikidata to see what it is connected to.</small>
      <button className="button subtle" disabled={ro || !label.trim() || matches.status === 'loading'} onClick={findMatches}>{matches.status === 'loading' ? <Loader2 size={13} className="spin" /> : <Search size={13} />} Find “{label || 'this node'}” on Wikidata</button>
      {matches.status === 'error' && <small className="around-warn"><TriangleAlert size={12} /> {matches.message}</small>}
      {matches.status === 'done' && !matches.list.length && <small className="muted">No match. Rename the node and try again.</small>}
      {matches.list.map(c => <div className="around-item" key={c.id}><span><b>{c.label}</b><small>{c.description || c.id}</small></span><button className="button subtle small" disabled={ro} onClick={() => link(c)}>This is it</button></div>)}
    </> : <>
      <small className="muted">Linked to <a href={wikidataUrl(qid)} target="_blank" rel="noreferrer noopener">Wikidata {qid} <ExternalLink size={9} /></a></small>
      {around.status === 'idle' && <button className="button primary" disabled={ro} onClick={load}><Compass size={13} /> Search around</button>}
      {around.status === 'loading' && <small className="muted"><Loader2 size={12} className="spin" /> Looking up connections…</small>}
      {around.status === 'error' && <><small className="around-warn"><TriangleAlert size={12} /> {around.message}</small><button className="button subtle small" onClick={load}><RefreshCw size={12} /> Try again</button></>}
      {around.status === 'done' && around.data && <>
        {!around.data.groups.length && <small className="muted">Wikidata lists no connections for this item.</small>}
        {Object.keys(around.data.errors).length > 0 && <small className="around-warn"><TriangleAlert size={12} /> Some details could not be loaded. <button className="text-button" onClick={load}>Try again</button></small>}
        {around.data.groups.length > 0 && <div className="searchbox"><Search size={12} /><input aria-label="Filter connections" placeholder="Filter connections" value={filter} onChange={e => setFilter(e.target.value)} /></div>}
        <small className="muted">→ its own statements · ← items that name it</small>
        <div className="around-groups">{groups.map(g => {
          const addable = g.items.filter(i => !onBoard.has(i.id));
          return <div className="around-group" key={g.key}>
            <div className="around-group-head"><b>{g.direction === 'out' ? '→' : '←'} {g.relation} <i>({g.items.length})</i></b>
              <button className="text-button" disabled={ro} onClick={() => add(g.items.map(item => ({ group: g, item })))}>Add all</button></div>
            {g.items.map(i => {
              const key = pickKey(g.key, i.id), there = onBoard.has(i.id);
              return <label className="around-item" key={key} title={i.description}>
                <input type="checkbox" disabled={ro} checked={picked.has(key)} onChange={() => toggle(key)} />
                <span><b>{i.label}</b><small>{i.kind}{i.description ? ` · ${i.description}` : ''}</small></span>
                {there && <Check size={12} className="around-there" aria-label="Already on this board" />}
              </label>;
            })}
            {!addable.length && <small className="muted">All already on this board.</small>}
          </div>;
        })}</div>
        {around.data.capped && <small className="muted">Showing the first 300 incoming links; filter to narrow down.</small>}
        <button className="button primary" disabled={ro || !picks.length} onClick={() => add(picks)}><Plus size={13} /> Add selected ({picks.length})</button>
        <small className="muted">Links come from Wikidata (community-edited) and are marked unverified.</small>
      </>}
    </>}
    {last && <button className="button subtle" disabled={ro} onClick={undo}><Undo2 size={13} /> Undo last expansion</button>}
  </div>;
}
