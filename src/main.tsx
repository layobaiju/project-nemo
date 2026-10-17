import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import { Bell, Check, ChevronDown, ChevronRight, Clock3, CloudOff, Compass, Folder, Map as MapIcon, Globe2, Grid2X2, Loader2, Menu, Network, Plus, ScanSearch, Settings2, Shield, TriangleAlert, X } from 'lucide-react';
import type { Board, EventItem, Project } from './types.ts';
import type { Ctx, Device, Focus, View } from './ctx.ts';
import { newEvent, normalizeProjects, nowIso, uid } from './model.ts';
import { AccessRequired, deleteBoard, deleteProjectOnHost, getBoard, getManifest, getWatchSummary, loadWorkspace, saveBoard, saveProjectMeta } from './api.ts';
import { EMPTY_SUMMARY, type WatchSummary } from './watch.ts';
import { applyRemote, applySaved, baselineFrom, boardKey, conflictActions, conflictFor, conflictMessage, diffRemote, forgetProject, mergeConflicts, planSave, projectKey, remoteIsEmpty, type Baseline, type Conflict, type Fetched, type Manifest, type RemotePlan } from './sync.ts';
import { download, projectJSON, safeName } from './exporters.ts';
import { usePersisted } from './usePersisted.ts';
import { Modal } from './components/ui.tsx';
import EventEditor from './components/EventEditor.tsx';
import ImportWizard, { type ImportResult } from './components/ImportWizard.tsx';
import RestoreModal from './components/RestoreModal.tsx';
import WorldView from './components/WorldView.tsx';
import ExploreView from './components/ExploreView.tsx';
// The Map workspace (with its drawing library) loads only when it is opened.
const MapWorkspace = lazy(() => import('./components/MapWorkspace.tsx'));
const InvestigateView = lazy(() => import('./components/InvestigateView.tsx'));
const WatchlistView = lazy(() => import('./components/WatchlistView.tsx'));
import type { WorkspaceMatch } from './explore.ts';
import GraphView from './components/GraphView.tsx';
import FoldersView from './components/FoldersView.tsx';
import Drawing from './components/Drawing.tsx';
import SettingsView from './components/SettingsView.tsx';
import { AccessGate, DevicePreview, OverviewView, TimelineView } from './components/Misc.tsx';
import './style.css';
import './components.css';

const params = new URLSearchParams(location.search);
const PREVIEW = params.get('preview') === '1';
function detectDevice(): Device {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  return 'Windows';
}
const emptyBoard = (kind: string, name: string): Board => ({ id: uid(), name, kind, nodes: [], edges: [], events: [], links: [], imports: [], folders: [{ id: uid(), name: 'Sources', items: [] }, { id: uid(), name: 'Working notes', items: [] }] });
type SaveState = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict' | 'readonly';
type EditorState = { record: EventItem; isNew: boolean; boardId: string };

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [accessNeeded, setAccessNeeded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(PREVIEW ? 'readonly' : 'saved');
  const [pid, setPid] = usePersisted('atlas.project', 'military-workspace');
  const [bid, setBid] = useState('');
  const [view, setView] = useState<View>('World');
  const [storedDevice, setStoredDevice] = usePersisted<Device | ''>('atlas.device', '');
  const device: Device = (PREVIEW && (params.get('device') as Device)) || storedDevice || detectDevice();
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pickDraft, setPickDraft] = useState<EditorState | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [restore, setRestore] = useState<any[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [modal, setModal] = useState<'' | 'new' | 'workspaces' | 'devices'>('');
  const [folderId, setFolderId] = useState('');
  const [exploreRequest, setExploreRequest] = useState<{ q: string; n: number } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [watchSummary, setWatchSummary] = useState<WatchSummary>(EMPTY_SUMMARY);
  const baseline = useRef<Baseline>({ boards: new Map(), projects: new Map() });
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const conflictsRef = useRef<Conflict[]>([]);
  const forceKeys = useRef(new Set<string>());
  const saveGen = useRef(0);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const saving = useRef(false), again = useRef(false);
  const setConflictList = (list: Conflict[]) => { conflictsRef.current = list; setConflicts(list); };

  // ---------- load ----------
  const applyLoaded = useCallback((data: { projects: Project[]; manifest: Manifest }) => {
    const ps = normalizeProjects(data.projects);
    baseline.current = baselineFrom(ps, data.manifest); // migration alone never triggers a write
    forceKeys.current.clear();
    setConflictList([]);
    projectsRef.current = ps;
    setProjects(ps);
    return ps;
  }, []);
  const load = useCallback(async () => {
    try {
      const ps = applyLoaded(await loadWorkspace());
      setAccessNeeded(false); setLoadError('');
      const p = ps.find(x => x.id === pid) || ps.find(x => x.id === 'military-workspace') || ps[0];
      if (p) { setPid(p.id); setBid(b => (p.boards.some(x => x.id === b) ? b : p.boards[0]?.id || '')); }
      setLoaded(true);
    } catch (e) {
      if (e instanceof AccessRequired) setAccessNeeded(true);
      else setLoadError((e as Error).message || 'Cannot reach the Windows host.');
    }
  }, [applyLoaded, pid, setPid]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- save (per board, revision-checked; never blind-overwrites another device) ----------
  // Only boards whose object changed are sent, so editing a small board never resends a 5,000-record one.
  // A board in conflict waits for the user; every other board keeps saving.
  const flush = useCallback(async () => {
    if (PREVIEW || !loaded) return;
    if (saving.current) { again.current = true; return; }
    const ops = planSave(projectsRef.current, baseline.current, new Set(conflictsRef.current.map(c => c.key)));
    for (const key of forceKeys.current) if (!ops.some(op => op.key === key)) forceKeys.current.delete(key);
    if (!ops.length) { setSaveState(s => (s === 'pending' || s === 'offline' || s === 'saving' ? 'saved' : s)); return; }
    saving.current = true; setSaveState('saving');
    const found: Conflict[] = [], notCreated = new Set<string>();
    try {
      for (const op of ops) {
        if (op.kind !== 'project' && notCreated.has(op.pid)) continue;
        const force = forceKeys.current.has(op.key);
        const r = op.kind === 'project' ? await saveProjectMeta(op.pid, op.meta, op.baseRevision, force)
          : op.kind === 'board' ? await saveBoard(op.pid, op.board, op.baseRevision, force)
          : op.kind === 'delete-project' ? await deleteProjectOnHost(op.pid, op.baseRevision, op.boardRevisions, force)
          : await deleteBoard(op.pid, op.bid, op.baseRevision, force);
        forceKeys.current.delete(op.key);
        if ('conflict' in r) {
          found.push(conflictFor(op, r.reason));
          if (op.kind === 'project' && !baseline.current.projects.has(op.pid)) notCreated.add(op.pid);
          continue;
        }
        applySaved(baseline.current, op, r.revision);
        saveGen.current++;
      }
      setSaveState('saved');
    } catch (e) {
      if (e instanceof AccessRequired) setAccessNeeded(true);
      setSaveState('offline');
    } finally {
      if (found.length) setConflictList(mergeConflicts(conflictsRef.current, found));
      saving.current = false;
      if (again.current) { again.current = false; setTimeout(() => flush(), 50); }
    }
  }, [loaded]);
  useEffect(() => {
    if (!loaded || PREVIEW) return;
    setSaveState(s => (s === 'saved' ? 'pending' : s));
    const t = setTimeout(() => flush(), 700);
    return () => clearTimeout(t);
  }, [projects]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (saveState !== 'offline') return; const t = setInterval(() => flush(), 8000); return () => clearInterval(t); }, [saveState, flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (!PREVIEW && planSave(projectsRef.current, baseline.current).length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // ---------- pick up changes made on other devices ----------
  // Polls a small manifest of revisions and downloads only the boards that changed elsewhere.
  useEffect(() => {
    if (!loaded) return;
    let busy = false;
    const check = async () => {
      if (document.hidden || saving.current || busy) return;
      busy = true;
      const gen = saveGen.current, stale = () => saving.current || gen !== saveGen.current;
      try {
        const m = await getManifest();
        if (stale()) return;
        const plan = diffRemote(m, baseline.current, projectsRef.current);
        if (remoteIsEmpty(plan)) return;
        const fetched: Fetched[] = [];
        for (const f of plan.fetch) { const r = await getBoard(f.pid, f.bid); fetched.push({ ...f, board: r?.board ?? null, revision: r?.revision ?? '' }); }
        if (stale()) return;
        const r = applyRemote(projectsRef.current, baseline.current, m, plan, fetched);
        if (r.updated.length) {
          projectsRef.current = r.projects; setProjects(r.projects);
          setNotice(r.updated.length === 1 ? `Updated “${r.updated[0]}” with changes saved on another device.` : `Updated ${r.updated.length} boards or projects with changes saved on another device.`);
        }
        if (r.conflicts.length) setConflictList(mergeConflicts(conflictsRef.current, r.conflicts));
      } catch {} finally { busy = false; }
    };
    const t = setInterval(check, 12000);
    window.addEventListener('focus', check);
    return () => { clearInterval(t); window.removeEventListener('focus', check); };
  }, [loaded]);
  // Watchlist badge: the host checks on its own schedule; the app only asks how many alerts are new.
  const refreshWatch = useCallback(() => { getWatchSummary().then(setWatchSummary).catch(() => {}); }, []);
  useEffect(() => {
    if (!loaded) return;
    refreshWatch();
    const t = setInterval(refreshWatch, 60000);
    window.addEventListener('focus', refreshWatch);
    return () => { clearInterval(t); window.removeEventListener('focus', refreshWatch); };
  }, [loaded, refreshWatch]);
  useEffect(() => { if (view !== 'Explore') setExploreRequest(null); }, [view]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(t); } }, [notice]);

  // ---------- derived ----------
  const project = projects.find(p => p.id === pid) || projects[0];
  const board = project?.boards.find(b => b.id === bid) || project?.boards[0];
  useEffect(() => { if (board && board.id !== bid) setBid(board.id); }, [board?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // After the open project is deleted (here or on another device), remember the one now shown instead.
  useEffect(() => { if (project && project.id !== pid) setPid(project.id); }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFocus(null); }, [project?.id]);
  useEffect(() => { if (board && !board.folders.some(f => f.id === folderId)) setFolderId(board.folders[0]?.id || ''); }, [board?.id, board?.folders.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchBoard = (fn: (b: Board) => Board, boardId?: string) => {
    if (PREVIEW) return;
    const target = boardId || bid;
    setProjects(ps => ps.map(p => (p.id === pid ? { ...p, boards: p.boards.map(b => (b.id === target ? { ...fn(b), updatedAt: nowIso() } : b)) } : p)));
  };
  // Project settings only: the boards object is kept as is, so no board is resent.
  const patchProject = (fn: (p: Project) => Project) => {
    if (PREVIEW) return;
    setProjects(ps => ps.map(p => (p.id === pid ? { ...fn(p), boards: p.boards } : p)));
  };
  const selectBoard = (id: string) => { const b = project?.boards.find(x => x.id === id); setBid(id); if (b) setView(v => (v === 'Overview' || v === 'Settings' ? (b.kind === 'world' ? 'World' : 'Graph') : v)); document.body.classList.remove('nav-open'); };
  const addBoard = (kind = 'graph', name?: string) => {
    const b = emptyBoard(kind, name || (kind === 'world' ? 'New world board' : 'New graph board'));
    setProjects(ps => ps.map(p => (p.id === pid ? { ...p, boards: [...p.boards, b] } : p)));
    setBid(b.id); setView(kind === 'world' ? 'World' : 'Graph');
    return b.id;
  };
  const createProject = () => {
    const first = emptyBoard('world', 'Overview map');
    const p: Project = { id: uid(), name: 'Untitled project', description: '', createdAt: nowIso(), boards: [first] };
    setProjects(ps => [...ps, p]); setPid(p.id); setBid(first.id); setView('Settings');
    setNotice('Project created. Name it under Settings → Project and boards.');
  };
  const openRecord = (id: string, boardId?: string) => {
    const b = project.boards.find(x => x.id === (boardId || bid)) || project.boards.find(x => x.events.some(e => e.id === id));
    const record = b?.events.find(e => e.id === id);
    if (b && record) setEditor({ record, isNew: false, boardId: b.id });
  };
  const newRecord = (partial: Partial<EventItem> = {}) => { if (!PREVIEW) setEditor({ record: newEvent(partial), isNew: true, boardId: bid }); };
  const saveRecord = (rec: EventItem) => {
    if (!editor) return;
    patchBoard(b => ({
      ...b,
      events: b.events.some(e => e.id === rec.id) ? b.events.map(e => (e.id === rec.id ? rec : e)) : [...b.events, rec],
      // Keep linked graph nodes in step with the record they represent.
      nodes: b.nodes.map(n => (n.id === rec.nodeId || (n.data as any)?.recordId === rec.id ? { ...n, data: { ...n.data, label: rec.name, confidence: rec.verification } } : n)),
    }), editor.boardId);
    setEditor(null);
    setNotice(editor.isNew ? 'Record created.' : 'Record saved.');
  };
  const deleteRecord = () => {
    if (!editor) return;
    const id = editor.record.id;
    patchBoard(b => ({ ...b, events: b.events.filter(e => e.id !== id), links: b.links.filter(l => l.a !== id && l.b !== id), nodes: b.nodes.map(n => ((n.data as any)?.recordId === id ? { ...n, data: { ...n.data, recordId: undefined, detail: `${(n.data as any).detail || ''} (record deleted)` } } : n)) }), editor.boardId);
    setEditor(null);
    setNotice('Record deleted.');
  };
  const onImport = (r: ImportResult) => {
    if ('newBoardName' in r.target) {
      const b: Board = { ...emptyBoard('world', r.target.newBoardName), events: r.records, links: r.links, imports: [r.batch] };
      setProjects(ps => ps.map(p => (p.id === pid ? { ...p, boards: [...p.boards, b] } : p)));
      setBid(b.id);
    } else {
      patchBoard(b => ({ ...b, events: [...b.events, ...r.records], links: [...b.links, ...r.links], imports: [...b.imports, r.batch] }), r.target.boardId);
      setBid(r.target.boardId);
    }
    setImportOpen(false); setView('World');
    setNotice(`Imported ${r.records.length} record${r.records.length === 1 ? '' : 's'} from ${r.batch.dataset.name} (${r.batch.dataset.license}). ${r.batch.skipped} skipped.`);
  };
  const openRestoreFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data?.format === 'atlas-project' ? [data.project] : data?.projects;
      if (!Array.isArray(list) || list.some((p: any) => !p?.id || !Array.isArray(p?.boards))) throw Error('This is not an Atlas workspace or project backup.');
      setRestore(list);
    } catch (e) { setNotice((e as Error).message); }
  };
  const resolveConflict = async (c: Conflict, how: 'load' | 'keep' | 'download') => {
    const p = projectsRef.current.find(x => x.id === c.pid);
    if (how === 'download') {
      // Saved as a project file with just this board, so Settings → Restore from backup can bring it back as a copy.
      const b = p?.boards.find(x => x.id === c.bid);
      if (p) download(`atlas-unsaved-${safeName(c.name)}-${nowIso().slice(0, 19).replace(/:/g, '')}.json`, 'application/json', projectJSON(c.kind === 'board' ? { ...p, boards: b ? [b] : [] } : p));
      return;
    }
    if (how === 'keep') {
      const what = c.reason === 'deleted-here' ? `Delete ${c.kind} “${c.name}” on the host as well?`
        : c.reason === 'deleted' && c.kind === 'project' ? `Put project “${c.name}” back on the host with this device’s version?`
        : `Replace the host’s copy of “${c.name}” with this device’s version?`;
      if (!confirm(`${what} The host keeps a backup of the version it replaces.`)) return;
      // A project deleted elsewhere is simply created again; everything else is sent with force.
      if (c.kind === 'project' && c.reason === 'deleted') forgetProject(baseline.current, c.pid);
      else forceKeys.current.add(c.key);
      setConflictList(conflictsRef.current.filter(x => x.key !== c.key));
      await flush();
      return;
    }
    try {
      if (c.reason === 'project-missing' || (c.kind === 'project' && c.reason === 'exists')) {
        if (planSave(projectsRef.current, baseline.current).length > 1 && !confirm('This reloads the whole workspace from the host and discards every unsaved edit on this device. Use “Download my copy” first if you need them. Continue?')) return;
        applyLoaded(await loadWorkspace());
        setNotice('Loaded the latest workspace from the host.');
        return;
      }
      const m = await getManifest();
      const rp = m.projects.find(x => x.id === c.pid);
      const plan: RemotePlan = { fetch: [], remove: [], metas: [], conflicts: [], removeProjects: [] };
      const fetched: Fetched[] = [];
      const takeTheirs = new Set([c.kind === 'board' ? boardKey(c.pid, c.bid!) : projectKey(c.pid)]);
      if (c.kind === 'project' && !rp) plan.removeProjects!.push(c.pid); // deleted on the host: accept that here
      if (c.kind === 'project' && rp) {
        plan.metas.push({ pid: c.pid, meta: rp.meta, revision: rp.revision });
        // A project deleted here (or the protected default) comes back with all of its boards.
        if (!p) for (const rb of rp.boards) {
          const r = await getBoard(c.pid, rb.id);
          plan.fetch.push({ pid: c.pid, bid: rb.id });
          fetched.push({ pid: c.pid, bid: rb.id, board: r?.board ?? null, revision: r?.revision ?? '' });
          takeTheirs.add(boardKey(c.pid, rb.id));
        }
      }
      if (c.kind === 'board' && c.bid) {
        const r = await getBoard(c.pid, c.bid);
        plan.fetch.push({ pid: c.pid, bid: c.bid });
        fetched.push({ pid: c.pid, bid: c.bid, board: r?.board ?? null, revision: r?.revision ?? '' });
      }
      const r = applyRemote(projectsRef.current, baseline.current, m, plan, fetched, takeTheirs);
      projectsRef.current = r.projects; setProjects(r.projects);
      setConflictList(conflictsRef.current.filter(x => x.key !== c.key));
      setNotice(`Loaded the host’s version of “${c.name}”.`);
    } catch (e) {
      if (e instanceof AccessRequired) setAccessNeeded(true);
      else setNotice(`Could not reach the host: ${(e as Error).message}`);
    }
  };

  // A workspace match from Explore: switch to its project and board, then the view that shows it.
  const searchWorld = (q: string) => { setExploreRequest({ q, n: Date.now() }); setView('Explore'); };
  const openMatch = (m: WorkspaceMatch) => { setPid(m.projectId); setBid(m.boardId); setView(m.kind === 'record' ? 'World' : m.kind === 'node' ? 'Graph' : 'Folders'); };

  const ctx: Ctx | null = project && board ? {
    projects, project, board, setProjects: PREVIEW ? (() => {}) as any : setProjects, patchBoard, patchProject, notify: setNotice, openRecord, newRecord,
    focus, setFocus, watch: watchSummary, refreshWatch,
    openImport: () => setImportOpen(true), setView, selectBoard, addBoard, device, readOnly: PREVIEW, searchWorld,
    pickMode: !!pickDraft,
    onPick: (lng, lat) => { if (!pickDraft) return; setEditor({ ...pickDraft, record: { ...pickDraft.record, longitude: Math.round(lng * 1e6) / 1e6, latitude: Math.round(lat * 1e6) / 1e6 } }); setPickDraft(null); },
    cancelPick: () => { if (pickDraft) setEditor(pickDraft); setPickDraft(null); },
  } : null;

  const editorLinks = useMemo(() => {
    if (!editor || !project) return [];
    const names = new Map(project.boards.flatMap(b => b.events.map(e => [e.id, e.name] as const)));
    return project.boards.flatMap(b => b.links).filter(l => l.a === editor.record.id || l.b === editor.record.id).map(l => ({ ...l, otherName: names.get(l.a === editor.record.id ? l.b : l.a) || 'Deleted record' }));
  }, [editor, project]);

  if (accessNeeded) return <AccessGate onDone={() => { setAccessNeeded(false); load(); }} />;
  if (!loaded || !ctx) return <div className="boot">{loadError ? <div className="boot-error"><CloudOff size={22} /><h1>Cannot open the workspace</h1><p>{loadError}</p><p className="muted">On the Windows PC, open PowerShell in the Atlas folder and run <code>npm.cmd run host</code>. Then reload this page.</p><button className="button primary" onClick={() => load()}>Try again</button></div> : <><Loader2 className="spin" size={20} /> Connecting to the Windows host…</>}</div>;

  const menu: [View, typeof Grid2X2][] = [['Overview', Grid2X2], ['Graph', Network], ['World', Globe2], ['Map', MapIcon], ['Explore', Compass], ['Investigate', ScanSearch], ['Watchlist', Bell], ['Folders', Folder], ['Timeline', Clock3], ['Settings', Settings2]];
  const saveLabel: Record<SaveState, [string, JSX.Element]> = {
    saved: ['Saved on host', <i className="dot ok" />], pending: ['Unsaved changes…', <i className="dot pending" />], saving: ['Saving…', <Loader2 size={12} className="spin" />],
    offline: ['Host unreachable – retrying; keep this tab open', <CloudOff size={12} />], conflict: [conflicts.length === 1 ? `“${conflicts[0].name}” changed on another device` : `${conflicts.length} conflicts with other devices`, <TriangleAlert size={12} />], readonly: ['Read-only preview', <i className="dot" />],
  };
  const shownState: SaveState = conflicts.length && !PREVIEW ? 'conflict' : saveState;

  return <div className={`app device-${device.toLowerCase()}${device === 'iPad' ? ' ipad' : ''}${PREVIEW ? ' preview-mode' : ''}`}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Globe2 size={18} /></span>ATLAS<span className="brand-dot">.</span><button className="mobile-menu" aria-label="Close menu" onClick={() => document.body.classList.toggle('nav-open')}><X size={17} /></button></div>
      <div className="side-kicker">WORKSPACE</div>
      <button className="project-select" onClick={() => setModal('workspaces')}><span className="project-avatar">{project.name[0] || 'A'}</span><span><b>{project.name}</b><small>{project.boards.length} board{project.boards.length === 1 ? '' : 's'} · on Windows host</small></span><ChevronDown size={14} /></button>
      <div className="side-kicker space-kicker">YOUR SPACE <button aria-label="New" onClick={() => setModal('new')}><Plus size={14} /></button></div>
      {menu.map(([label, Icon]) => <button className={'nav-item ' + (view === label ? 'active' : '')} key={label} onClick={() => { setView(label); document.body.classList.remove('nav-open'); }}><Icon size={16} /><span>{label}</span>{label === 'Graph' && <small>{board.nodes.length}</small>}{label === 'World' && <small>{board.events.length}</small>}{label === 'Watchlist' && watchSummary.unseen > 0 && <small className="nav-badge" aria-label={`${watchSummary.unseen} new alerts`}>{watchSummary.unseen > 99 ? '99+' : watchSummary.unseen}</small>}</button>)}
      <div className="side-kicker boards-kicker">BOARDS <button aria-label="Add board" onClick={() => addBoard()}><Plus size={14} /></button></div>
      <div className="board-scroll">{project.boards.map(b => <button className={'nav-item board-nav ' + (bid === b.id ? 'active' : '')} key={b.id} onClick={() => selectBoard(b.id)}><span className="board-dot" />{b.name}</button>)}</div>
      <div className="side-bottom"><div className="local-status"><Shield size={15} /><span><b>Private workspace</b><small>Stored on the Windows host</small></span><i className={shownState === 'saved' ? '' : 'warn'} /></div></div>
    </aside>
    <main>
      <header className="topbar">
        <button className="mobile-menu show" aria-label="Open menu" onClick={() => document.body.classList.toggle('nav-open')}><Menu size={17} /></button>
        <div className="crumb"><span>{project.name}</span><ChevronRight size={13} /><b>{board.name}</b><ChevronRight size={13} /><span>{view}</span></div>
        <div className="top-actions">
          <span className={'save-pill ' + shownState}>{saveLabel[shownState][1]}{saveLabel[shownState][0]}</span>
          <label className="device-label" htmlFor="device-select">DEVICE</label>
          <select id="device-select" value={device} onChange={e => setStoredDevice(e.target.value as Device)} disabled={PREVIEW}><option>Windows</option><option>macOS</option><option>iPad</option></select>
        </div>
      </header>
      {!PREVIEW && conflicts.map(c => {
        const act = conflictActions(c);
        return <div className="conflict-banner" role="alert" key={c.key}><TriangleAlert size={15} /><span><b>{conflictMessage(c)}</b> {c.kind === 'board' ? 'Other boards keep saving. ' : ''}Choose what to keep; nothing is overwritten automatically.</span>
          {act.download && <button className="button subtle" onClick={() => resolveConflict(c, 'download')}>Download my copy</button>}
          <button className="button subtle" onClick={() => resolveConflict(c, 'load')}>{act.load}</button>
          {act.keep && <button className="button primary" onClick={() => resolveConflict(c, 'keep')}>{act.keep}</button>}</div>;
      })}
      {PREVIEW && <div className="preview-banner">Read-only device preview</div>}
      {view === 'Overview' ? <OverviewView ctx={ctx} openNew={() => setModal('new')} />
        : view === 'Graph' ? <GraphView ctx={ctx} openDrawing={() => setDrawing(true)} />
        : view === 'World' ? <WorldView ctx={ctx} />
        : view === 'Map' ? <Suspense fallback={<div className="boot"><Loader2 className="spin" size={18} /> Loading the map workspace…</div>}><MapWorkspace ctx={ctx} /></Suspense>
        : view === 'Explore' ? <ExploreView ctx={ctx} openMatch={openMatch} request={exploreRequest} />
        : view === 'Watchlist' ? <Suspense fallback={<div className="boot"><Loader2 className="spin" size={18} /> Loading the watchlist…</div>}><WatchlistView ctx={ctx} /></Suspense>
        : view === 'Investigate' ? <Suspense fallback={<div className="boot"><Loader2 className="spin" size={18} /> Loading the investigation view…</div>}><InvestigateView ctx={ctx} /></Suspense>
        : view === 'Folders' ? <FoldersView ctx={ctx} folderId={folderId} setFolderId={setFolderId} openDrawing={() => setDrawing(true)} />
        : view === 'Timeline' ? <TimelineView ctx={ctx} />
        : <SettingsView ctx={ctx} setDevice={setStoredDevice} openDevicePreview={() => setModal('devices')} openRestore={openRestoreFile} saveInfo={saveLabel[shownState][0]} />}
    </main>
    {notice && <div className="toast" role="status"><Check size={14} />{notice}<button aria-label="Dismiss" onClick={() => setNotice('')}><X size={13} /></button></div>}

    {editor && <EventEditor key={editor.record.id + String(editor.record.longitude)} initial={editor.record} isNew={editor.isNew} links={editorLinks} onSave={saveRecord} onCancel={() => setEditor(null)} onDelete={deleteRecord}
      onPickLocation={draft => { setPickDraft({ ...editor, record: draft }); setEditor(null); if (editor.boardId !== bid) setBid(editor.boardId); setView('World'); }} />}
    {importOpen && <ImportWizard project={project} currentBoard={board} onImport={onImport} onRestore={list => { setImportOpen(false); setRestore(list); }} onClose={() => setImportOpen(false)} />}
    {restore && <RestoreModal incoming={restore} existing={projects} onClose={() => setRestore(null)} onRestore={ps => { setProjects(x => [...x, ...ps]); setRestore(null); setNotice(`Restored ${ps.length} project${ps.length === 1 ? '' : 's'}. Nothing existing was replaced.`); }} />}
    {drawing && <Drawing folders={board.folders} defaultFolderId={folderId} nodes={board.nodes} onClose={() => setDrawing(false)} onSave={(item, fid) => {
      patchBoard(b => fid && b.folders.some(f => f.id === fid) ? { ...b, folders: b.folders.map(f => (f.id === fid ? { ...f, items: [...f.items, item] } : f)) } : { ...b, folders: [...b.folders, { id: uid(), name: 'Drawings', items: [item] }] });
      setDrawing(false); setNotice('Sketch saved to the virtual folder.');
    }} />}
    {modal === 'devices' && <DevicePreview onClose={() => setModal('')} />}
    {modal === 'workspaces' && <Modal title="Choose workspace" onClose={() => setModal('')}><div className="link-list">{projects.map(p => <button key={p.id} onClick={() => { setPid(p.id); setBid(p.boards[0]?.id || ''); setModal(''); }}><Grid2X2 size={15} /><span><b>{p.name}</b><small>{p.description || 'Workspace'} · {p.boards.length} boards</small></span>{p.id === project.id && <Check size={14} />}</button>)}<button onClick={() => { setModal(''); createProject(); }}><Plus size={15} /><span><b>New project</b><small>A separate workspace</small></span></button></div></Modal>}
    {modal === 'new' && <Modal title="Create" onClose={() => setModal('')}><div className="modal-options">
      <button onClick={() => { setModal(''); createProject(); }}><Grid2X2 /><span><b>New project</b><small>A separate space for your work</small></span></button>
      <button onClick={() => { setModal(''); addBoard(); }}><Network /><span><b>New graph board</b><small>Connect ideas, entities and evidence</small></span></button>
      <button onClick={() => { setModal(''); addBoard('world'); }}><Globe2 /><span><b>New world board</b><small>Map sourced records over time</small></span></button>
      <button onClick={() => { setModal(''); setImportOpen(true); }}><Folder /><span><b>Import records</b><small>CSV, JSON, GeoJSON, UCDP GED</small></span></button>
    </div></Modal>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
