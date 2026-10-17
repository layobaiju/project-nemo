import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileUp, OctagonAlert, Shield } from 'lucide-react';
import type { Board, DatasetMeta, EventItem, ImportBatch, Project, RecordLink } from '../types.ts';
import { LICENSES, emptyDataset, fnv1a, formatDateRange, hasCoords, nowIso, today, uid } from '../model.ts';
import {
  FIELDS, IMPORT_SUPPORT_OPTIONS, LARGE_IMPORT, MAX_IMPORT, PRESETS, UCDP_DATASET, autoMapping, buildAtlasCandidates, buildCandidates,
  detectPreset, detectSource, rowsFromSource, summarize, type Candidate, type Detected, type PresetKey, type RowFilter,
} from '../importer.ts';
import { download, templateCSV } from '../exporters.ts';
import { Field, IssueList, Modal, Select } from './ui.tsx';

export type ImportResult = { target: { boardId: string } | { newBoardName: string }; records: EventItem[]; links: RecordLink[]; batch: ImportBatch };

type Props = { project: Project; currentBoard: Board; onImport: (r: ImportResult) => void; onRestore: (projects: any[]) => void; onClose: () => void };
const PAGE = 200;

export default function ImportWizard({ project, currentBoard, onImport, onRestore, onClose }: Props) {
  const [batchId] = useState(() => uid());
  const textRef = useRef('');
  const [fileName, setFileName] = useState('');
  const [detected, setDetected] = useState<Detected | null>(null);
  const [preset, setPreset] = useState<PresetKey>('generic');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<RowFilter>({ from: '', to: '', contains: '' });
  const [cap, setCap] = useState(LARGE_IMPORT);
  const [dataset, setDataset] = useState<DatasetMeta>(emptyDataset());
  const [supports, setSupports] = useState<string[]>(['title', 'date', 'location']);
  const [confirmed, setConfirmed] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [stats, setStats] = useState<{ read: number; matched: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [page, setPage] = useState(0);
  const [target, setTarget] = useState<string>('new');
  const [newBoardName, setNewBoardName] = useState('');

  const headers = detected?.kind === 'csv' || detected?.kind === 'rows' ? detected.headers : [];
  const ownResearch = dataset.license.startsWith('My own research');
  const licenseOk = !!dataset.license && dataset.license !== 'Unknown' && (dataset.license !== 'Other (describe in notes)' || !!dataset.notes.trim());
  const provenanceOk = licenseOk && !!dataset.name.trim() && confirmed;
  const sum = candidates ? summarize(candidates) : null;
  const invalidate = () => { setCandidates(null); setStats(null); setPage(0); };

  const readFile = async (file?: File) => {
    if (!file) return;
    invalidate();
    setBusy(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`);
    try {
      const text = await file.text();
      const d = detectSource(file.name, text);
      setFileName(file.name);
      setDetected(d);
      if (d.kind === 'csv' || d.kind === 'rows') {
        const p = detectPreset(d.headers);
        setPreset(p);
        setMapping(autoMapping(d.headers));
        if (p === 'ucdp-ged') { setDataset({ ...UCDP_DATASET, accessedDate: today() }); setSupports(IMPORT_SUPPORT_OPTIONS.map(([k]) => k)); }
        else setDataset({ ...emptyDataset(), name: file.name.replace(/\.[^.]+$/, '') });
      } else if (d.kind === 'atlas-records') {
        setPreset('atlas-records');
        setDataset({ ...emptyDataset(), ...(d.dataset || {}), name: d.dataset?.name || `Atlas export – ${file.name}`, license: d.dataset?.license || '' });
      }
      setNewBoardName(`Import – ${file.name.replace(/\.[^.]+$/, '')} – ${today()}`);
      textRef.current = text;
    } catch (e) {
      setDetected({ kind: 'error', message: (e as Error).message });
    } finally { setBusy(''); }
  };

  const buildPreview = () => {
    if (!detected) return;
    setBusy('Validating records and checking for duplicates…');
    setTimeout(() => {
      try {
        const ctx = { dataset, supports, batchId, preset, ownResearch };
        if (detected.kind === 'atlas-records') {
          setCandidates(buildAtlasCandidates(detected.records.slice(0, MAX_IMPORT), project.boards, batchId));
          setStats({ read: detected.records.length, matched: detected.records.length });
        } else {
          const r = rowsFromSource(detected, filter, mapping, preset, Math.min(cap, MAX_IMPORT));
          setStats({ read: r.read, matched: r.matched });
          setCandidates(buildCandidates(r.rows, preset, mapping, ctx, project.boards));
        }
        setPage(0);
      } finally { setBusy(''); }
    }, 30);
  };

  const setInclude = (fn: (c: Candidate) => boolean | null) => setCandidates(cs => cs && cs.map(c => {
    const v = fn(c);
    return v == null || (v && c.issues.some(i => i.level === 'error')) ? c : { ...c, include: v };
  }));

  const runImport = () => {
    if (!candidates || !detected) return;
    const included = candidates.filter(c => c.include);
    const existing = new Set(project.boards.flatMap(b => b.events.map(e => e.id)));
    const idMap = new Map<string, string>();
    const records = included.map(c => {
      let r: EventItem = { ...c.record, nodeId: undefined };
      if (existing.has(r.id)) { const n = uid(); idMap.set(r.id, n); r = { ...r, id: n }; }
      existing.add(r.id);
      if (c.duplicate) r = { ...r, provenance: { ...r.provenance, possibleDuplicateOf: `${c.duplicate.existingId} – ${c.duplicate.text}` } };
      return r;
    });
    const ids = new Set(records.map(r => r.id));
    const links: RecordLink[] = detected.kind === 'atlas-records'
      ? (detected.links as RecordLink[]).map(l => ({ ...l, id: uid(), a: idMap.get(l.a) || l.a, b: idMap.get(l.b) || l.b })).filter(l => ids.has(l.a) && ids.has(l.b))
      : [];
    const text = textRef.current;
    const batch: ImportBatch = {
      id: batchId, importedAt: nowIso(), fileName, fingerprint: `${fnv1a(text.slice(0, 1_000_000))}:${text.length}`,
      format: detected.kind === 'csv' ? 'csv' : detected.kind === 'rows' ? detected.format : 'atlas-json', preset, dataset,
      rowsRead: stats?.read || candidates.length, imported: records.length, skipped: candidates.length - records.length,
      flaggedDuplicates: included.filter(c => c.duplicate).length,
    };
    textRef.current = '';
    onImport({ target: target === 'new' ? { newBoardName: newBoardName.trim() || `Import ${today()}` } : { boardId: target }, records, links, batch });
  };

  const visible = useMemo(() => candidates?.slice(page * PAGE, (page + 1) * PAGE) || [], [candidates, page]);

  return <Modal title="Import research records" eyebrow="DATA IMPORT" onClose={onClose} wide="xl" footer={<>
    <span className="fx-footer-status">{sum ? <span>{sum.included} of {sum.total} selected{sum.duplicates ? ` · ${sum.duplicates} possible duplicates` : ''}{sum.errors ? ` · ${sum.errors} with errors` : ''}</span> : <span>Nothing is imported until you confirm.</span>}</span>
    <button className="button subtle" onClick={onClose}>Cancel</button>
    <button className="button primary" disabled={!sum || !sum.included || !provenanceOk || !!busy} onClick={runImport}>Import {sum?.included || 0} record{sum?.included === 1 ? '' : 's'}</button>
  </>}>
    <div className="imp">
      <section className="imp-step">
        <h3><span>1</span> Choose a file</h3>
        <p className="muted">CSV, JSON, GeoJSON, or an Atlas export. Files are read in this browser and sent to your Windows host only when you import. Existing records are never overwritten.</p>
        <div className="imp-row">
          <label className="button primary file-button"><FileUp size={14} /> Choose file<input type="file" accept=".csv,.tsv,.txt,.json,.geojson,application/json,text/csv" onChange={e => readFile(e.target.files?.[0])} /></label>
          <button className="button subtle" onClick={() => download('atlas-import-template.csv', 'text/csv;charset=utf-8', '﻿' + templateCSV())}><Download size={13} /> CSV template</button>
          {fileName && <span className="imp-file">{fileName}{detected?.kind === 'csv' ? ` · about ${detected.estimate.toLocaleString('en-US')} rows` : detected?.kind === 'rows' ? ` · ${detected.rows.length.toLocaleString('en-US')} ${detected.format === 'geojson' ? 'point features' : 'items'}${detected.skipped ? ` (${detected.skipped} non-point skipped)` : ''}` : detected?.kind === 'atlas-records' ? ` · ${detected.records.length} Atlas records` : ''}</span>}
        </div>
        <details className="imp-help"><summary>Using UCDP GED (free, CC BY 4.0)</summary>
          <p>Download the GED CSV from <a href="https://ucdp.uu.se/downloads/" target="_blank" rel="noreferrer">ucdp.uu.se/downloads</a> (no account or key needed; the UCDP API itself requires a token, so Atlas uses the file). Atlas detects GED columns, keeps UCDP’s low/best/high fatality estimates as estimates, labels sides as “as coded”, and stores the dataset citation on every record. The full file is large: filter by date or country below and import in batches.</p>
        </details>
        {busy && <div className="imp-busy">{busy}</div>}
        {detected?.kind === 'error' && <div className="imp-error"><OctagonAlert size={14} /> {detected.message}</div>}
        {detected?.kind === 'atlas-backup' && <div className="imp-note"><AlertTriangle size={14} /> This is a full workspace backup ({detected.projects.length} project{detected.projects.length === 1 ? '' : 's'}). Use the restore preview so nothing is overwritten. <button className="button subtle" onClick={() => onRestore(detected.projects)}>Open restore preview</button></div>}
      </section>

      {(detected?.kind === 'csv' || detected?.kind === 'rows') && <section className="imp-step">
        <h3><span>2</span> Columns and filters</h3>
        <div className="fx-grid four">
          <Field label="Format preset" wide><Select value={preset} onChange={v => { setPreset(v as PresetKey); invalidate(); if (v === 'ucdp-ged') { setDataset({ ...UCDP_DATASET, accessedDate: today() }); setSupports(IMPORT_SUPPORT_OPTIONS.map(([k]) => k)); } }} options={PRESETS.map(p => p.key)} labels={Object.fromEntries(PRESETS.map(p => [p.key, p.label]))} /></Field>
          <Field label="Only from date" hint="YYYY or YYYY-MM-DD"><input value={filter.from} onChange={e => { setFilter({ ...filter, from: e.target.value }); invalidate(); }} placeholder="e.g. 1995" /></Field>
          <Field label="Only to date"><input value={filter.to} onChange={e => { setFilter({ ...filter, to: e.target.value }); invalidate(); }} placeholder="e.g. 1999" /></Field>
          <Field label="Only rows containing" hint="Any column, e.g. a country"><input value={filter.contains} onChange={e => { setFilter({ ...filter, contains: e.target.value }); invalidate(); }} /></Field>
          <Field label="Maximum records" hint={`Up to ${MAX_IMPORT.toLocaleString('en-US')}`}><input type="number" min={1} max={MAX_IMPORT} value={cap} onChange={e => { setCap(Math.max(1, Math.min(MAX_IMPORT, Number(e.target.value) || 1))); invalidate(); }} /></Field>
        </div>
        {preset !== 'ucdp-ged' && <div className="imp-mapping">
          {FIELDS.map(f => <label key={f.key}><span>{f.label}</span><select value={mapping[f.key] || ''} onChange={e => { setMapping({ ...mapping, [f.key]: e.target.value }); invalidate(); }}><option value="">— not in file —</option>{headers.map(h => <option key={h} value={h}>{h}</option>)}</select></label>)}
        </div>}
        {preset === 'ucdp-ged' && <p className="muted">GED columns are mapped automatically: conflict type, sides (as coded), dates and date precision, location and location precision, low/best/high and per-side deaths, and the cited source headline.</p>}
      </section>}

      {detected && (detected.kind === 'csv' || detected.kind === 'rows' || detected.kind === 'atlas-records') && <section className="imp-step">
        <h3><span>3</span> Provenance and license</h3>
        <div className="fx-grid four">
          <Field label="Dataset / collection name" wide><input value={dataset.name} onChange={e => { setDataset({ ...dataset, name: e.target.value }); invalidate(); }} /></Field>
          <Field label="Version"><input value={dataset.version} onChange={e => { setDataset({ ...dataset, version: e.target.value }); invalidate(); }} placeholder={preset === 'ucdp-ged' ? 'e.g. 26.1' : ''} /></Field>
          <Field label="Accessed"><input value={dataset.accessedDate} onChange={e => { setDataset({ ...dataset, accessedDate: e.target.value }); invalidate(); }} /></Field>
          <Field label="Publisher"><input value={dataset.publisher} onChange={e => { setDataset({ ...dataset, publisher: e.target.value }); invalidate(); }} /></Field>
          <Field label="Source URL"><input value={dataset.url} onChange={e => { setDataset({ ...dataset, url: e.target.value }); invalidate(); }} placeholder="https://" /></Field>
          <Field label="License"><Select value={dataset.license} onChange={v => { setDataset({ ...dataset, license: v }); invalidate(); }} options={['', ...LICENSES]} /></Field>
          <div />
          <Field label="Citation / attribution text" wide><textarea rows={2} value={dataset.citation} onChange={e => { setDataset({ ...dataset, citation: e.target.value }); invalidate(); }} /></Field>
          <Field label="Notes" hint={dataset.license === 'Other (describe in notes)' ? 'Describe the license terms' : ''} wide><textarea rows={2} value={dataset.notes} onChange={e => { setDataset({ ...dataset, notes: e.target.value }); invalidate(); }} /></Field>
        </div>
        {detected.kind !== 'atlas-records' && <div className="fx-supports"><span>Sources in this file support:</span>{IMPORT_SUPPORT_OPTIONS.map(([k, label]) => <button key={k} type="button" className={'fx-chip toggle' + (supports.includes(k) ? ' on' : '')} aria-pressed={supports.includes(k)} onClick={() => { setSupports(s => s.includes(k) ? s.filter(x => x !== k) : [...s, k]); invalidate(); }}>{label}</button>)}</div>}
        {dataset.license === 'Unknown' && <div className="imp-error"><OctagonAlert size={14} /> Atlas will not import data with an unknown license. Check the publisher’s terms first.</div>}
        <label className="imp-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I have checked that I may use this data under the license above, and I will keep the attribution with it.</label>
      </section>}

      {detected && detected.kind !== 'error' && detected.kind !== 'atlas-backup' && <section className="imp-step">
        <h3><span>4</span> Validate and review</h3>
        <div className="imp-row">
          <button className="button primary" disabled={!!busy || !dataset.name.trim()} onClick={buildPreview}>{candidates ? 'Rebuild preview' : 'Build preview'}</button>
          {stats && <span className="muted">{stats.read.toLocaleString('en-US')} rows read · {stats.matched.toLocaleString('en-US')} matched filters{stats.matched > (candidates?.length || 0) ? ` · first ${candidates?.length.toLocaleString('en-US')} kept (raise the maximum or narrow filters)` : ''}</span>}
        </div>
        {sum && <>
          <div className="imp-summary">
            <span><CheckCircle2 size={13} /> {sum.total - sum.errors - sum.duplicates} ready</span>
            <span className="warn"><AlertTriangle size={13} /> {sum.warnings} with warnings</span>
            <span className="warn">{sum.duplicates} possible duplicates (excluded by default)</span>
            <span className="err"><OctagonAlert size={13} /> {sum.errors} with errors (cannot import)</span>
            <span>{sum.unplaced} without coordinates</span>
          </div>
          {sum.total > LARGE_IMPORT && <div className="imp-note"><AlertTriangle size={14} /> Large imports make saving slower on every device. Consider several smaller boards.</div>}
          <div className="imp-row">
            <button className="button subtle" onClick={() => setInclude(c => !c.duplicate)}>Select all valid, skip duplicates</button>
            <button className="button subtle" onClick={() => setInclude(c => (c.duplicate ? true : null))}>Also include duplicates (flagged)</button>
            <button className="button subtle" onClick={() => setInclude(() => false)}>Select none</button>
          </div>
          <div className="imp-table-wrap"><table className="imp-table">
            <thead><tr><th /><th>Row</th><th>Title</th><th>Date</th><th>Place / coordinates</th><th>Sources</th><th>Checks</th></tr></thead>
            <tbody>{visible.map(c => {
              const err = c.issues.some(i => i.level === 'error');
              return <tr key={c.line} className={err ? 'err' : c.duplicate ? 'dup' : ''}>
                <td><input type="checkbox" aria-label={`Include row ${c.line}`} disabled={err} checked={c.include} onChange={e => setCandidates(cs => cs && cs.map(x => x === c ? { ...x, include: e.target.checked } : x))} /></td>
                <td>{c.line}</td>
                <td><b>{c.record.name || '(untitled)'}</b><small>{c.record.category}{c.record.classification ? ` · ${c.record.classification}` : ''}</small></td>
                <td>{formatDateRange(c.record)}</td>
                <td>{c.record.place || '—'}<small>{hasCoords(c.record) ? `${c.record.latitude.toFixed(4)}, ${c.record.longitude.toFixed(4)}` : 'no coordinates'}</small></td>
                <td>{c.record.evidence.length}</td>
                <td>{c.duplicate && <div className="dup-text">{c.duplicate.text}</div>}<IssueList issues={c.issues} max={3} /></td>
              </tr>;
            })}</tbody>
          </table></div>
          {candidates!.length > PAGE && <div className="imp-row"><button className="button subtle" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button><span className="muted">Rows {page * PAGE + 1}–{Math.min((page + 1) * PAGE, candidates!.length)} of {candidates!.length}</span><button className="button subtle" disabled={(page + 1) * PAGE >= candidates!.length} onClick={() => setPage(p => p + 1)}>Next</button></div>}
          <div className="fx-grid four">
            <Field label="Import into"><select value={target} onChange={e => setTarget(e.target.value)}><option value="new">A new board (recommended)</option>{project.boards.map(b => <option key={b.id} value={b.id}>{b.name}{b.id === currentBoard.id ? ' (current)' : ''}</option>)}</select></Field>
            {target === 'new' && <Field label="New board name" wide><input value={newBoardName} onChange={e => setNewBoardName(e.target.value)} /></Field>}
          </div>
          {!provenanceOk && <div className="imp-note"><Shield size={14} /> Complete step 3 (dataset name, a known license, and the confirmation) to enable import.</div>}
        </>}
      </section>}
    </div>
  </Modal>;
}
