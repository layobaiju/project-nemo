import { useMemo, useState } from 'react';
import { Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { ArrowDownToLine, BookOpen, Check, ChevronDown, Globe2, Link2, Network, Pencil, Plus, Search, Settings2, Shield, Sparkles, Trash2, Wand2, X } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { CONFIDENCE, VERIFICATION, hasCoords, matchesQuery, uid } from '../model.ts';
import { CARDINALITIES, NODE_KINDS, edgeLabel, layoutCircle, layoutGrid, layoutLayered, makeEdge, makeNode, nodeSearchText, recordNode, suggestLinks, type LinkSuggestion } from '../graph.ts';
import { download, projectJSON, safeName } from '../exporters.ts';
import { Field, Select } from './ui.tsx';
import SearchAround, { type LastExpansion } from './SearchAround.tsx';

const nodeTypes = {
  research: ({ data, selected }: any) => <div className={'research-node ' + (selected ? 'selected' : '') + (data.recordId ? ' record' : '')}>
    <Handle type="target" position={Position.Left} />
    <div className="node-top"><span>{data.recordId ? <Globe2 size={13} /> : data.kind === 'Source' ? <BookOpen size={13} /> : <Network size={13} />}</span>{data.kind}<i>{data.confidence}</i></div>
    <b>{data.label}</b><p>{data.detail}</p>
    {data.materials ? <small className="node-materials">{data.materials} linked material{data.materials > 1 ? 's' : ''}</small> : null}
    <Handle type="source" position={Position.Right} />
  </div>,
};

export default function GraphView({ ctx, openDrawing }: { ctx: Ctx; openDrawing: () => void }) {
  const { board, project } = ctx;
  const [query, setQuery] = useState('');
  const [cardinality, setCardinality] = useState('many-to-many');
  const [relation, setRelation] = useState('related to');
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  const [suggestions, setSuggestions] = useState<LinkSuggestion[] | null>(null);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [lastExpansion, setLastExpansion] = useState<LastExpansion>(null);
  const nodes = board.nodes, edges = board.edges;
  const materialsByNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of board.folders) for (const i of f.items) for (const n of i.nodeIds || []) m.set(n, (m.get(n) || 0) + 1);
    return m;
  }, [board.folders]);
  // An entity opened from Investigate: its nodes are ringed and the rest dimmed (display only, never saved).
  const focusHits = useMemo(() => { const ids = new Set(ctx.focus?.nodeIds || []); return nodes.filter(n => ids.has(n.id)).map(n => n.id); }, [ctx.focus, nodes]);
  const shownNodes = useMemo(() => {
    const hits = new Set(focusHits);
    return nodes.map(n => ({ ...n, hidden: !matchesQuery(nodeSearchText(n), query), ...(hits.size ? { className: hits.has(n.id) ? 'focus-hit' : 'focus-dim' } : {}), data: { ...n.data, materials: materialsByNode.get(n.id) || 0 } }));
  }, [nodes, query, materialsByNode, focusHits]);
  const focusBoards = ctx.focus && !focusHits.length ? project.boards.filter(b => b.id !== board.id && b.nodes.some(n => ctx.focus!.nodeIds.includes(n.id))) : [];
  const matchCount = shownNodes.filter(n => !n.hidden).length;

  const setNodes = (fn: (ns: Node[]) => Node[]) => ctx.patchBoard(b => ({ ...b, nodes: fn(b.nodes) }));
  const setEdges = (fn: (es: Edge[]) => Edge[]) => ctx.patchBoard(b => ({ ...b, edges: fn(b.edges) }));
  // Board state is the single source of truth, so callbacks always target the board currently shown.
  const onNodesChange = (c: NodeChange[]) => { if (!ctx.readOnly) setNodes(ns => applyNodeChanges(c, ns).map(n => { const { materials, ...data } = n.data as any; return { ...n, data }; })); };
  const onEdgesChange = (c: EdgeChange[]) => { if (!ctx.readOnly) setEdges(es => applyEdgeChanges(c, es)); };
  const onConnect = (c: Connection) => setEdges(es => addEdge({ ...c, id: uid(), type: 'smoothstep', label: edgeLabel(relation, cardinality), data: { relation, cardinality } }, es));

  const addNode = (kind = 'Note') => {
    const id = uid();
    setNodes(ns => [...ns, makeNode(id, 120 + Math.random() * 280, 100 + Math.random() * 240, kind === 'Source' ? 'New source record' : 'New research item', kind)]);
    setSel({ kind: 'node', id });
  };
  const addRecords = () => {
    const missing = board.events.filter(e => !nodes.some(n => n.id === e.nodeId || (n.data as any)?.recordId === e.id)).slice(0, 200);
    if (!missing.length) { ctx.notify('Every record on this board already has a graph node.'); return; }
    const created = missing.map((e, i) => ({ e, node: recordNode(uid(), e, 80 + (i % 5) * 280, 80 + Math.floor(i / 5) * 180 + (nodes.length ? 400 : 0)) }));
    ctx.patchBoard(b => ({ ...b, nodes: [...b.nodes, ...created.map(c => c.node)], events: b.events.map(e => { const c = created.find(x => x.e.id === e.id); return c ? { ...e, nodeId: c.node.id } : e; }) }));
    ctx.notify(`Added ${created.length} record node${created.length > 1 ? 's' : ''}. No connections were created automatically.`);
  };
  const layout = (kind: 'grid' | 'layered' | 'circle') => { setLayoutOpen(false); setNodes(ns => kind === 'grid' ? layoutGrid(ns) : kind === 'circle' ? layoutCircle(ns) : layoutLayered(ns, edges)); };
  const acceptSuggestion = (s: LinkSuggestion) => {
    setEdges(es => [...es, makeEdge(s.source, s.target, `${s.relation} (suggested, reviewed)`, 'many-to-many', { style: { strokeDasharray: '4 4' } })]);
    setSuggestions(x => x && x.filter(y => y !== s));
  };

  const node = sel?.kind === 'node' ? nodes.find(n => n.id === sel.id) : undefined;
  const edge = sel?.kind === 'edge' ? edges.find(e => e.id === sel.id) : undefined;
  const nd = (node?.data || {}) as any, ed = (edge?.data || {}) as any;
  const patchNode = (p: Record<string, unknown>) => node && setNodes(ns => ns.map(n => (n.id === node.id ? { ...n, data: { ...n.data, ...p } } : n)));
  const patchEdge = (p: { relation?: string; cardinality?: string; note?: string }) => edge && setEdges(es => es.map(e => {
    if (e.id !== edge.id) return e;
    const data = { relation: ed.relation || String(e.label || '').split(' · ')[0] || 'related to', cardinality: ed.cardinality || 'many-to-many', ...e.data, ...p };
    return { ...e, data, label: edgeLabel(data.relation as string, data.cardinality as string) };
  }));
  const linkedMaterials = node ? board.folders.flatMap(f => f.items.filter(i => i.nodeIds?.includes(node.id)).map(i => ({ ...i, folder: f.name }))) : [];
  const record = node ? board.events.find(e => e.id === nd.recordId || e.nodeId === node.id) : undefined;

  return <div className="graph-view">
    <section className="canvas-column">
      <div className="view-heading">
        <div><div className="eyebrow">PROJECT BOARD / GRAPH</div><h1>{board.name}</h1><p>Entities, sources and ideas with explicit, labelled relationships.</p></div>
        <div className="actions">
          <button className="button subtle" onClick={addRecords} disabled={ctx.readOnly}><Globe2 size={14} /> Add records as nodes</button>
          <button className="button subtle" onClick={() => setSuggestions(suggestLinks(nodes, edges, project.boards.flatMap(b => b.events), project.boards.flatMap(b => b.links)))} disabled={ctx.readOnly}><Wand2 size={14} /> Suggest links</button>
          <div className="menu-wrap"><button className="button subtle" onClick={() => setLayoutOpen(x => !x)}><Sparkles size={14} /> Auto layout <ChevronDown size={12} /></button>
            {layoutOpen && <div className="menu" onMouseLeave={() => setLayoutOpen(false)}><button onClick={() => layout('layered')}><b>Layered</b><small>Follows connection direction</small></button><button onClick={() => layout('grid')}><b>Grid</b><small>Even spacing</small></button><button onClick={() => layout('circle')}><b>Circle</b><small>Shows cross-links clearly</small></button></div>}
          </div>
          <button className="button primary" onClick={() => addNode()} disabled={ctx.readOnly}><Plus size={15} /> Add node</button>
          <button className="icon-action" aria-label="Export project" onClick={() => download(`${safeName(project.name)}-project.json`, 'application/json', projectJSON(project))}><ArrowDownToLine size={15} /></button>
        </div>
      </div>
      <div className="canvas-toolbar">
        <div className="searchbox"><Search size={14} /><input placeholder="Find in board…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        {query.trim() && <span className="hint" role="status">{matchCount ? `${matchCount} of ${nodes.length} node${nodes.length === 1 ? '' : 's'} ${matchCount === 1 ? 'matches' : 'match'}` : `No node matches “${query.trim()}”`}</span>}
        <span className="hint">New connections:</span>
        <input className="relation-input" aria-label="Relationship label for new connections" value={relation} onChange={e => setRelation(e.target.value)} />
        <select aria-label="Cardinality for new connections" value={cardinality} onChange={e => setCardinality(e.target.value)}>{CARDINALITIES.map(x => <option key={x}>{x}</option>)}</select>
        <span className="saved"><i /> Stored on host</span>
      </div>
      {ctx.focus && <div className="focus-chip" role="status">
        <span>{focusHits.length ? <>Highlighting <b>{ctx.focus.label}</b>: {focusHits.length} node{focusHits.length === 1 ? '' : 's'} on this board.</> : <>None of <b>{ctx.focus.label}</b>’s nodes are on this board.</>}</span>
        {focusBoards.map(b => <button key={b.id} className="button subtle small" onClick={() => ctx.selectBoard(b.id)}>{b.name}</button>)}
        <button className="button subtle small" onClick={() => ctx.setFocus(null)}><X size={12} /> Clear</button>
      </div>}
      <div className="flow-wrap">
        <ReactFlow key={focusHits.length ? `focus-${ctx.focus?.n}` : 'flow'} fitViewOptions={focusHits.length ? { nodes: focusHits.map(id => ({ id })), padding: 0.6, maxZoom: 1.2 } : undefined} nodes={shownNodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} nodeTypes={nodeTypes}
          onNodeClick={(_, n) => setSel({ kind: 'node', id: n.id })} onEdgeClick={(_, e) => setSel({ kind: 'edge', id: e.id })} onPaneClick={() => setSel(null)}
          nodesDraggable={!ctx.readOnly} nodesConnectable={!ctx.readOnly} deleteKeyCode={ctx.readOnly ? null : ['Backspace', 'Delete']} fitView proOptions={{ hideAttribution: true }}
          connectionRadius={ctx.device === 'iPad' ? 40 : 20}>
          <Background color="#283447" gap={22} /><Controls /><MiniMap nodeColor="#6388b3" maskColor="rgba(8,11,17,.72)" pannable zoomable />
        </ReactFlow>
        {nodes.length === 0 && <div className="empty-canvas"><div className="empty-icon"><Network /></div><b>Your board starts here</b><span>Add a node, or turn this board’s records into nodes.</span><button className="button primary" onClick={() => addNode()}><Plus size={14} /> Add first node</button></div>}
        <div className="canvas-tools"><button onClick={openDrawing}><Pencil size={14} /> Sketch / Apple Pencil</button><button onClick={() => addNode('Source')}><BookOpen size={14} /> Add source node</button><button onClick={() => ctx.newRecord()}><Globe2 size={14} /> Add map record</button><span>{nodes.length} nodes · {edges.length} connections</span></div>
      </div>
    </section>
    <aside className="inspector">
      {suggestions ? <>
        <div className="inspector-title"><div><div className="eyebrow">REVIEW SUGGESTIONS</div><h3>{suggestions.length} possible links</h3></div><button className="icon-action" aria-label="Close suggestions" onClick={() => setSuggestions(null)}><X size={14} /></button></div>
        <div className="tip"><Shield size={14} /><span>Based on shared actors, sources, conflict names or saved comparisons. A shared attribute is a lead to check, not evidence of a relationship. Nothing is added unless you accept it.</span></div>
        {suggestions.map((s, i) => <div className="suggestion" key={i}><b>{String((nodes.find(n => n.id === s.source)?.data as any)?.label)} ↔ {String((nodes.find(n => n.id === s.target)?.data as any)?.label)}</b><small>{s.reason}</small><div><button className="button subtle" onClick={() => setSuggestions(x => x && x.filter(y => y !== s))}>Dismiss</button><button className="button primary" onClick={() => acceptSuggestion(s)}><Check size={12} /> Add link</button></div></div>)}
        {!suggestions.length && <p className="muted small">No suggestions. Add record nodes first (suggestions only use records with actors, sources or comparison links).</p>}
      </> : node ? <>
        <div className="inspector-title"><div><div className="eyebrow">NODE</div><h3>{String(nd.label)}</h3></div><button className="icon-action" aria-label="Close" onClick={() => setSel(null)}><X size={14} /></button></div>
        <div className="fx-stack">
          <Field label="Label"><input value={String(nd.label || '')} onChange={e => patchNode({ label: e.target.value })} /></Field>
          <Field label="Kind"><Select value={String(nd.kind || 'Note')} onChange={v => patchNode({ kind: v })} options={NODE_KINDS} /></Field>
          <Field label="Confidence / status"><Select value={String(nd.confidence || 'Unverified')} onChange={v => patchNode({ confidence: v })} options={[...new Set([...CONFIDENCE, ...VERIFICATION])]} /></Field>
          <Field label="Summary"><textarea rows={4} value={String(nd.detail || '')} onChange={e => patchNode({ detail: e.target.value })} /></Field>
          {record && <div className="linked-record"><Globe2 size={13} /><span><b>Linked record</b><small>{record.name}{hasCoords(record) ? '' : ' (not on globe)'}</small></span><button className="text-button" onClick={() => ctx.openRecord(record.id)}>Open</button></div>}
          <SearchAround ctx={ctx} node={node} last={lastExpansion} setLast={setLastExpansion} />
          <label className="field-caption">LINKED MATERIALS</label>
          {linkedMaterials.length ? linkedMaterials.map(m => <div key={m.id} className="linked-record"><BookOpen size={13} /><span><b>{m.name}</b><small>{m.folder} · {m.kind}</small></span></div>) : <small className="muted">None. Link materials from the Folders view.</small>}
          <button className="button danger" disabled={ctx.readOnly} onClick={() => { setNodes(ns => ns.filter(n => n.id !== node.id)); setEdges(es => es.filter(e => e.source !== node.id && e.target !== node.id)); setSel(null); }}><Trash2 size={13} /> Delete node</button>
        </div>
      </> : edge ? <>
        <div className="inspector-title"><div><div className="eyebrow">CONNECTION</div><h3>{String(edge.label || 'Connection')}</h3></div><button className="icon-action" aria-label="Close" onClick={() => setSel(null)}><X size={14} /></button></div>
        <div className="fx-stack">
          <Field label="Relationship"><input value={String(ed.relation ?? String(edge.label || '').split(' · ')[0])} onChange={e => patchEdge({ relation: e.target.value })} /></Field>
          <Field label="Cardinality" hint="How many of each side can take part"><Select value={String(ed.cardinality || 'many-to-many')} onChange={v => patchEdge({ cardinality: v })} options={CARDINALITIES} /></Field>
          <Field label="Note"><textarea rows={3} value={String(ed.note || '')} onChange={e => patchEdge({ note: e.target.value })} /></Field>
          {ed.origin === 'Wikidata' && <div className="tip"><Link2 size={14} /><span>Added by Search around from Wikidata statement {String(ed.property || '')}. Wikidata is community-edited: check the link against a source before relying on it.</span></div>}
          {ed.comparisonLinkId && <div className="tip"><Link2 size={14} /><span>Comparison link created from the similarity panel. It records an analyst comparison, not a connection between events.</span></div>}
          <button className="button danger" disabled={ctx.readOnly} onClick={() => { setEdges(es => es.filter(e => e.id !== edge.id)); setSel(null); }}><Trash2 size={13} /> Delete connection</button>
        </div>
      </> : <>
        <div className="inspector-title"><div><div className="eyebrow">BOARD DETAILS</div><h3>Workspace</h3></div><Settings2 size={15} /></div>
        <label className="field-caption">SUBPROJECTS / BOARDS</label>
        {project.boards.map(b => <button className={'board-card ' + (b.id === board.id ? 'selected' : '')} key={b.id} onClick={() => ctx.selectBoard(b.id)}><span>{b.kind === 'world' ? <Globe2 size={15} /> : <Network size={15} />}</span><span><b>{b.name}</b><small>{b.kind === 'world' ? 'World map' : 'Graph board'} · {b.events.length} records</small></span>{b.id === board.id && <i />}</button>)}
        <button className="add-board" onClick={() => ctx.addBoard()} disabled={ctx.readOnly}><Plus size={14} /> Add subproject</button>
        <label className="field-caption">CARDINALITY GUIDE</label>
        <div className="card-guide"><span><b>1:1</b> one-to-one</span><span><b>1:N</b> one-to-many</span><span><b>N:1</b> many-to-one</span><span><b>N:M</b> many-to-many</span></div>
        <div className="tip"><Shield size={14} /><span>Click a node or connection to edit it. Use source nodes for material claims; confidence labels are prompts to review, not proof.</span></div>
        <div className="stats"><b>BOARD SUMMARY</b><span>Nodes <strong>{nodes.length}</strong></span><span>Connections <strong>{edges.length}</strong></span><span>Records <strong>{board.events.length}</strong></span><span>Comparison links <strong>{board.links.length}</strong></span></div>
      </>}
    </aside>
  </div>;
}
