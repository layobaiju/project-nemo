import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, Clock3, FileUp, Folder, Globe2, KeyRound, Network, Plus, Search, Shield, Sparkles } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { VERIFICATION_COLORS, dateSpan, formatDateRange, hasCoords, matchesQuery, yearOf } from '../model.ts';
import { submitAccessCode } from '../api.ts';
import { Modal } from './ui.tsx';

export function AccessGate({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr('');
    try { const e = await submitAccessCode(code); if (e) setErr(e); else onDone(); } catch { setErr('Cannot reach the Windows host. Is Atlas running there?'); } finally { setBusy(false); }
  };
  return <div className="access-gate"><form onSubmit={e => { e.preventDefault(); submit(); }}>
    <span className="brand-mark big"><Globe2 size={22} /></span>
    <h1>Connect to the Atlas host</h1>
    <p>Enter the access code shown in the PowerShell window (or under Settings) on the Windows PC. You only need to do this once on this device.</p>
    <input autoFocus value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoCapitalize="characters" autoComplete="off" spellCheck={false} aria-label="Access code" />
    {err && <div className="imp-error">{err}</div>}
    <button className="button primary" disabled={busy || code.replace(/[^A-Z0-9]/gi, '').length < 8}><KeyRound size={14} /> Connect</button>
    <small><Shield size={12} /> The host only answers devices on your private network.</small>
  </form></div>;
}

const DEVICES: { key: string; label: string; w: number; h: number; device: string }[] = [
  { key: 'ipad-l', label: 'iPad landscape (1180×820)', w: 1180, h: 820, device: 'iPad' },
  { key: 'ipad-p', label: 'iPad portrait (820×1180)', w: 820, h: 1180, device: 'iPad' },
  { key: 'mac', label: 'MacBook (1440×900)', w: 1440, h: 900, device: 'macOS' },
  { key: 'win', label: 'Windows laptop (1366×768)', w: 1366, h: 768, device: 'Windows' },
];
export function DevicePreview({ onClose }: { onClose: () => void }) {
  const [sel, setSel] = useState(DEVICES[0].key);
  const d = DEVICES.find(x => x.key === sel)!;
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const fit = () => { const r = box.current?.getBoundingClientRect(); if (r) setScale(Math.min(1, (r.width - 8) / d.w, (window.innerHeight * 0.68) / d.h)); };
    fit(); window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit);
  }, [d]);
  return <Modal title="Device preview" eyebrow="WINDOWS · MACOS · IPAD" onClose={onClose} wide="xl">
    <div className="device-tabs">{DEVICES.map(x => <button key={x.key} className={sel === x.key ? 'on' : ''} onClick={() => setSel(x.key)}>{x.label}</button>)}</div>
    <p className="muted small">A read-only copy of Atlas at that screen size, using the same host data. Touch behaviour itself can only be checked on the real device.</p>
    <div className="device-stage" ref={box} style={{ height: d.h * scale + 16 }}>
      <div className={'device-frame ' + d.device.toLowerCase()} style={{ width: d.w, height: d.h, transform: `scale(${scale})` }}>
        <iframe title={`Atlas on ${d.label}`} src={`/?preview=1&device=${d.device}`} width={d.w} height={d.h} />
      </div>
    </div>
  </Modal>;
}

export function TimelineView({ ctx }: { ctx: Ctx }) {
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    return ctx.board.events.filter(e => matchesQuery(`${e.name} ${e.place} ${e.countries.join(' ')} ${e.actors.map(a => a.name).join(' ')} ${e.tags.join(' ')}`, q))
      .map(e => ({ e, t: dateSpan(e.date, e.endDate)?.[0] ?? Infinity })).sort((a, b) => a.t - b.t);
  }, [ctx.board.events, q]);
  let lastYear: number | null | undefined;
  return <section className="content">
    <div className="view-heading"><div><div className="eyebrow">CHRONOLOGY · {ctx.board.name.toUpperCase()}</div><h1>Timeline</h1><p>Records ordered by start date. Ranges show start–end. Undated records stay at the end for follow-up.</p></div>
      <div className="actions"><div className="searchbox"><Search size={14} /><input placeholder="Filter timeline" value={q} onChange={e => setQ(e.target.value)} /></div><button className="button subtle" onClick={() => ctx.setView('World')}><Globe2 size={14} /> World view</button></div></div>
    <div className="timeline">{items.map(({ e }) => {
      const y = yearOf(e.date);
      const head = y !== lastYear ? <div className="timeline-year" key={`y${e.id}`}>{y ?? 'Undated'}</div> : null;
      lastYear = y;
      return [head, <button key={e.id} onClick={() => ctx.openRecord(e.id)}><i style={{ background: VERIFICATION_COLORS[e.verification] }} /><time>{formatDateRange(e)}</time><span><b>{e.name || 'Untitled record'}</b><small>{e.place || 'No place'} · {e.verification} · {e.evidence.length} sources{hasCoords(e) ? '' : ' · not on globe'}</small></span><ChevronRight size={14} /></button>];
    })}{!items.length && <p className="muted">No records on this board yet.</p>}</div>
  </section>;
}

export function OverviewView({ ctx, openNew }: { ctx: Ctx; openNew: () => void }) {
  const { project } = ctx;
  const all = project.boards.flatMap(b => b.events);
  const sourced = all.filter(e => e.evidence.length).length;
  return <section className="content overview">
    <div className="welcome"><div><div className="eyebrow">YOUR RESEARCH DESK · {project.name.toUpperCase()}</div><h1>Make connections visible.</h1><p>Build a clear picture from ideas, events and sourced evidence. Everything stays on your Windows host.</p></div><button className="button primary" onClick={openNew}><Plus size={15} /> New</button></div>
    <div className="stat-row"><span><b>{project.boards.length}</b>boards</span><span><b>{all.length}</b>records</span><span><b>{all.length ? Math.round((sourced / all.length) * 100) : 0}%</b>with sources</span><span><b>{all.filter(hasCoords).length}</b>on the globe</span><span><b>{project.boards.reduce((n, b) => n + b.imports.filter(i => !i.removedAt).length, 0)}</b>imports</span></div>
    <div className="quick-grid">
      <button onClick={() => ctx.addBoard()}><Network /><b>Start a graph</b><small>Connect ideas, entities and sources</small></button>
      <button onClick={() => ctx.addBoard('world')}><Globe2 /><b>Open a world board</b><small>Map dated records with evidence</small></button>
      <button onClick={ctx.openImport}><FileUp /><b>Import records</b><small>CSV, JSON, GeoJSON or UCDP GED with provenance checks</small></button>
    </div>
    <div className="overview-lower">
      <section className="panel"><div className="panel-head"><div><h2>Boards in this project</h2><p>Subprojects share the same workspace</p></div></div>
        {project.boards.map(b => <button className="recent" key={b.id} onClick={() => ctx.selectBoard(b.id)}><span className="recent-icon">{b.kind === 'world' ? <Globe2 /> : <Network />}</span><span><b>{b.name}</b><small>{b.nodes.length} nodes · {b.events.length} records · {b.folders.reduce((n, f) => n + f.items.length, 0)} materials</small></span><ChevronRight size={15} /></button>)}
      </section>
      <section className="panel guide"><div className="panel-head"><div><h2>Research with care</h2><p>Evidence first, uncertainty visible</p></div><Sparkles size={16} /></div>
        <p className="guide-copy">Attach a source to each claim and link it to the exact field it supports. Keep attribution qualified (alleged, claimed, disputed) and casualty figures as sourced ranges with definitions. Similarity is a lead, never proof.</p>
        <div className="integrity"><Shield size={15} /> Public sources · verification status · neutral wording</div>
        <div className="guide-links"><button className="button subtle" onClick={() => ctx.setView('World')}><Globe2 size={14} /> World</button><button className="button subtle" onClick={() => ctx.setView('Timeline')}><Clock3 size={14} /> Timeline</button><button className="button subtle" onClick={() => ctx.setView('Folders')}><Folder size={14} /> Folders</button><button className="button subtle" onClick={() => ctx.setView('Settings')}><BookOpen size={14} /> Licences</button></div>
      </section>
    </div>
    <div className="bottom-line"><span>ATLAS WORKSPACE</span><span>LOCAL FIRST · RESEARCH WITH CARE</span></div>
  </section>;
}
