import { useState } from 'react';
import { ChevronRight, Download, ExternalLink, Folder, FolderPlus, Image, Link2, Pencil, StickyNote, Trash2 } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import type { FolderItem } from '../types.ts';
import { matchesQuery, nowIso, uid } from '../model.ts';
import { Field, Modal } from './ui.tsx';

/** App-managed folders (not Windows folders). Materials link to any number of graph nodes and records. */
export default function FoldersView({ ctx, folderId, setFolderId, openDrawing }: { ctx: Ctx; folderId: string; setFolderId: (id: string) => void; openDrawing: () => void }) {
  const { board } = ctx;
  const [editing, setEditing] = useState<{ item: FolderItem; folderId: string } | null>(null);
  const folder = board.folders.find(f => f.id === folderId) || board.folders[0];

  const addFolder = () => {
    const name = prompt('Folder name', 'New folder');
    if (!name) return;
    const f = { id: uid(), name: name.trim() || 'New folder', items: [] };
    ctx.patchBoard(b => ({ ...b, folders: [...b.folders, f] }));
    setFolderId(f.id);
  };
  const renameFolder = () => { if (!folder) return; const name = prompt('Rename folder', folder.name); if (name?.trim()) ctx.patchBoard(b => ({ ...b, folders: b.folders.map(f => (f.id === folder.id ? { ...f, name: name.trim() } : f)) })); };
  const deleteFolder = () => {
    if (!folder) return;
    if (folder.items.length && !confirm(`Delete “${folder.name}” and its ${folder.items.length} item(s)? Host backups keep the earlier version.`)) return;
    ctx.patchBoard(b => ({ ...b, folders: b.folders.filter(f => f.id !== folder.id) }));
  };
  const newItem = (kind: 'note' | 'link') => {
    if (!folder) { ctx.notify('Create a folder first.'); return; }
    setEditing({ folderId: folder.id, item: { id: uid(), name: kind === 'link' ? 'Reference link' : 'Untitled note', kind, body: '', url: '', nodeIds: [], recordIds: [], createdAt: nowIso() } });
  };
  const saveItem = (item: FolderItem, targetFolder: string) => {
    ctx.patchBoard(b => ({ ...b, folders: b.folders.map(f => {
      const without = f.items.filter(i => i.id !== item.id);
      return f.id === targetFolder ? { ...f, items: [...without, item] } : { ...f, items: without };
    }) }));
    setEditing(null);
  };
  const deleteItem = (item: FolderItem) => {
    if (!confirm(`Delete “${item.name}”?`)) return;
    ctx.patchBoard(b => ({ ...b, folders: b.folders.map(f => ({ ...f, items: f.items.filter(i => i.id !== item.id) })) }));
    setEditing(null);
  };
  const icon = (i: FolderItem) => (i.kind === 'drawing' ? <Image size={16} /> : i.kind === 'link' ? <Link2 size={16} /> : <StickyNote size={16} />);

  return <section className="content">
    <div className="view-heading"><div><div className="eyebrow">PROJECT LIBRARY · {board.name.toUpperCase()}</div><h1>Virtual folders</h1><p>Folders managed inside Atlas (stored on the Windows host, not in Windows Explorer). Each item can link to several graph nodes and records.</p></div>
      <div className="actions"><button className="button subtle" onClick={openDrawing} disabled={ctx.readOnly}><Pencil size={14} /> Sketch</button><button className="button primary" onClick={addFolder} disabled={ctx.readOnly}><FolderPlus size={15} /> New folder</button></div></div>
    <div className="folder-workspace">
      <aside className="folder-list"><b>THIS BOARD</b>
        {board.folders.map(f => <button className={folder?.id === f.id ? 'selected' : ''} key={f.id} onClick={() => setFolderId(f.id)}><Folder size={16} /><span>{f.name}<small>{f.items.length} item{f.items.length === 1 ? '' : 's'}</small></span><ChevronRight size={14} /></button>)}
        {!board.folders.length && <p>Create a folder to begin.</p>}
      </aside>
      <section className="folder-detail">
        <div className="panel-head"><div><h2>{folder?.name || 'Choose a folder'}</h2><p>{folder ? `${folder.items.length} items` : ''}</p></div>
          {folder && <div className="actions"><button className="button subtle" onClick={() => newItem('note')} disabled={ctx.readOnly}><StickyNote size={14} /> Note</button><button className="button subtle" onClick={() => newItem('link')} disabled={ctx.readOnly}><Link2 size={14} /> Link</button><button className="button subtle" onClick={renameFolder} disabled={ctx.readOnly}>Rename</button><button className="button subtle" onClick={deleteFolder} disabled={ctx.readOnly}><Trash2 size={13} /></button></div>}
        </div>
        <div className="folder-items">{folder?.items.map(i => <button className="folder-item" key={i.id} onClick={() => setEditing({ item: i, folderId: folder.id })}>
          {i.kind === 'drawing' && i.imageData ? <img src={i.imageData} alt="" className="thumb" /> : icon(i)}
          <span><b>{i.name}</b><small>{i.kind}{i.body ? ` · ${i.body.slice(0, 80)}` : ''}{i.url ? ` · ${i.url}` : ''}</small></span>
          {(i.nodeIds?.length || 0) + (i.recordIds?.length || 0) > 0 && <em>{i.nodeIds?.length || 0} node{i.nodeIds?.length === 1 ? '' : 's'} · {i.recordIds?.length || 0} record{i.recordIds?.length === 1 ? '' : 's'}</em>}
          <ChevronRight size={13} />
        </button>)}
          {folder && !folder.items.length && <p className="muted small">Empty folder. Add a note, a reference link, or a sketch.</p>}
        </div>
      </section>
    </div>
    {editing && <ItemEditor ctx={ctx} item={editing.item} folderId={editing.folderId} onSave={saveItem} onDelete={deleteItem} onClose={() => setEditing(null)} />}
  </section>;
}

function ItemEditor({ ctx, item, folderId, onSave, onDelete, onClose }: { ctx: Ctx; item: FolderItem; folderId: string; onSave: (i: FolderItem, f: string) => void; onDelete: (i: FolderItem) => void; onClose: () => void }) {
  const { board } = ctx;
  const [draft, setDraft] = useState<FolderItem>({ ...item, nodeIds: item.nodeIds || [], recordIds: item.recordIds || [] });
  const [target, setTarget] = useState(folderId);
  const [recQuery, setRecQuery] = useState('');
  const toggle = (k: 'nodeIds' | 'recordIds', id: string) => setDraft(d => ({ ...d, [k]: d[k]!.includes(id) ? d[k]!.filter(x => x !== id) : [...d[k]!, id] }));
  const exists = board.folders.some(f => f.items.some(i => i.id === item.id));
  const records = board.events.filter(e => draft.recordIds!.includes(e.id) || (recQuery.trim() && matchesQuery(e.name, recQuery))).slice(0, 40);
  return <Modal title={draft.name || 'Item'} eyebrow={`FOLDER ITEM · ${draft.kind?.toUpperCase()}`} onClose={onClose} wide footer={<>
    <span className="fx-footer-status" />
    {exists && <button className="button danger" disabled={ctx.readOnly} onClick={() => onDelete(item)}><Trash2 size={13} /> Delete</button>}
    <button className="button subtle" onClick={onClose}>Cancel</button>
    <button className="button primary" disabled={ctx.readOnly} onClick={() => onSave(draft, target)}>Save</button>
  </>}>
    <div className="fx-stack">
      <Field label="Title"><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field>
      {draft.kind === 'drawing' && draft.imageData && <div className="drawing-preview"><img src={draft.imageData} alt={draft.name} /><a className="button subtle" href={draft.imageData} download={`${draft.name || 'sketch'}.png`}><Download size={13} /> Download PNG</a></div>}
      {draft.kind !== 'drawing' && <Field label="URL" hint="Optional reference"><input type="url" value={draft.url || ''} onChange={e => setDraft({ ...draft, url: e.target.value })} placeholder="https://" /></Field>}
      {draft.url && /^https?:\/\//i.test(draft.url) && <a href={draft.url} target="_blank" rel="noreferrer" className="text-button">Open link <ExternalLink size={11} /></a>}
      <Field label="Notes"><textarea rows={6} value={draft.body || ''} onChange={e => setDraft({ ...draft, body: e.target.value })} /></Field>
      <Field label="Folder"><select value={target} onChange={e => setTarget(e.target.value)}>{board.folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>
      <label className="field-caption">LINKED GRAPH NODES</label>
      <div className="check-list">{board.nodes.length ? board.nodes.map(n => <label key={n.id}><input type="checkbox" checked={draft.nodeIds!.includes(n.id)} onChange={() => toggle('nodeIds', n.id)} />{String((n.data as any)?.label || n.id)}<small>{String((n.data as any)?.kind || '')}</small></label>) : <small className="muted">This board has no graph nodes yet.</small>}</div>
      <label className="field-caption">LINKED RECORDS</label>
      <input className="plain-input" placeholder="Search records to link…" value={recQuery} onChange={e => setRecQuery(e.target.value)} />
      <div className="check-list">{records.map(e => <label key={e.id}><input type="checkbox" checked={draft.recordIds!.includes(e.id)} onChange={() => toggle('recordIds', e.id)} />{e.name || 'Untitled'}<small>{e.date || 'undated'}</small></label>)}{!records.length && <small className="muted">Type to find records on this board.</small>}</div>
    </div>
  </Modal>;
}
