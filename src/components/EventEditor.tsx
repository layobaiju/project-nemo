import React, { useMemo, useState } from 'react';
import { BookOpen, Crosshair, ExternalLink, Link2, Plus, Shield, Trash2 } from 'lucide-react';
import type { EventItem, Evidence, RecordLink } from '../types.ts';
import {
  ACTOR_ROLES, ACTOR_TYPES, ATTRIBUTION, ATTRIBUTION_HELP, CASUALTY_METRICS, CATEGORIES, CLASSIFICATIONS, CONFIDENCE, DATE_PRECISION,
  EQUIPMENT_STATUS, FIGURE_STATUS, LOCATION_PRECISION, POPULATIONS, RELIABILITY, SOURCE_TYPES, STANCE, VERIFICATION, VERIFICATION_HELP,
  emptyActor, emptyEquipment, emptyEvidence, emptyFigure, evidenceFor, nowIso, parseDateInput, recordIssues, supportOptions,
} from '../model.ts';
import { Field, IssueList, ListInput, Modal, Select, Tag, VerificationBadge, numOrNull } from './ui.tsx';

const TABS = ['Record', 'Place & time', 'Actors', 'Casualties', 'Equipment', 'Sources', 'Assessment', 'Provenance'] as const;
type Tab = typeof TABS[number];

type Props = {
  initial: EventItem; isNew: boolean;
  links: (RecordLink & { otherName: string })[];
  onSave: (e: EventItem) => void; onCancel: () => void; onDelete?: () => void;
  onPickLocation?: (draft: EventItem) => void;
};

export default function EventEditor({ initial, isNew, links, onSave, onCancel, onDelete, onPickLocation }: Props) {
  const [e, setE] = useState<EventItem>(() => structuredClone(initial));
  const [tab, setTab] = useState<Tab>('Record');
  const set = <K extends keyof EventItem>(k: K, v: EventItem[K]) => setE(x => ({ ...x, [k]: v }));
  const issues = useMemo(() => recordIssues(e), [e]);
  const errors = issues.filter(i => i.level === 'error');
  const options = supportOptions(e);
  const sourceCount = (key: string) => evidenceFor(e, key).length;

  const updateList = <K extends 'actors' | 'casualties' | 'equipment' | 'evidence'>(k: K, id: string, patch: Partial<EventItem[K][number]>) =>
    setE(x => ({ ...x, [k]: (x[k] as any[]).map(it => (it.id === id ? { ...it, ...patch } : it)) }));
  const toggleSupport = (id: string, k: string) => setE(x => ({ ...x, evidence: x.evidence.map(s => (s.id !== id ? s : { ...s, supports: s.supports.includes(k) ? s.supports.filter(y => y !== k) : [...s.supports, k] })) }));
  const removeFrom = (k: 'actors' | 'casualties' | 'equipment' | 'evidence', id: string) =>
    setE(x => ({ ...x, [k]: (x[k] as any[]).filter(it => it.id !== id), evidence: k === 'evidence' ? x.evidence.filter(s => s.id !== id) : x.evidence.map(s => ({ ...s, supports: s.supports.filter(r => !r.endsWith(`:${id}`)) })) }));

  const finish = () => {
    const d1 = parseDateInput(e.date), d2 = parseDateInput(e.endDate);
    const out: EventItem = {
      ...e, name: e.name.trim(), date: d1.ok ? d1.value : e.date, endDate: d2.ok ? d2.value : e.endDate,
      sources: e.evidence.map(s => s.url || s.title).filter(Boolean),
      provenance: { ...e.provenance, createdAt: e.provenance.createdAt || nowIso(), updatedAt: nowIso(), origin: e.provenance.origin || 'manual' },
    };
    onSave(out);
  };
  const tabCount: Partial<Record<Tab, number>> = { Actors: e.actors.length, Casualties: e.casualties.length, Equipment: e.equipment.length, Sources: e.evidence.length };

  const footer = <>
    <span className="fx-footer-status">{errors.length ? <b className="err">{errors.length} to fix before saving</b> : issues.length ? <span>{issues.length} note{issues.length > 1 ? 's' : ''} to review</span> : <span className="ok">Ready to save</span>}</span>
    {onDelete && !isNew && <button className="button danger" onClick={() => { if (confirm(`Delete “${e.name || 'this record'}”? This cannot be undone (host backups keep earlier versions).`)) onDelete(); }}><Trash2 size={13} /> Delete</button>}
    <button className="button subtle" onClick={onCancel}>Cancel</button>
    <button className="button primary" disabled={errors.length > 0} onClick={finish}>{isNew ? 'Create record' : 'Save record'}</button>
  </>;

  return <Modal title={isNew ? 'New research record' : e.name || 'Research record'} eyebrow="EVENT / RECORD" onClose={onCancel} wide="xl" footer={footer}>
    <nav className="fx-tabs" role="tablist">{TABS.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}{tabCount[t] ? <i>{tabCount[t]}</i> : null}</button>)}</nav>
    <div className="fx-tabbody">
      {tab === 'Record' && <div className="fx-grid">
        <Field label="Title" hint="Neutral, factual wording" wide><input autoFocus value={e.name} onChange={x => set('name', x.target.value)} placeholder="e.g. Bridge closure in Town X" /></Field>
        <Field label="Category"><Select value={e.category} onChange={v => set('category', v)} options={CATEGORIES} /></Field>
        <Field label="Classification" hint="Conflict / incident type"><Select value={e.classification} onChange={v => set('classification', v)} options={CLASSIFICATIONS} /></Field>
        <Field label="Conflict or wider context name" wide><input value={e.conflictName} onChange={x => set('conflictName', x.target.value)} placeholder="Optional; as named by your sources" /></Field>
        <Field label="Description" hint="What happened, attributed to sources. Keep interpretations in Assessment." wide><textarea rows={5} value={e.description} onChange={x => set('description', x.target.value)} placeholder="According to [source], …" /></Field>
        <Field label="Tags" wide><ListInput value={e.tags} onChange={v => set('tags', v)} placeholder="Type and press Enter" /></Field>
      </div>}

      {tab === 'Place & time' && <div className="fx-grid">
        <Field label="Start date" hint="YYYY, YYYY-MM or YYYY-MM-DD"><input value={e.date} onChange={x => set('date', x.target.value)} placeholder="YYYY-MM-DD" inputMode="numeric" /></Field>
        <Field label="End date" hint="Optional, for ranges"><input value={e.endDate} onChange={x => set('endDate', x.target.value)} placeholder="YYYY-MM-DD" inputMode="numeric" /></Field>
        <Field label="Date precision"><Select value={e.datePrecision} onChange={v => set('datePrecision', v)} options={['', ...DATE_PRECISION]} /></Field>
        <Field label="Place name" wide><input value={e.place} onChange={x => set('place', x.target.value)} placeholder="Town, district, country" /></Field>
        <Field label="Latitude" hint="-90 to 90"><input type="number" step="any" value={e.latitude ?? ''} onChange={x => set('latitude', numOrNull(x.target.value) ?? undefined)} /></Field>
        <Field label="Longitude" hint="-180 to 180"><input type="number" step="any" value={e.longitude ?? ''} onChange={x => set('longitude', numOrNull(x.target.value) ?? undefined)} /></Field>
        <Field label="Location precision"><Select value={e.locationPrecision} onChange={v => set('locationPrecision', v)} options={LOCATION_PRECISION} /></Field>
        {onPickLocation && <div className="fx-inline-action"><button className="button subtle" onClick={() => onPickLocation({ ...e })}><Crosshair size={13} /> Pick on globe</button><small>Keeps your edits, then click the map to set coordinates.</small></div>}
        <Field label="Countries / regions involved" hint="As named in sources" wide><ListInput value={e.countries} onChange={v => set('countries', v)} placeholder="Type a name and press Enter" /></Field>
      </div>}

      {tab === 'Actors' && <div className="fx-stack">
        <p className="form-note"><Shield size={14} /> Record actors as your sources describe them. Use the attribution status to keep allegations, claims and confirmed findings apart. Link supporting sources in the Sources tab.</p>
        {e.actors.map(a => <article key={a.id} className="fx-item">
          <div className="fx-grid four">
            <Field label="Name"><input value={a.name} onChange={x => updateList('actors', a.id, { name: x.target.value })} /></Field>
            <Field label="Type"><Select value={a.type} onChange={v => updateList('actors', a.id, { type: v })} options={ACTOR_TYPES} /></Field>
            <Field label="Role in record"><Select value={a.role} onChange={v => updateList('actors', a.id, { role: v })} options={ACTOR_ROLES} /></Field>
            <Field label="Attribution status"><Select value={a.attribution} onChange={v => updateList('actors', a.id, { attribution: v })} options={ATTRIBUTION} /></Field>
            <Field label="Note" wide><input value={a.note} onChange={x => updateList('actors', a.id, { note: x.target.value })} placeholder="e.g. who alleged it, disputed by whom" /></Field>
          </div>
          <div className="fx-item-foot"><small>{ATTRIBUTION_HELP[a.attribution]}</small><SourceBadge n={sourceCount(`actor:${a.id}`)} /><button className="text-button danger" onClick={() => removeFrom('actors', a.id)}><Trash2 size={12} /> Remove</button></div>
        </article>)}
        <button className="add-board" onClick={() => set('actors', [...e.actors, emptyActor()])}><Plus size={13} /> Add actor or organisation</button>
      </div>}

      {tab === 'Casualties' && <div className="fx-stack">
        <p className="form-note"><Shield size={14} /> Enter figures exactly as a source reports them. Use low / best / high for uncertainty, state what is counted (definition), and do not add up figures from different sources.</p>
        {e.casualties.map(c => <article key={c.id} className="fx-item">
          <div className="fx-grid four">
            <Field label="Metric"><Select value={c.metric} onChange={v => updateList('casualties', c.id, { metric: v })} options={CASUALTY_METRICS} /></Field>
            <Field label="Population"><Select value={c.population} onChange={v => updateList('casualties', c.id, { population: v })} options={POPULATIONS} /></Field>
            <Field label="Status"><Select value={c.status} onChange={v => updateList('casualties', c.id, { status: v })} options={FIGURE_STATUS} /></Field>
            <div />
            <Field label="Low"><input type="number" min={0} inputMode="numeric" value={c.low ?? ''} onChange={x => updateList('casualties', c.id, { low: numOrNull(x.target.value) })} /></Field>
            <Field label="Best estimate"><input type="number" min={0} inputMode="numeric" value={c.best ?? ''} onChange={x => updateList('casualties', c.id, { best: numOrNull(x.target.value) })} /></Field>
            <Field label="High"><input type="number" min={0} inputMode="numeric" value={c.high ?? ''} onChange={x => updateList('casualties', c.id, { high: numOrNull(x.target.value) })} /></Field>
            <div />
            <Field label="Definition" hint="What is counted, by whom, over what period" wide><input value={c.definition} onChange={x => updateList('casualties', c.id, { definition: x.target.value })} placeholder="e.g. Deaths reported by [source] as of [date]; includes…" /></Field>
          </div>
          <div className="fx-item-foot"><Tag tone={c.status === 'Confirmed' ? 'fact' : c.status === 'Disputed' ? 'warn' : 'estimate'}>{c.status}</Tag><SourceBadge n={sourceCount(`casualty:${c.id}`)} /><button className="text-button danger" onClick={() => removeFrom('casualties', c.id)}><Trash2 size={12} /> Remove</button></div>
        </article>)}
        <button className="add-board" onClick={() => set('casualties', [...e.casualties, emptyFigure()])}><Plus size={13} /> Add casualty figure</button>
      </div>}

      {tab === 'Equipment' && <div className="fx-stack">
        <p className="form-note"><Shield size={14} /> Reference equipment that sources identify, for historical documentation. Do not record operational or targeting detail.</p>
        {e.equipment.map(q => <article key={q.id} className="fx-item">
          <div className="fx-grid four">
            <Field label="Name / designation"><input value={q.name} onChange={x => updateList('equipment', q.id, { name: x.target.value })} /></Field>
            <Field label="Type"><input value={q.type} onChange={x => updateList('equipment', q.id, { type: x.target.value })} placeholder="e.g. aircraft, vehicle" /></Field>
            <Field label="Status"><Select value={q.status} onChange={v => updateList('equipment', q.id, { status: v })} options={EQUIPMENT_STATUS} /></Field>
            <Field label="Note"><input value={q.note} onChange={x => updateList('equipment', q.id, { note: x.target.value })} /></Field>
          </div>
          <div className="fx-item-foot"><span /><SourceBadge n={sourceCount(`equipment:${q.id}`)} /><button className="text-button danger" onClick={() => removeFrom('equipment', q.id)}><Trash2 size={12} /> Remove</button></div>
        </article>)}
        <button className="add-board" onClick={() => set('equipment', [...e.equipment, emptyEquipment()])}><Plus size={13} /> Add equipment reference</button>
      </div>}

      {tab === 'Sources' && <div className="fx-stack">
        <p className="form-note"><BookOpen size={14} /> Each source must say which fields or items it supports and the specific claim it makes. Sources that contradict a field are kept, and shown as contradicting.</p>
        {e.evidence.map((s, i) => <EvidenceCard key={s.id} s={s} index={i} options={options} onChange={p => updateList('evidence', s.id, p)} onToggle={k => toggleSupport(s.id, k)} onRemove={() => removeFrom('evidence', s.id)} />)}
        <button className="add-board" onClick={() => set('evidence', [...e.evidence, emptyEvidence()])}><Plus size={13} /> Add source</button>
      </div>}

      {tab === 'Assessment' && <div className="fx-grid">
        <Field label="Verification status"><Select value={e.verification} onChange={v => set('verification', v)} options={VERIFICATION} /></Field>
        <Field label="Analyst confidence"><Select value={e.confidence} onChange={v => set('confidence', v)} options={CONFIDENCE} /></Field>
        <div className="fx-help wide"><VerificationBadge value={e.verification} /> {VERIFICATION_HELP[e.verification]}</div>
        <Field label="Attribution uncertainty" hint="Who is said to be responsible, by whom, and what is disputed" wide><textarea rows={3} value={e.attributionNote} onChange={x => set('attributionNote', x.target.value)} /></Field>
        <Field label="Analyst notes / interpretation" hint="Your reasoning. Shown separately from evidence." wide><textarea rows={4} value={e.analystNotes} onChange={x => set('analystNotes', x.target.value)} /></Field>
        <div className="fx-legend wide"><b>How Atlas keeps statements apart</b><span><Tag tone="fact">Fact</Tag> a field supported by linked sources</span><span><Tag tone="allegation">Allegation / claim</Tag> actor attribution Alleged, Suspected, Claimed or Disputed</span><span><Tag tone="estimate">Estimate</Tag> casualty figures with status Estimate or Reported</span><span><Tag tone="interpretation">Interpretation</Tag> analyst notes</span></div>
      </div>}

      {tab === 'Provenance' && <div className="fx-stack">
        <dl className="fx-dl">
          <dt>Origin</dt><dd>{e.provenance.origin === 'import' ? 'Imported' : e.provenance.origin === 'legacy' ? 'Created in an earlier Atlas version' : 'Entered manually'}</dd>
          {e.provenance.dataset && <><dt>Dataset</dt><dd>{e.provenance.datasetUrl ? <a href={e.provenance.datasetUrl} target="_blank" rel="noreferrer">{e.provenance.dataset} <ExternalLink size={11} /></a> : e.provenance.dataset}</dd></>}
          {e.provenance.datasetLicense && <><dt>License</dt><dd>{e.provenance.datasetLicense}</dd></>}
          {e.provenance.originalId && <><dt>Original record ID</dt><dd>{e.provenance.originalId}</dd></>}
          {e.provenance.importBatchId && <><dt>Import batch</dt><dd>{e.provenance.importBatchId}</dd></>}
          {e.provenance.possibleDuplicateOf && <><dt>Flagged</dt><dd>Imported despite a possible duplicate ({e.provenance.possibleDuplicateOf})</dd></>}
          <dt>Created</dt><dd>{e.provenance.createdAt || 'unknown'}</dd>
          <dt>Last edited</dt><dd>{e.provenance.updatedAt || 'unknown'}</dd>
          <dt>Atlas ID</dt><dd>{e.id}</dd>
        </dl>
        <h4 className="fx-subhead"><Link2 size={13} /> Comparison links</h4>
        {links.length ? links.map(l => <div key={l.id} className="fx-link"><b>{l.otherName}</b><small>{l.score}% match · {l.reasons.slice(0, 2).join('; ')}</small>{l.note && <em>{l.note}</em>}</div>) : <small className="muted">No comparison links. Create them from the similarity panel on the World view.</small>}
        <small className="muted">Comparison links record that an analyst compared two records. They do not indicate coordination, shared responsibility, causation or a common actor.</small>
      </div>}
    </div>
    <IssueList issues={issues} max={8} />
  </Modal>;
}

function SourceBadge({ n }: { n: number }) {
  return n ? <Tag tone="fact">{n} source{n > 1 ? 's' : ''}</Tag> : <Tag tone="warn">Unsourced</Tag>;
}

function EvidenceCard({ s, index, options, onChange, onToggle, onRemove }: { s: Evidence; index: number; options: [string, string][]; onChange: (p: Partial<Evidence>) => void; onToggle: (k: string) => void; onRemove: () => void }) {
  return <article className="fx-item">
    <div className="fx-item-head"><b>Source {index + 1}</b>{s.url && /^https?:\/\//i.test(s.url) && <a href={s.url} target="_blank" rel="noreferrer">Open <ExternalLink size={11} /></a>}<button className="text-button danger" onClick={onRemove}><Trash2 size={12} /> Remove</button></div>
    <div className="fx-grid four">
      <Field label="Title" wide><input value={s.title} onChange={x => onChange({ title: x.target.value })} placeholder="Report or article title" /></Field>
      <Field label="Publisher / author"><input value={s.publisher} onChange={x => onChange({ publisher: x.target.value })} /></Field>
      <Field label="Type"><Select value={s.sourceType} onChange={v => onChange({ sourceType: v })} options={SOURCE_TYPES} /></Field>
      <Field label="URL" wide><input type="url" value={s.url} onChange={x => onChange({ url: x.target.value })} placeholder="https://" /></Field>
      <Field label="Published"><input value={s.publishedDate} onChange={x => onChange({ publishedDate: x.target.value })} placeholder="YYYY-MM-DD" /></Field>
      <Field label="Accessed"><input value={s.accessedDate} onChange={x => onChange({ accessedDate: x.target.value })} placeholder="YYYY-MM-DD" /></Field>
      <Field label="Specific claim supported" hint="What this source says about the record" wide><textarea rows={2} value={s.claim} onChange={x => onChange({ claim: x.target.value })} placeholder="e.g. Reports that the closure began on 3 May and lists 12 injured (hospital figures)." /></Field>
      <Field label="Stance"><Select value={s.stance} onChange={v => onChange({ stance: v })} options={STANCE} /></Field>
      <Field label="Source reliability"><Select value={s.reliability} onChange={v => onChange({ reliability: v })} options={RELIABILITY} /></Field>
    </div>
    <div className="fx-supports"><span>Supports these fields / items:</span>{options.map(([k, label]) => <button key={k} type="button" className={'fx-chip toggle' + (s.supports.includes(k) ? ' on' : '')} aria-pressed={s.supports.includes(k)} onClick={() => onToggle(k)}>{label}</button>)}</div>
    <div className="fx-grid four">
      <Field label="License / terms" hint="If you store excerpts"><input value={s.license} onChange={x => onChange({ license: x.target.value })} /></Field>
      <Field label="Notes" wide><input value={s.notes} onChange={x => onChange({ notes: x.target.value })} /></Field>
    </div>
  </article>;
}
