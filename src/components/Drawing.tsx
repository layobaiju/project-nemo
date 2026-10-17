import React, { useEffect, useRef, useState } from 'react';
import { Eraser, Highlighter, Pencil, Redo2, Undo2 } from 'lucide-react';
import type { Node } from '@xyflow/react';
import type { Folder, FolderItem } from '../types.ts';
import { nowIso, uid } from '../model.ts';
import { Modal } from './ui.tsx';

type Pt = [number, number, number];
type Stroke = { tool: 'pen' | 'highlighter' | 'eraser'; color: string; width: number; points: Pt[] };
const W = 1600, H = 1000, BG = '#0b111b';
const COLORS = ['#82a9ff', '#f4f7fb', '#6ac6b1', '#e9b670', '#e5656f', '#b18cff'];

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, from = 1) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.tool === 'eraser' ? BG : s.color;
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.32 : 1;
  const mult = s.tool === 'highlighter' ? 3.2 : s.tool === 'eraser' ? 4 : 1;
  for (let i = Math.max(1, from); i < s.points.length; i++) {
    const [x0, y0] = s.points[i - 1], [x1, y1, p] = s.points[i];
    ctx.lineWidth = Math.max(1, s.width * mult * (s.tool === 'pen' ? 0.35 + p : 1));
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  if (s.points.length === 1) { const [x, y] = s.points[0]; ctx.fillStyle = ctx.strokeStyle as string; ctx.beginPath(); ctx.arc(x, y, s.width * mult / 2, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

/** Sketch pad for touch, mouse and Apple Pencil. Pencil-only mode ignores finger/palm contact. */
export default function Drawing({ folders, defaultFolderId, nodes, onSave, onClose }: { folders: Folder[]; defaultFolderId: string; nodes: Node[]; onSave: (item: FolderItem, folderId: string | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<Stroke['tool']>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [width, setWidth] = useState(4);
  const [pencilOnly, setPencilOnly] = useState(false);
  const [penSeen, setPenSeen] = useState(false);
  const [title, setTitle] = useState(`Sketch ${new Date().toLocaleDateString()}`);
  const [folderId, setFolderId] = useState(folders.some(f => f.id === defaultFolderId) ? defaultFolderId : folders[0]?.id || '');
  const [nodeId, setNodeId] = useState('');
  const current = useRef<Stroke | null>(null);
  const activePointer = useRef<number | null>(null);

  const redraw = (list: Stroke[]) => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
    for (const s of list) drawStroke(ctx, s);
  };
  useEffect(() => redraw(strokes), [strokes]);

  const point = (e: PointerEvent | React.PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height, pressure];
  };
  const accept = (e: React.PointerEvent) => {
    if (e.pointerType === 'pen' && !penSeen) { setPenSeen(true); setPencilOnly(true); }
    return !(pencilOnly && e.pointerType === 'touch');
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!accept(e) || activePointer.current != null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    current.current = { tool, color, width, points: [point(e)] };
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawStroke(ctx, current.current);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointer.current || !current.current) return;
    const s = current.current, start = s.points.length;
    const events = (e.nativeEvent as any).getCoalescedEvents?.() as PointerEvent[] | undefined;
    for (const ev of events?.length ? events : [e.nativeEvent]) s.points.push(point(ev));
    const ctx = ref.current?.getContext('2d');
    if (ctx) drawStroke(ctx, s, start);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    const s = current.current;
    current.current = null;
    if (s) { setStrokes(x => [...x, s]); setRedo([]); }
  };
  const save = () => {
    const imageData = ref.current?.toDataURL('image/png');
    if (!imageData) return;
    onSave({ id: uid(), name: title.trim() || 'Sketch', kind: 'drawing', imageData, nodeIds: nodeId ? [nodeId] : [], recordIds: [], createdAt: nowIso() }, folderId || null);
  };

  return <Modal title="Sketch" eyebrow="DRAWING · TOUCH & APPLE PENCIL" onClose={onClose} wide="xl" footer={<>
    <span className="fx-footer-status">{penSeen ? 'Apple Pencil / stylus detected' : 'Touch, mouse or stylus'}</span>
    <button className="button subtle" onClick={() => { setStrokes([]); setRedo([]); }}>Clear</button>
    <button className="button subtle" onClick={onClose}>Cancel</button>
    <button className="button primary" disabled={!strokes.length} onClick={save}>Save to folder</button>
  </>}>
    <div className="draw-toolbar">
      <div className="seg">
        <button className={tool === 'pen' ? 'on' : ''} onClick={() => setTool('pen')} aria-label="Pen"><Pencil size={15} /></button>
        <button className={tool === 'highlighter' ? 'on' : ''} onClick={() => setTool('highlighter')} aria-label="Highlighter"><Highlighter size={15} /></button>
        <button className={tool === 'eraser' ? 'on' : ''} onClick={() => setTool('eraser')} aria-label="Eraser"><Eraser size={15} /></button>
      </div>
      <div className="swatches">{COLORS.map(c => <button key={c} aria-label={`Colour ${c}`} className={color === c ? 'on' : ''} style={{ background: c }} onClick={() => { setColor(c); if (tool === 'eraser') setTool('pen'); }} />)}</div>
      <label className="width">Width<input type="range" min={1} max={16} value={width} onChange={e => setWidth(Number(e.target.value))} /></label>
      <div className="seg">
        <button aria-label="Undo" disabled={!strokes.length} onClick={() => { setRedo(r => [...r, strokes[strokes.length - 1]]); setStrokes(s => s.slice(0, -1)); }}><Undo2 size={15} /></button>
        <button aria-label="Redo" disabled={!redo.length} onClick={() => { setStrokes(s => [...s, redo[redo.length - 1]]); setRedo(r => r.slice(0, -1)); }}><Redo2 size={15} /></button>
      </div>
      <label className="pencil-only"><input type="checkbox" checked={pencilOnly} onChange={e => setPencilOnly(e.target.checked)} /> Pencil only (ignore palm/finger)</label>
    </div>
    <canvas ref={ref} width={W} height={H} className="drawing-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()} />
    <div className="fx-grid four draw-meta">
      <label className="fx-field"><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="fx-field"><span>Folder</span><select value={folderId} onChange={e => setFolderId(e.target.value)}>{folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}{!folders.length && <option value="">New “Drawings” folder</option>}</select></label>
      <label className="fx-field"><span>Link to node (optional)</span><select value={nodeId} onChange={e => setNodeId(e.target.value)}><option value="">— none —</option>{nodes.map(n => <option key={n.id} value={n.id}>{String((n.data as any)?.label || n.id)}</option>)}</select></label>
    </div>
  </Modal>;
}
