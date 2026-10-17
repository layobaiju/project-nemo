import { useEffect, useState } from 'react';
import { ArrowDownToLine, FileUp, KeyRound, MonitorSmartphone, RefreshCw, Shield, Trash2, Wifi } from 'lucide-react';
import type { Ctx, Device } from '../ctx.ts';
import { forgetDevice, getHostInfo, rotateAccessCode, type HostInfo } from '../api.ts';

const SERVICES: [string, string, string][] = [
  ['OpenFreeMap (basemap tiles, styles, fonts)', 'Free public instance; no key, registration or view limits. Attribution required (shown on the map). Needs internet on the Windows host.', 'https://openfreemap.org/'],
  ['OpenStreetMap data (in the basemap)', 'ODbL 1.0, © OpenStreetMap contributors; via OpenMapTiles schema.', 'https://www.openstreetmap.org/copyright'],
  ['Natural Earth country outlines (offline fallback)', 'Public domain; bundled through the world-atlas package (ISC).', 'https://www.naturalearthdata.com/'],
  ['MapLibre GL JS', 'BSD-3-Clause. Worker file is served from this host.', 'https://maplibre.org/'],
  ['React Flow (@xyflow/react)', 'MIT. Its small attribution badge is hidden, which the MIT licence allows; the authors ask commercial users to consider supporting them.', 'https://reactflow.dev/'],
  ['React, lucide-react, topojson-client, Vite, TypeScript', 'MIT / ISC / Apache-2.0 open-source licences.', ''],
  ['Wikipedia (Explore page)', 'Article summaries and the links they cite. Text is CC BY-SA 4.0 and attributed on the page. Fetched by the Windows host only when you search; no account or key.', 'https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content'],
  ['Wikidata (Explore page)', 'Facts, dates, places, related events and database links, CC0. Queried live through the Wikidata API and Query Service.', 'https://www.wikidata.org/wiki/Wikidata:Licensing'],
  ['GDELT Project (Explore news)', 'Free index of news articles since 2017; cite the GDELT Project. Allows one request every 5 seconds, so the news list can be busy.', 'https://www.gdeltproject.org/'],
  ['UCDP GED (optional import, not bundled)', 'CC BY 4.0. Cite UCDP and the GED version. The UCDP API needs a token, so Atlas imports the downloadable CSV instead.', 'https://ucdp.uu.se/downloads/'],
];

export default function SettingsView({ ctx, setDevice, openDevicePreview, openRestore, saveInfo }: { ctx: Ctx; setDevice: (d: Device) => void; openDevicePreview: () => void; openRestore: (file: File) => void; saveInfo: string }) {
  const { project } = ctx;
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [err, setErr] = useState('');
  const refresh = () => getHostInfo().then(setInfo).catch(e => setErr(e.message));
  useEffect(() => { refresh(); }, []);

  const rotate = async () => {
    if (!confirm('Create a new access code? Every Mac/iPad will need to enter the new code once.')) return;
    try { await rotateAccessCode(); refresh(); ctx.notify('New access code created.'); } catch (e) { ctx.notify((e as Error).message); }
  };
  const renameBoard = (id: string, name: string) => { const n = prompt('Board name', name); if (n?.trim()) ctx.patchBoard(b => ({ ...b, name: n.trim() }), id); };
  const isDefault = project.id === 'military-workspace';
  const deleteProject = () => {
    if (isDefault) { ctx.notify('The Military workspace is Atlas’s default and cannot be deleted.'); return; }
    const records = project.boards.reduce((n, b) => n + b.events.length, 0);
    if (!confirm(`Delete project “${project.name}” with ${project.boards.length} board(s) and ${records} record(s) on every device? The Windows host keeps a backup that Restore from backup can bring back.`)) return;
    ctx.setProjects(ps => ps.filter(p => p.id !== project.id));
    ctx.notify(`Deleted project “${project.name}”. A backup is kept on the Windows host.`);
  };
  const deleteBoard = (id: string, name: string, records: number) => {
    if (project.boards.length <= 1) { ctx.notify('A project needs at least one board.'); return; }
    if (!confirm(`Delete board “${name}” with ${records} record(s), its graph and folders? Host backups keep the earlier version.`)) return;
    ctx.setProjects(ps => ps.map(p => (p.id === project.id ? { ...p, boards: p.boards.filter(b => b.id !== id) } : p)));
    ctx.selectBoard(project.boards.find(b => b.id !== id)!.id);
  };

  return <section className="content settings">
    <div className="view-heading"><div><div className="eyebrow">PREFERENCES</div><h1>Settings</h1><p>Host, network access, data safety, devices and licensing.</p></div></div>

    <section className="settings-card">
      <h2><Wifi size={14} /> Windows host and LAN access</h2>
      <p>All project data lives on the Windows PC in the <code>data</code> folder: <code>projects.json</code> lists the projects, and each board is its own file in <code>data/boards</code>, so saving one board never resends the others. Mac and iPad open Atlas in a browser over the same private network; nothing is stored in the cloud.</p>
      {err && <div className="imp-error">{err}</div>}
      {info && <>
        <div><b>This device</b><span>{info.local ? 'The Windows host itself (no code needed)' : 'A LAN device (access granted)'}</span></div>
        <div><b>Open on Mac / iPad</b><span className="mono">{info.lanUrls.length ? info.lanUrls.join('  ·  ') : 'No LAN address found'}</span></div>
        <div><b>LAN access code</b><span>{info.codeRequired ? (info.local ? <><code className="code-big">{info.accessCode}</code> <button className="button subtle" onClick={rotate}><KeyRound size={13} /> New code</button></> : 'Required; this device is already approved.') : 'Disabled (ATLAS_LAN_CODE=off). Not recommended.'}</span></div>
        {!info.local && <div><b>This device</b><span><button className="button subtle" onClick={() => forgetDevice().then(() => location.reload())}>Forget access on this device</button></span></div>}
        <p className="settings-note"><Shield size={13} /> The host accepts only private-network addresses (192.168.x, 10.x, 172.16–31.x, Tailscale 100.64/10) and rejects unknown host names and cross-site requests. It has no TLS: use it only on a trusted home or office network, and never port-forward it.</p>
      </>}
    </section>

    <section className="settings-card">
      <h2>Data safety</h2>
      <div><b>Save status</b><span>{saveInfo}</span></div>
      {info?.storagePath && <div><b>Data folder</b><span className="mono">{info.storagePath} ({(info.dataBytes / 1024).toFixed(0)} KB)</span></div>}
      {info?.backupDir && <div><b>Automatic backups</b><span className="mono">{info.backupCount} in {info.backupDir} (a full copy every 10 minutes while editing, plus each board before it is replaced or deleted)</span></div>}
      {info?.backups?.length ? <details><summary>Recent backups</summary><ul className="mono small">{info.backups.map(b => <li key={b.name}>{b.name} · {(b.bytes / 1024).toFixed(0)} KB</li>)}</ul><p className="muted small">To roll back everything: stop the host, copy a projects-*.json backup over data/projects.json, start the host again. To bring back one board, open its board-*.json file with Restore from backup.</p></details> : null}
      <div><b>Workspace backup</b><span className="backup-actions">
        <button className="button subtle" onClick={() => (window.location.href = '/api/export')}><ArrowDownToLine size={14} /> Download full backup</button>
        <label className="button subtle"><input type="file" accept="application/json,.json" onChange={e => { const f = e.target.files?.[0]; if (f) openRestore(f); e.target.value = ''; }} /> Restore from backup…</label>
        <button className="button subtle" disabled={ctx.readOnly} onClick={ctx.openImport}><FileUp size={14} /> Import records…</button>
      </span></div>
    </section>

    <section className="settings-card">
      <h2>Project and boards</h2>
      <div><b>Project name</b><input className="plain-input" value={project.name} disabled={ctx.readOnly} onChange={e => ctx.setProjects(ps => ps.map(p => (p.id === project.id ? { ...p, name: e.target.value } : p)))} /></div>
      <div><b>Description</b><input className="plain-input" value={project.description} disabled={ctx.readOnly} onChange={e => ctx.setProjects(ps => ps.map(p => (p.id === project.id ? { ...p, description: e.target.value } : p)))} /></div>
      {project.boards.map(b => <div key={b.id}><b>{b.name}</b><span className="backup-actions"><small className="muted">{b.kind === 'world' ? 'World board' : 'Graph board'} · {b.events.length} records · {b.nodes.length} nodes</small><button className="button subtle" disabled={ctx.readOnly} onClick={() => renameBoard(b.id, b.name)}>Rename</button><button className="button subtle" aria-label={`Delete board ${b.name}`} disabled={ctx.readOnly} onClick={() => deleteBoard(b.id, b.name, b.events.length)}><Trash2 size={12} /></button></span></div>)}
      <div><b>Delete this project</b><span className="backup-actions">
        <small className="muted">{isDefault ? 'The Military workspace is Atlas’s default and cannot be deleted.' : 'Removes it from every device. The host keeps a backup.'}</small>
        <button className="button danger" disabled={ctx.readOnly || isDefault} onClick={deleteProject}><Trash2 size={12} /> Delete project</button>
      </span></div>
    </section>

    <section className="settings-card">
      <h2><MonitorSmartphone size={14} /> Devices</h2>
      <div><b>Interface mode on this device</b><span className="backup-actions"><select value={ctx.device} onChange={e => setDevice(e.target.value as Device)}><option>Windows</option><option>macOS</option><option>iPad</option></select><button className="button subtle" onClick={openDevicePreview}>Preview layouts…</button></span></div>
      <p className="settings-note">iPad mode enlarges touch targets and enables pencil-friendly drawing. Atlas picks a mode automatically; the choice is remembered per device. Tip for iPad: in Safari, use Share → Add to Home Screen for a full-screen app icon.</p>
    </section>

    <section className="settings-card">
      <h2>Services, licences and limits</h2>
      <ul className="service-list">{SERVICES.map(([name, terms, url]) => <li key={name}><b>{url ? <a href={url} target="_blank" rel="noreferrer">{name}</a> : name}</b><span>{terms}</span></li>)}</ul>
      <p className="settings-note">No paid service, trial, account or API key is used. Map layers display only records you enter or import; Atlas has no live feed and no complete global dataset. Similarity scores are heuristics, not assessments.</p>
    </section>

    <section className="settings-card">
      <h2>Research integrity</h2>
      <p>Cite a source for each material claim and link it to the field it supports. Mark attribution as alleged, claimed, suspected, disputed or confirmed. Keep casualty figures as sourced ranges with definitions. Keep interpretation in analyst notes. Do not add operational detail that could help someone cause harm.</p>
      <button className="button subtle" onClick={refresh}><RefreshCw size={13} /> Refresh host info</button>
    </section>
  </section>;
}
