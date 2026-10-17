// Investigate page panes: the connections diagram and the timeline strip. Plain SVG, no map or graph library.
import type { Connection, Entity, EntityKind } from '../entities.ts';

export const KIND_COLORS: Record<EntityKind, string> = { Person: '#729cf5', Organisation: '#e9b670', 'Other actor': '#b18cff', Place: '#6ac6b1', Event: '#e5656f' };
export const LISTED_TOGETHER = (n: number) => `listed together on ${n} record${n === 1 ? '' : 's'} — not evidence of a relationship`;
const clip = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The entity in the middle, up to 24 neighbours on a ring. Solid arrows: graph links. Dashed: listed together. */
export function ConnectionsDiagram({ center, connections, total, activeKey, onFocus, onLink }: {
  center: Entity; connections: Connection[]; total: number; activeKey: string; onFocus: (key: string) => void; onLink: (c: Connection) => void;
}) {
  const cx = 150, cy = 128, R = 100, rc = 19, rn = 11;
  const n = connections.length;
  return <svg className="inv-diagram" viewBox="0 0 300 262" role="img" aria-label={`${center.name} and ${total} connected entities`}>
    <defs>
      <marker id="inv-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="#729cf5" /></marker>
    </defs>
    {connections.map((c, i) => {
      const a = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
      const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
      const ux = Math.cos(a), uy = Math.sin(a);
      // Line from the centre circle's edge to the neighbour's edge.
      const x1 = cx + ux * (rc + 2), y1 = cy + uy * (rc + 2), x2 = x - ux * (rn + 2), y2 = y - uy * (rn + 2);
      const graph = c.graph.length > 0, out = c.graph.some(g => g.outgoing), inc = c.graph.some(g => !g.outgoing);
      const title = graph ? `${c.graph.map(g => `${g.outgoing ? '' : '← '}${g.relation}${g.outgoing ? ' →' : ''}`).join(', ')}${c.shared.length ? `; ${LISTED_TOGETHER(c.shared.length)}` : ''}` : LISTED_TOGETHER(c.shared.length);
      const on = activeKey === c.key;
      const labelY = y + (Math.sin(a) >= -0.2 ? rn + 10 : -(rn + 4));
      return <g key={c.key} className={'inv-link' + (on ? ' on' : '')}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={graph ? '#729cf5' : '#7d8aa0'} strokeWidth={on ? 2.4 : 1.4} strokeDasharray={graph ? undefined : '4 4'}
          markerEnd={out ? 'url(#inv-arrow)' : undefined} markerStart={inc ? 'url(#inv-arrow)' : undefined} />
        <line className="inv-hit" x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} onClick={() => onLink(c)}><title>{title}</title></line>
        <g className="inv-node" role="button" tabIndex={0} aria-label={`Focus on ${c.name}`} onClick={() => onFocus(c.key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onFocus(c.key); }}>
          <circle cx={x} cy={y} r={rn} fill="#10151f" stroke={KIND_COLORS[c.kind]} strokeWidth={2} />
          <text x={x} y={y + 3} textAnchor="middle" className="inv-count">{c.shared.length || c.graph.length}</text>
          <text x={x} y={labelY} textAnchor="middle" className="inv-label">{clip(c.name)}<title>{c.name} ({c.kind})</title></text>
        </g>
      </g>;
    })}
    <circle cx={cx} cy={cy} r={rc} fill="#162236" stroke={KIND_COLORS[center.kind]} strokeWidth={2.5} />
    <text x={cx} y={cy + 3} textAnchor="middle" className="inv-center">{clip(center.name, 11)}<title>{center.name}</title></text>
    {!n && <text x={cx} y={cy + 48} textAnchor="middle" className="inv-empty">No connections yet</text>}
    {total > n && <text x={296} y={257} textAnchor="end" className="inv-empty">Showing {n} of {total}</text>}
  </svg>;
}

export type TimelineItem = { id: string; start: number; end: number; color: string; label: string };
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const yearMs = (y: number) => Date.UTC(y, 0, 1);

/** Dated records along a year axis; ranges show as bars. Clicking one selects it everywhere on the page. */
export function TimelineStrip({ items, undated, selectedId, onSelect }: { items: TimelineItem[]; undated: number; selectedId: string; onSelect: (id: string) => void }) {
  if (!items.length) return <div className="inv-timeline-empty">No dated records{undated ? ` · ${undated} undated` : ''}</div>;
  const y0 = new Date(Math.min(...items.map(i => i.start))).getUTCFullYear(), y1 = new Date(Math.max(...items.map(i => i.end))).getUTCFullYear() + 1;
  const step = STEPS.find(s => (y1 - y0) / s <= 8) || 1000;
  const W = 600, pad = 18, t0 = yearMs(y0), t1 = yearMs(y1);
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const ticks: number[] = [];
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) ticks.push(y);
  // Stack dots that would overlap, up to four rows.
  const rows: number[][] = [[], [], [], []];
  const placed = [...items].sort((a, b) => a.start - b.start).map(i => {
    const xs = x(i.start), xe = Math.max(xs, x(i.end));
    let r = rows.findIndex(row => row.every(px => Math.abs(px - xs) > 7));
    if (r < 0) r = 3;
    rows[r].push(xs);
    return { ...i, xs, xe, row: r };
  });
  return <div className="inv-timeline">
    <svg viewBox={`0 0 ${W} 74`} role="img" aria-label={`Timeline of ${items.length} dated records from ${y0} to ${y1 - 1}`}>
      <line x1={pad} x2={W - pad} y1={56} y2={56} stroke="#2a3648" />
      {ticks.map(t => <g key={t}><line x1={x(yearMs(t))} x2={x(yearMs(t))} y1={53} y2={59} stroke="#3a4a61" /><text x={x(yearMs(t))} y={70} textAnchor="middle" className="inv-tick">{t}</text></g>)}
      {placed.map(p => {
        const cy = 46 - p.row * 11, on = p.id === selectedId;
        return <g key={p.id} className="inv-dot" role="button" tabIndex={0} aria-label={p.label} onClick={() => onSelect(p.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(p.id); }}>
          {p.xe - p.xs > 3 && <line x1={p.xs} x2={p.xe} y1={cy} y2={cy} stroke={p.color} strokeWidth={3} strokeLinecap="round" opacity={0.6} />}
          {on && <circle cx={p.xs} cy={cy} r={7.5} fill="none" stroke="#fff" strokeWidth={1.6} />}
          <circle cx={p.xs} cy={cy} r={4.2} fill={p.color} stroke="#0a0d13" strokeWidth={1} />
          <title>{p.label}</title>
        </g>;
      })}
    </svg>
    {undated > 0 && <small className="muted">{undated} undated</small>}
  </div>;
}
