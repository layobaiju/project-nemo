// Merging entities on the Investigate page. Merges are link-only: records and nodes keep their own wording.
import { useMemo, useState } from 'react';
import { Ban, GitMerge, Search, Shield } from 'lucide-react';
import type { DuplicateSuggestion, Entity, EntityIndex } from '../entities.ts';
import { matchesQuery } from '../model.ts';
import { Modal } from './ui.tsx';
import { KIND_COLORS } from './InvestigatePanes.tsx';

const counts = (e: Entity) => `${e.records.length} record${e.records.length === 1 ? '' : 's'} · ${e.nodes.length} node${e.nodes.length === 1 ? '' : 's'}`;
const REASON: Record<DuplicateSuggestion['reason'], string> = {
  spelling: 'Spelled almost the same',
  contains: 'One name contains the other',
  'same-name': 'Same name as a Wikidata entity; not linked automatically because several share it',
};

function EntityCard({ e }: { e: Entity }) {
  return <div className="inv-merge-card">
    <i style={{ background: KIND_COLORS[e.kind] }} />
    <b>{e.name}</b>
    <small>{e.kind}{e.qids.length ? ` · ${e.qids.join(', ')}` : ''}</small>
    <small>{counts(e)}</small>
    {e.aliases.length > 0 && <small className="muted">Also: {e.aliases.slice(0, 4).join(', ')}{e.aliases.length > 4 ? '…' : ''}</small>}
  </div>;
}

export function MergeDialog({ index, a, initial, onMerge, onClose }: { index: EntityIndex; a: Entity; initial?: Entity; onMerge: (b: Entity, name: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [b, setB] = useState<Entity | undefined>(initial);
  const candidates = useMemo(() => index.entities.filter(e => e.family === a.family && e !== a && matchesQuery([e.name, ...e.aliases].join(' '), q))
    .sort((x, y) => y.mentions.length - x.mentions.length).slice(0, 30), [index, a, q]);
  const names = b ? [...new Set([a.name, b.name, ...a.aliases, ...b.aliases])] : [];
  const preferred = b ? (a.qids.length || (!b.qids.length && a.mentions.length >= b.mentions.length) ? a.name : b.name) : '';
  const [name, setName] = useState('');
  const chosen = names.includes(name) ? name : preferred;
  return <Modal title={`Merge “${a.name}” with…`} eyebrow="INVESTIGATE" onClose={onClose} wide
    footer={<><button className="button subtle" onClick={onClose}>Cancel</button><button className="button primary" disabled={!b} onClick={() => b && onMerge(b, chosen)}><GitMerge size={13} /> Merge</button></>}>
    <div className="inv-merge">
      {!initial && <>
        <div className="searchbox"><Search size={14} /><input autoFocus aria-label="Find the entity to merge with" placeholder={`Find another ${a.family === 'actor' ? 'person or organisation' : a.family}…`} value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="inv-merge-list">{candidates.map(e => <button key={e.key} className={e === b ? 'on' : ''} onClick={() => { setB(e); setName(''); }}><i style={{ background: KIND_COLORS[e.kind] }} /><span><b>{e.name}</b><small>{e.kind} · {counts(e)}</small></span></button>)}
          {!candidates.length && <small className="muted">No {a.family === 'actor' ? 'people or organisations' : `${a.family}s`} match.</small>}</div>
      </>}
      {b && <>
        <div className="inv-merge-pair"><EntityCard e={a} /><GitMerge size={16} /><EntityCard e={b} /></div>
        <fieldset className="inv-merge-names"><legend>Name to show</legend>
          {names.map(n => <label key={n}><input type="radio" name="inv-merge-name" checked={chosen === n} onChange={() => setName(n)} /> {n}</label>)}
        </fieldset>
      </>}
      <div className="tip"><Shield size={14} /><span>Records and nodes keep their own wording; every spelling is listed as an alias. <b>Unmerge</b> splits them again.</span></div>
    </div>
  </Modal>;
}

export function DuplicatesList({ index, suggestions, readOnly, onOpen, onMerge, onDistinct }: {
  index: EntityIndex; suggestions: DuplicateSuggestion[]; readOnly: boolean;
  onOpen: (key: string) => void; onMerge: (a: Entity, b: Entity) => void; onDistinct: (a: Entity, b: Entity) => void;
}) {
  const rows = suggestions.map(s => ({ s, a: index.byKey.get(s.a)!, b: index.byKey.get(s.b)! })).filter(r => r.a && r.b);
  if (!rows.length) return <p className="muted small">No likely duplicates. Atlas suggests names spelled almost the same, names inside other names, and plain names shared by several Wikidata entities.</p>;
  return <div className="inv-dups">
    <div className="tip"><Shield size={14} /><span>Suggestions only. Nothing is merged unless you choose <b>Merge</b>; <b>Not the same</b> hides the pair for good.</span></div>
    {rows.map(({ s, a, b }) => <div className="inv-dup" key={`${s.a}|${s.b}`}>
      <small className="inv-dup-reason">{REASON[s.reason]}</small>
      <div className="inv-dup-names">
        <button className="text-button" onClick={() => onOpen(a.key)}>{a.name}</button><small>{a.kind} · {counts(a)}</small>
        <button className="text-button" onClick={() => onOpen(b.key)}>{b.name}</button><small>{b.kind} · {counts(b)}</small>
      </div>
      <div className="inv-dup-actions">
        <button className="button subtle small" disabled={readOnly} onClick={() => onDistinct(a, b)}><Ban size={12} /> Not the same</button>
        <button className="button primary small" disabled={readOnly} onClick={() => onMerge(a, b)}><GitMerge size={12} /> Merge…</button>
      </div>
    </div>)}
  </div>;
}
