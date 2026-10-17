import React from 'react';
import { AlertTriangle, Info, OctagonAlert, X } from 'lucide-react';
import { VERIFICATION_COLORS, type Issue } from '../model.ts';

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={'fx-field' + (wide ? ' wide' : '')}><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>;
}

export function Select({ value, onChange, options, labels, ariaLabel }: { value: string; onChange: (v: string) => void; options: string[]; labels?: Record<string, string>; ariaLabel?: string }) {
  const opts = options.includes(value) || !value ? options : [value, ...options];
  return <select aria-label={ariaLabel} value={value} onChange={e => onChange(e.target.value)}>{opts.map(o => <option key={o} value={o}>{labels?.[o] ?? (o || '— none —')}</option>)}</select>;
}

export function VerificationBadge({ value }: { value: string }) {
  return <span className="fx-badge" style={{ borderColor: VERIFICATION_COLORS[value] || '#56627a', color: VERIFICATION_COLORS[value] || '#aab4c3' }}><i style={{ background: VERIFICATION_COLORS[value] || '#56627a' }} />{value}</span>;
}

export function Tag({ children, tone }: { children: React.ReactNode; tone?: 'fact' | 'allegation' | 'estimate' | 'interpretation' | 'warn' | 'muted' }) {
  return <span className={'fx-tag ' + (tone || '')}>{children}</span>;
}

export function IssueList({ issues, max = 99 }: { issues: Issue[]; max?: number }) {
  if (!issues.length) return null;
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
  return <ul className="fx-issues">{sorted.slice(0, max).map((i, k) => <li key={k} className={i.level}>{i.level === 'error' ? <OctagonAlert size={12} /> : i.level === 'warning' ? <AlertTriangle size={12} /> : <Info size={12} />}{i.text}</li>)}{sorted.length > max && <li className="info">+{sorted.length - max} more</li>}</ul>;
}

export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = React.useState('');
  const add = () => { const parts = draft.split(/[;\n]/).map(s => s.trim()).filter(Boolean); if (parts.length) onChange([...new Set([...value, ...parts])]); setDraft(''); };
  return <div className="fx-list-input">
    {value.map(v => <span key={v} className="fx-chip">{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter(x => x !== v))}><X size={11} /></button></span>)}
    <input value={draft} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onBlur={add} onKeyDown={e => { if (e.key === 'Enter' || e.key === ';') { e.preventDefault(); add(); } }} />
  </div>;
}

export function Modal({ title, eyebrow = 'ATLAS WORKSPACE', onClose, children, wide, footer }: { title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; wide?: boolean | 'xl'; footer?: React.ReactNode }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <section className={'modal-card' + (wide === 'xl' ? ' xl' : wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div><button className="icon-action" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <div className="modal-body">{children}</div>
      {footer && <footer className="modal-footer">{footer}</footer>}
    </section>
  </div>;
}

export function numOrNull(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
