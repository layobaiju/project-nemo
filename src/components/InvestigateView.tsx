// Investigate: one page per person, organisation, place or event, with its connections, map, timeline, records,
// sources and folder material side by side. Entities are derived (src/entities.ts); only merges are stored.
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Compass, ExternalLink, Folder, Globe2, Network, PanelLeft, ScanSearch, Search, Shield, Split, GitMerge, X } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { VERIFICATION_COLORS, dateSpan, formatDateRange, hasCoords, matchesQuery } from '../model.ts';
import {
  buildEntities, connectionsOf, emptyDecisions, entityFolderItems, entityRecords, entitySources, markDistinct, mergeEntities, suggestDuplicates, unmerge,
  type Connection, type Entity, type EntityKind,
} from '../entities.ts';
import InteractiveMap, { type BasemapMode } from '../InteractiveMap.tsx';
import { usePersisted } from '../usePersisted.ts';
import RecordSummary from './RecordSummary.tsx';
import { VerificationBadge } from './ui.tsx';
import { ConnectionsDiagram, KIND_COLORS, LISTED_TOGETHER, TimelineStrip, type TimelineItem } from './InvestigatePanes.tsx';
import { DuplicatesList, MergeDialog } from './EntityMerge.tsx';
import WatchButton from './WatchButton.tsx';

type Tab = 'records' | 'sources' | 'folders' | 'boards';
const GROUPS: [EntityKind, string][] = [['Person', 'People'], ['Organisation', 'Organisations'], ['Other actor', 'Other actors'], ['Place', 'Places'], ['Event', 'Events']];
const PER_GROUP = 150;
const PLACEHOLDER = 'Add a summary and public source.';
const httpsOnly = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

export default function InvestigateView({ ctx }: { ctx: Ctx }) {
  const { project } = ctx;
  const decisions = project.entityDecisions;
  const index = useMemo(() => buildEntities(project, decisions), [project.boards, decisions]); // eslint-disable-line react-hooks/exhaustive-deps
  const ranked = useMemo(() => [...index.entities].sort((a, b) => b.mentions.length - a.mentions.length || a.name.localeCompare(b.name)), [index]);
  const suggestions = useMemo(() => suggestDuplicates(index, decisions), [index, decisions]);

  const [savedKey, setSavedKey] = usePersisted('atlas.inv.entity', '');
  const [tab, setTab] = usePersisted<Tab>('atlas.inv.tab', 'records');
  const [basemap] = usePersisted<BasemapMode>('atlas.basemap', 'online');
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [link, setLink] = useState<Connection | null>(null);
  const [showDups, setShowDups] = useState(false);
  const [merge, setMerge] = useState<{ a: Entity; b?: Entity } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [graphMenu, setGraphMenu] = useState(false);

  const entity = index.byKey.get(savedKey) || ranked[0];
  const key = entity?.key || '';
  // A merge or unmerge can change the shown entity's key; remember the current one.
  useEffect(() => { if (entity && savedKey !== entity.key) setSavedKey(entity.key); }, [entity?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelected(''); setLink(null); setGraphMenu(false); }, [key]);

  const records = useMemo(() => (entity ? entityRecords(project, entity) : []), [project, entity]);
  const conns = useMemo(() => (entity ? connectionsOf(project, index, entity.key) : { shown: [], total: 0 }), [project, index, entity]);
  const sources = useMemo(() => (entity ? entitySources(project, entity) : []), [project, entity]);
  const folderItems = useMemo(() => (entity ? entityFolderItems(project, entity) : []), [project, entity]);
  const boardName = (id: string) => project.boards.find(b => b.id === id)?.name || 'Deleted board';

  // A clicked connection narrows the records to the ones behind it.
  const shared = link ? new Set(link.shared.map(s => `${s.boardId}\u0000${s.recordId}`)) : null;
  const shown = shared ? records.filter(r => shared.has(`${r.boardId}\u0000${r.record.id}`)) : records;
  const placed = shown.filter(r => hasCoords(r.record));
  const fit = useMemo(() => {
    if (!placed.length) return undefined;
    const xs = placed.map(r => r.record.longitude!), ys = placed.map(r => r.record.latitude!);
    const pad = placed.length === 1 ? 1 : 0;
    return { bounds: [[Math.min(...xs) - pad, Math.min(...ys) - pad], [Math.max(...xs) + pad, Math.max(...ys) + pad]] as [[number, number], [number, number]], n: Date.now() };
  }, [key, link, placed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const timeline: TimelineItem[] = shown.flatMap(r => {
    const s = dateSpan(r.record.date, r.record.endDate);
    return s ? [{ id: r.record.id, start: s[0], end: s[1], color: VERIFICATION_COLORS[r.record.verification] || '#8a96aa', label: `${r.record.name || 'Untitled record'} · ${formatDateRange(r.record)}` }] : [];
  });
  const selectedRow = shown.find(r => r.record.id === selected);

  const focusOn = (k: string) => {
    if (k === key) return;
    if (key) setHistory(h => [...h.slice(-30), key]);
    setSavedKey(k); setShowDups(false); setListOpen(false);
  };
  const back = () => { const prev = history[history.length - 1]; if (!prev) return; setHistory(h => h.slice(0, -1)); setSavedKey(prev); };
  const select = (id: string) => { setSelected(id); if (tab !== 'records') setTab('records'); };

  const doMerge = (a: Entity, b: Entity, name: string) => {
    const next = mergeEntities(decisions ?? emptyDecisions(), a, b, name, ctx.device);
    if (!next) { ctx.notify('People, organisations and other actors merge only with each other; places and events only with their own kind.'); return; }
    ctx.patchProject(p => ({ ...p, entityDecisions: next }));
    setMerge(null); setShowDups(false);
    setSavedKey(`m:${next.merges[next.merges.length - 1].id}`);
    ctx.notify('Merged. Records and nodes keep their own wording.');
  };
  const doUnmerge = (e: Entity) => {
    if (!e.mergeId || !confirm(`Unmerge “${e.name}”? Its spellings become separate entities again. Records and nodes are not changed.`)) return;
    ctx.patchProject(p => ({ ...p, entityDecisions: unmerge(p.entityDecisions ?? emptyDecisions(), e.mergeId!) }));
    // Stay on the part shown under the merged name rather than jumping to another entity.
    setSavedKey(e.keys.find(k => k.startsWith('wd:')) || e.keys.find(k => k.startsWith('n:')) || '');
    ctx.notify('Unmerged.');
  };
  const doDistinct = (a: Entity, b: Entity) => {
    ctx.patchProject(p => ({ ...p, entityDecisions: markDistinct(p.entityDecisions ?? emptyDecisions(), a, b) }));
    ctx.notify(`“${a.name}” and “${b.name}” will not be suggested again.`);
  };

  // Leaving the page: Graph and World open with this entity highlighted until the chip is cleared.
  const focusFor = (e: Entity) => ({ label: e.name, nodeIds: e.nodes.map(n => n.nodeId), recordIds: e.records.map(r => r.recordId), n: Date.now() });
  const graphBoards = entity ? [...new Set(entity.nodes.map(n => n.boardId))] : [];
  const openGraph = (boardId: string) => { if (!entity) return; ctx.setFocus(focusFor(entity)); ctx.selectBoard(boardId); ctx.setView('Graph'); };
  const showWorld = () => {
    if (!entity || !records.length) return;
    const per = new Map<string, number>();
    for (const r of records) per.set(r.boardId, (per.get(r.boardId) || 0) + 1);
    const best = [...per.entries()].sort((a, b) => b[1] - a[1])[0][0];
    ctx.setFocus(focusFor(entity)); ctx.selectBoard(best); ctx.setView('World');
  };

  const list = <aside className={'inv-list' + (listOpen ? ' open' : '')} aria-label="Entities">
    <div className="inv-list-head">
      <div className="eyebrow">INVESTIGATE · {project.name.toUpperCase()}</div>
      <div className="searchbox"><Search size={14} /><input aria-label="Find an entity" placeholder="Find a person, group, place…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <button className={'inv-dup-link' + (showDups ? ' on' : '')} onClick={() => { setShowDups(x => !x); setListOpen(false); }}><GitMerge size={13} /> Possible duplicates ({suggestions.length})</button>
    </div>
    <div className="inv-list-body">
      {GROUPS.map(([kind, label]) => {
        const all = ranked.filter(e => e.kind === kind && matchesQuery([e.name, ...e.aliases].join(' '), query));
        if (!all.length) return null;
        return <section key={kind}><h4><i style={{ background: KIND_COLORS[kind] }} />{label} <small>{all.length}</small></h4>
          {all.slice(0, PER_GROUP).map(e => <button key={e.key} className={e === entity ? 'on' : ''} onClick={() => focusOn(e.key)}><span>{e.name}</span><small>{e.records.length || e.nodes.length}</small></button>)}
          {all.length > PER_GROUP && <small className="muted">{all.length - PER_GROUP} more; search to narrow.</small>}
        </section>;
      })}
      {query && !ranked.some(e => matchesQuery([e.name, ...e.aliases].join(' '), query)) && <p className="muted small">Nothing in this project matches “{query}”. <button className="text-button" onClick={() => ctx.searchWorld(query)}>Search public sources</button></p>}
    </div>
  </aside>;

  if (!entity) return <section className="content inv-empty-page">
    <div className="view-heading"><div><div className="eyebrow">INVESTIGATE · {project.name.toUpperCase()}</div><h1>No people, groups, places or events yet</h1>
      <p>Investigate gathers everything about one entity. Entities come from graph nodes of kind Actor, Organisation, Place, Event or Historical event, from actors listed on records, and from records' countries.</p></div></div>
    <div className="guide-links"><button className="button primary" onClick={() => ctx.setView('Explore')}><Compass size={14} /> Find something in Explore</button><button className="button subtle" onClick={() => ctx.setView('Graph')}><Network size={14} /> Open the graph</button></div>
  </section>;

  const node0 = entity.nodes.map(n => project.boards.find(b => b.id === n.boardId)?.nodes.find(x => x.id === n.nodeId)).find(Boolean);
  const summary = String((node0?.data as Record<string, unknown> | undefined)?.detail || '');
  const boards = [...new Set([...entity.nodes.map(n => n.boardId), ...entity.records.map(r => r.boardId)])];

  return <section className="inv">
    {list}
    {listOpen && <div className="inv-scrim" onClick={() => setListOpen(false)} />}
    <div className="inv-main">
      <header className="inv-profile">
        <div className="inv-profile-top">
          <button className="button subtle small inv-list-toggle" onClick={() => setListOpen(true)}><PanelLeft size={13} /> Entities</button>
          {history.length > 0 && <button className="button subtle small" onClick={back}><ArrowLeft size={13} /> Back</button>}
        </div>
        <div className="eyebrow"><i style={{ background: KIND_COLORS[entity.kind] }} /> {entity.kind.toUpperCase()}{entity.mergeId ? ' · MERGED' : ''}</div>
        <h1>{entity.name}</h1>
        {entity.aliases.length > 0 && <p className="inv-aliases">Also written: {entity.aliases.slice(0, 8).join(' · ')}{entity.aliases.length > 8 ? ` · +${entity.aliases.length - 8}` : ''}</p>}
        {summary && summary !== PLACEHOLDER && <p className="inv-summary">{summary}</p>}
        <div className="inv-counts">
          <span><b>{entity.records.length}</b> records</span><span><b>{entity.nodes.length}</b> nodes</span><span><b>{folderItems.length}</b> folder items</span><span><b>{boards.length}</b> board{boards.length === 1 ? '' : 's'}</span>
          {entity.qids.map(q => <a key={q} href={`https://www.wikidata.org/wiki/${q}`} target="_blank" rel="noreferrer">Wikidata {q} <ExternalLink size={11} /></a>)}
        </div>
        <div className="inv-actions">
          <div className="menu-wrap">
            <button className="button subtle small" disabled={!graphBoards.length} title={graphBoards.length ? '' : 'No graph node for this entity yet'} onClick={() => (graphBoards.length === 1 ? openGraph(graphBoards[0]) : setGraphMenu(x => !x))}><Network size={13} /> Open in Graph</button>
            {graphMenu && <div className="menu" onMouseLeave={() => setGraphMenu(false)}>{graphBoards.map(b => <button key={b} onClick={() => openGraph(b)}><b>{boardName(b)}</b><small>{entity.nodes.filter(n => n.boardId === b).length} node(s)</small></button>)}</div>}
          </div>
          <button className="button subtle small" disabled={!records.length} onClick={showWorld}><Globe2 size={13} /> Show on World</button>
          <button className="button subtle small" onClick={() => ctx.searchWorld(entity.name)}><Compass size={13} /> Explore</button>
          <WatchButton ctx={ctx} small watch={{ kind: 'entity', label: entity.name, ...(entity.qids[0] ? { qid: entity.qids[0] } : {}), projectId: project.id, entityKey: entity.key }} />
          <button className="button subtle small" disabled={ctx.readOnly} onClick={() => setMerge({ a: entity })}><GitMerge size={13} /> Merge with…</button>
          {entity.mergeId && <button className="button subtle small" disabled={ctx.readOnly} onClick={() => doUnmerge(entity)}><Split size={13} /> Unmerge</button>}
        </div>
        {entity.ambiguous && <div className="tip"><Shield size={14} /><span>Several Wikidata entities share this name, so these mentions were not linked to one of them. See <button className="text-button" onClick={() => setShowDups(true)}>Possible duplicates</button>.</span></div>}
      </header>

      {showDups ? <section className="inv-pane">
        <div className="inv-pane-head"><h3>Possible duplicates</h3><button className="icon-action" aria-label="Close duplicates" onClick={() => setShowDups(false)}><X size={14} /></button></div>
        <DuplicatesList index={index} suggestions={suggestions} readOnly={ctx.readOnly} onOpen={k => { focusOn(k); }} onMerge={(a, b) => setMerge({ a, b })} onDistinct={doDistinct} />
      </section> : <>
        <div className="inv-panes">
          <section className="inv-pane">
            <div className="inv-pane-head"><h3>Connections</h3><small className="muted">Solid: graph links · dashed: listed together</small></div>
            <ConnectionsDiagram center={entity} connections={conns.shown} total={conns.total} activeKey={link?.key || ''} onFocus={focusOn} onLink={c => { setLink(l => (l?.key === c.key ? null : c)); setTab('records'); }} />
          </section>
          <section className="inv-pane inv-map">
            <div className="inv-pane-head"><h3>Map</h3><small className="muted">{placed.length} of {shown.length} record{shown.length === 1 ? '' : 's'} have coordinates</small></div>
            <InteractiveMap events={placed.map(r => r.record)} similarIds={[]} selectedId={selected} fit={fit} compact showCountries showCasualties={false} basemap={basemap} pickMode={false}
              onSelect={select} onOpen={id => ctx.openRecord(id, records.find(r => r.record.id === id)?.boardId)} onPick={() => {}} onStatus={() => {}} />
          </section>
        </div>
        <section className="inv-pane">
          <div className="inv-pane-head"><h3>Timeline</h3><small className="muted">Click a record to select it on the map and in the list</small></div>
          <TimelineStrip items={timeline} undated={shown.length - timeline.length} selectedId={selected} onSelect={select} />
        </section>
        {selectedRow && <section className="inv-pane inv-selected">
          <RecordSummary e={selectedRow.record} compact onEdit={() => ctx.openRecord(selectedRow.record.id, selectedRow.boardId)} />
          <div className="inv-selected-foot"><small className="muted">{selectedRow.role} · {boardName(selectedRow.boardId)}</small><button className="button subtle small" onClick={() => ctx.openRecord(selectedRow.record.id, selectedRow.boardId)}>Open record</button></div>
        </section>}
        <section className="inv-pane">
          <div className="ops-tabs inv-tabs" role="tablist">
            {([['records', `Records (${shown.length})`, Globe2], ['sources', `Sources (${sources.length})`, BookOpen], ['folders', `Folders (${folderItems.length})`, Folder], ['boards', `Appears on (${boards.length})`, ScanSearch]] as const).map(([k, label, Icon]) =>
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon size={13} /> {label}</button>)}
          </div>
          {link && <div className="inv-link-filter">
            <span>{link.graph.length > 0 && <>{link.graph.map((g, i) => <span key={i}>{boardName(g.boardId)}: {g.outgoing ? `${entity.name} → ${g.relation} → ${link.name}` : `${link.name} → ${g.relation} → ${entity.name}`}. </span>)}</>}
              {link.shared.length > 0 ? <>Showing the {link.shared.length} record{link.shared.length === 1 ? '' : 's'} with {entity.name} and {link.name}: {LISTED_TOGETHER(link.shared.length)}.</> : <>No records list both.</>}</span>
            <button className="button subtle small" onClick={() => setLink(null)}><X size={12} /> Show all</button>
          </div>}
          {tab === 'records' && <div className="inv-rows">{shown.map(r => <button key={`${r.boardId}:${r.record.id}`} className={'inv-row' + (r.record.id === selected ? ' on' : '')} onClick={() => select(r.record.id)} onDoubleClick={() => ctx.openRecord(r.record.id, r.boardId)}>
            <span><b>{r.record.name || 'Untitled record'}</b><small>{formatDateRange(r.record)} · {r.role}{boards.length > 1 ? ` · ${boardName(r.boardId)}` : ''}{hasCoords(r.record) ? '' : ' · not on map'}</small></span><VerificationBadge value={r.record.verification} />
          </button>)}{!shown.length && <p className="muted small">No records mention this entity yet.</p>}</div>}
          {tab === 'sources' && <div className="inv-rows">{sources.map((s, i) => <div className="inv-row" key={i}>
            <span><b>{httpsOnly(s.evidence.url) ? <a href={s.evidence.url} target="_blank" rel="noreferrer">{s.evidence.title || s.evidence.url}</a> : s.evidence.title || s.evidence.url}</b><small>{[s.evidence.publisher, s.evidence.publishedDate, s.evidence.sourceType].filter(Boolean).join(' · ')}</small></span><small>supports {s.count} record{s.count === 1 ? '' : 's'}</small>
          </div>)}{!sources.length && <p className="muted small">None of this entity's records has a source yet.</p>}</div>}
          {tab === 'folders' && <div className="inv-rows">{folderItems.map(f => <div className="inv-row" key={f.item.id}>
            <span><b>{httpsOnly(f.item.url || '') ? <a href={f.item.url} target="_blank" rel="noreferrer">{f.item.name}</a> : f.item.name}</b><small>{f.folder} · {boardName(f.boardId)} · {f.item.kind || 'note'}</small></span>
          </div>)}{!folderItems.length && <p className="muted small">No folder material is linked to this entity's nodes. Link it from the Folders view.</p>}</div>}
          {tab === 'boards' && <div className="inv-rows">{boards.map(b => {
            const nodes = entity.nodes.filter(n => n.boardId === b).length, recs = entity.records.filter(r => r.boardId === b).length;
            return <div className="inv-row" key={b}><span><b>{boardName(b)}</b><small>{recs} record{recs === 1 ? '' : 's'} · {nodes} node{nodes === 1 ? '' : 's'}</small></span>
              <button className="button subtle small" onClick={() => { ctx.setFocus(focusFor(entity)); ctx.selectBoard(b); ctx.setView(nodes ? 'Graph' : 'World'); }}>Open</button></div>;
          })}</div>}
        </section>
      </>}
    </div>
    {merge && <MergeDialog index={index} a={merge.a} initial={merge.b} onClose={() => setMerge(null)} onMerge={(b, name) => doMerge(merge.a, b, name)} />}
  </section>;
}

