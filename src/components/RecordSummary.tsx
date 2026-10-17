import { ExternalLink, Pencil } from 'lucide-react';
import type { EventItem } from '../types.ts';
import { evidenceFor, formatDateRange, formatFigure, hasCoords, recordIssues, supportLabel } from '../model.ts';
import { IssueList, Tag, VerificationBadge } from './ui.tsx';

const attributionTone = (a: string) => (a === 'Confirmed' ? 'fact' : a === 'Unknown' || a === 'Coded by dataset' ? 'muted' : 'allegation');

/** Read-only view that keeps facts, allegations, estimates and interpretation visibly apart. */
export default function RecordSummary({ e, onEdit, compact }: { e: EventItem; onEdit?: () => void; compact?: boolean }) {
  const issues = recordIssues(e).filter(i => i.level !== 'info');
  const n = (key: string) => evidenceFor(e, key).length;
  return <article className="rec-summary">
    <header><div><b>{e.name || 'Untitled record'}</b><small>{e.category}{e.classification ? ` · ${e.classification}` : ''}</small></div>{onEdit && <button className="icon-action" aria-label="Edit record" onClick={onEdit}><Pencil size={13} /></button>}</header>
    <div className="rec-meta"><VerificationBadge value={e.verification} /><Tag tone="muted">Confidence: {e.confidence}</Tag>{e.provenance.dataset && <Tag tone="muted">{e.provenance.dataset}</Tag>}</div>
    <dl>
      <dt>When</dt><dd>{formatDateRange(e)}{e.datePrecision ? ` (${e.datePrecision.toLowerCase()})` : ''} {n('date') ? <Tag tone="fact">{n('date')} src</Tag> : null}</dd>
      <dt>Where</dt><dd>{e.place || 'Not specified'}{hasCoords(e) ? ` · ${e.latitude.toFixed(3)}, ${e.longitude.toFixed(3)}` : ' · not on globe'}{e.locationPrecision !== 'Unknown' ? ` (${e.locationPrecision})` : ''} {n('location') ? <Tag tone="fact">{n('location')} src</Tag> : null}</dd>
      {e.countries.length > 0 && <><dt>Countries</dt><dd>{e.countries.join(', ')}</dd></>}
    </dl>
    {e.description && !compact && <p className="rec-desc">{e.description}</p>}
    {e.actors.length > 0 && <section><h5>Actors (as recorded)</h5>{e.actors.map(a => <div key={a.id} className="rec-line"><span>{a.name} <small>{a.type} · {a.role}</small></span><Tag tone={attributionTone(a.attribution)}>{a.attribution}</Tag>{n(`actor:${a.id}`) ? <Tag tone="fact">{n(`actor:${a.id}`)} src</Tag> : <Tag tone="warn">no source</Tag>}</div>)}</section>}
    {e.casualties.length > 0 && <section><h5>Casualty figures</h5>{e.casualties.map(c => <div key={c.id} className="rec-line col"><span>{c.metric} · {c.population}: <b>{formatFigure(c)}</b> <Tag tone={c.status === 'Confirmed' ? 'fact' : c.status === 'Disputed' ? 'warn' : 'estimate'}>{c.status}</Tag>{n(`casualty:${c.id}`) ? <Tag tone="fact">{n(`casualty:${c.id}`)} src</Tag> : <Tag tone="warn">no source</Tag>}</span>{c.definition && <small>{c.definition}</small>}</div>)}</section>}
    {e.equipment.length > 0 && !compact && <section><h5>Equipment references</h5>{e.equipment.map(q => <div key={q.id} className="rec-line"><span>{q.name} <small>{q.type}</small></span><Tag tone={q.status === 'Confirmed' ? 'fact' : 'allegation'}>{q.status}</Tag></div>)}</section>}
    {e.attributionNote && <section><h5>Attribution uncertainty</h5><p className="rec-desc">{e.attributionNote}</p></section>}
    {e.analystNotes && !compact && <section><h5><Tag tone="interpretation">Interpretation</Tag> Analyst notes</h5><p className="rec-desc">{e.analystNotes}</p></section>}
    <section><h5>Sources ({e.evidence.length})</h5>{e.evidence.length ? e.evidence.slice(0, compact ? 3 : 50).map(s => <div key={s.id} className="rec-source">
      <span>{s.url && /^https?:\/\//i.test(s.url) ? <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url} <ExternalLink size={10} /></a> : s.title || s.url}{s.stance === 'Contradicts' && <Tag tone="warn">contradicts</Tag>}</span>
      <small>{[s.publisher, s.publishedDate, s.sourceType, s.reliability !== 'Not assessed' ? s.reliability : ''].filter(Boolean).join(' · ')}</small>
      {s.claim && <em>“{s.claim}”</em>}
      <small className="muted">Supports: {s.supports.length ? s.supports.map(k => supportLabel(e, k)).join('; ') : 'not linked to a field'}</small>
    </div>) : <small className="muted">No sources yet.</small>}{compact && e.evidence.length > 3 && <small className="muted">+{e.evidence.length - 3} more</small>}</section>
    <IssueList issues={issues} max={compact ? 3 : 10} />
  </article>;
}
