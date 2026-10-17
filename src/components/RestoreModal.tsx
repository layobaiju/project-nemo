import { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Project } from '../types.ts';
import { normalizeProjects, today, uid } from '../model.ts';
import { Modal } from './ui.tsx';

/** Restores projects from a backup without ever replacing existing ones: matching IDs become copies. */
export default function RestoreModal({ incoming, existing, onRestore, onClose }: { incoming: any[]; existing: Project[]; onRestore: (projects: Project[]) => void; onClose: () => void }) {
  const projects = useMemo(() => normalizeProjects(incoming), [incoming]);
  const ids = new Set(existing.map(p => p.id));
  const [choice, setChoice] = useState<Record<string, 'copy' | 'skip' | 'add'>>(() => Object.fromEntries(projects.map(p => [p.id, ids.has(p.id) ? 'skip' : 'add'])));
  const restore = () => {
    const out = projects.filter(p => choice[p.id] !== 'skip').map(p => choice[p.id] === 'copy' ? { ...p, id: uid(), name: `${p.name} (restored ${today()})` } : p);
    onRestore(out);
  };
  const count = projects.filter(p => choice[p.id] !== 'skip').length;
  return <Modal title="Restore from backup" eyebrow="WORKSPACE BACKUP" onClose={onClose} wide footer={<><span className="fx-footer-status">{count} project{count === 1 ? '' : 's'} will be added</span><button className="button subtle" onClick={onClose}>Cancel</button><button className="button primary" disabled={!count} onClick={restore}>Restore</button></>}>
    <p className="form-note"><AlertTriangle size={14} /> Existing projects are never replaced. A project whose ID already exists can be skipped or added as a separate copy. The host also keeps automatic backups in <code>data/backups</code>.</p>
    <div className="restore-list">{projects.map(p => {
      const records = p.boards.reduce((n, b) => n + b.events.length, 0);
      const exists = ids.has(p.id);
      return <article key={p.id}>
        <span><b>{p.name}</b><small>{p.boards.length} board{p.boards.length === 1 ? '' : 's'} · {records} record{records === 1 ? '' : 's'}{exists ? ' · a project with this ID already exists' : ''}</small></span>
        <select value={choice[p.id]} onChange={e => setChoice({ ...choice, [p.id]: e.target.value as any })}>
          {!exists && <option value="add">Add</option>}
          {exists && <option value="copy">Add as a copy</option>}
          <option value="skip">Skip</option>
        </select>
      </article>;
    })}</div>
  </Modal>;
}
