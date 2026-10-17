import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
import type { EventItem, RecordLink } from '../types.ts';
import { formatDateRange } from '../model.ts';
import { DEFAULT_FACTORS, FACTORS, SIMILARITY_CAVEAT, findSimilar, type FactorKey, type Match } from '../similarity.ts';

type Props = {
  selected?: EventItem;
  pool: EventItem[];
  scope: 'board' | 'project';
  setScope: (s: 'board' | 'project') => void;
  links: RecordLink[];
  onMatches: (ids: string[]) => void;
  onSelect: (id: string) => void;
  onLink: (other: EventItem, m: Match, note: string, alsoGraph: boolean) => void;
};

export default function SimilarityPanel({ selected, pool, scope, setScope, links, onMatches, onSelect, onLink }: Props) {
  const [threshold, setThreshold] = useState(35);
  const [factors, setFactors] = useState<FactorKey[]>(DEFAULT_FACTORS);
  const [open, setOpen] = useState<string>('');
  const [note, setNote] = useState('');
  const [alsoGraph, setAlsoGraph] = useState(true);
  const [showFactors, setShowFactors] = useState(false);
  const matches = useMemo(() => (selected ? findSimilar(selected, pool, factors, threshold) : []), [selected, pool, factors, threshold]);
  const ids = matches.map(m => m.event.id).join(',');
  useEffect(() => onMatches(ids ? ids.split(',') : []), [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const linked = (id: string) => links.some(l => (l.a === selected?.id && l.b === id) || (l.b === selected?.id && l.a === id));

  return <div className="similarity-panel">
    <label>Minimum score <b>{threshold}</b><input type="range" min="10" max="90" step="5" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>
    <div className="sim-scope"><button className={scope === 'board' ? 'on' : ''} onClick={() => setScope('board')}>This board</button><button className={scope === 'project' ? 'on' : ''} onClick={() => setScope('project')}>All boards in project</button></div>
    <button className="text-button" onClick={() => setShowFactors(x => !x)}>{showFactors ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Compared fields ({factors.length})</button>
    {showFactors && <div className="sim-factors">{FACTORS.map(f => <label key={f.key}><input type="checkbox" checked={factors.includes(f.key)} onChange={() => setFactors(x => x.includes(f.key) ? x.filter(k => k !== f.key) : [...x, f.key])} />{f.label} <small>weight {f.weight}</small></label>)}</div>}
    <p>{selected ? <>Compared with <b>{selected.name || 'selected record'}</b>. Missing data scores zero.</> : 'Select a marker or a record to compare it with others.'}</p>
    {matches.map(m => <article className="similarity-card" key={m.event.id}>
      <div><button className="link-like" onClick={() => onSelect(m.event.id)}>{m.event.name || 'Untitled'}</button><strong title={`Data coverage ${m.coverage}%`}>{m.score}</strong></div>
      <small>{m.event.place || 'No place'} · {formatDateRange(m.event)} · {m.event.verification} · compared {m.coverage}% of weighted fields</small>
      <ul>{m.reasons.map(r => <li key={r}>{r}</li>)}</ul>
      <details><summary>All factors</summary><ul className="muted">{m.factors.map(f => <li key={f.key}>{f.label}: {f.compared ? `${f.points}/${f.weight}` : 'not compared'} – {f.detail}</li>)}</ul></details>
      {linked(m.event.id) ? <small className="ok">Comparison link saved</small> : open === m.event.id ? <div className="sim-link-form">
        <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Why compare these? (optional)" />
        <label><input type="checkbox" checked={alsoGraph} onChange={e => setAlsoGraph(e.target.checked)} /> Also add both to this board’s graph</label>
        <small>The link is labelled “comparison (analyst-created)”. It does not claim the events are connected.</small>
        <div><button className="button subtle" onClick={() => setOpen('')}>Cancel</button><button className="button primary" onClick={() => { onLink(m.event, m, note, alsoGraph); setOpen(''); setNote(''); }}>Save comparison link</button></div>
      </div> : <button onClick={() => setOpen(m.event.id)}><Link2 size={12} /> Create comparison link…</button>}
    </article>)}
    {selected && !matches.length && <small>No records reach this score. Lower the minimum or add more detail (dates, coordinates, actors).</small>}
    <small className="similarity-caveat">{SIMILARITY_CAVEAT}</small>
  </div>;
}
