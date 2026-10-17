// Atlas workspace storage. data/projects.json is a small index (projects, their settings and board order);
// each board lives in its own file under data/boards/ with its own revision, so saving one board never
// rewrites, re-syncs or resends the others. No HTTP here, so the rules can be unit-tested.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const INDEX_FORMAT = 'atlas-workspace-index';
export const MILITARY_ID = 'military-workspace';
const AUTO_BACKUP_MS = 10 * 60 * 1000;
const LOCKED = ['EPERM', 'EBUSY', 'EACCES'];
const INDEX_NOTE = 'Board contents are in the boards folder next to this file, one file per board. To roll back, stop the host and copy a projects-*.json backup from the backups folder over this file; the host converts it again on start and keeps the replaced boards in backups.';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = (status, message) => Object.assign(new Error(message), { status });
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const revisionOf = text => (text == null ? 'empty' : crypto.createHash('sha256').update(text).digest('hex').slice(0, 16));
export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const metaOf = entry => { const { boards, ...meta } = entry; return meta; };
export const metaRevision = entry => revisionOf(JSON.stringify(metaOf(entry)));

/** Readable, Windows-safe file name for an id that stays unique where the file system ignores case. */
export function fileKey(id) {
  const slug = String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';
  return `${slug}-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8)}`;
}

export async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(tmp, file); return; } catch (e) {
      // OneDrive or antivirus can briefly lock files on Windows.
      if (attempt < 5 && LOCKED.includes(e.code)) { await sleep(120 * (attempt + 1)); continue; }
      await fs.writeFile(file, text, 'utf8');
      await fs.rm(tmp, { force: true });
      return;
    }
  }
}
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); } catch (e) {
      if (attempt < 8 && LOCKED.includes(e.code)) { await sleep(150 * (attempt + 1)); continue; }
      throw e;
    }
  }
}
async function readText(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const exists = file => fs.stat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });

export const militaryWorkspace = () => ({
  id: MILITARY_ID, name: 'Military', description: 'Public-interest historical research with sources and uncertainty visible.', createdAt: new Date().toISOString(),
  boards: [{ id: 'military-world', name: 'Global research map', kind: 'world', nodes: [], edges: [], events: [], links: [], imports: [], folders: [{ id: 'military-sources', name: 'Sources', items: [] }, { id: 'military-notes', name: 'Research notes', items: [] }] }],
});

/** Checks a v0.2 project list before conversion. Missing ids are filled in and duplicate ids renamed, because each board needs its own file. */
function prepareLegacy(raw) {
  const unique = (base, seen) => { let id = base; for (let n = 2; seen.has(id); n++) id = `${base}-${n}`; seen.add(id); return id; };
  const seenProjects = new Set();
  const out = raw.map((p, i) => {
    if (!isObj(p)) throw fail(500, `Entry ${i + 1} in data/projects.json is not a project. Atlas will not convert or overwrite the file.`);
    if (p.boards != null && !Array.isArray(p.boards)) throw fail(500, `Project "${p.name || p.id}" in data/projects.json has unreadable boards. Atlas will not convert or overwrite the file.`);
    const seenBoards = new Set();
    const boards = (p.boards || []).map((b, j) => {
      if (!isObj(b)) throw fail(500, `Board ${j + 1} of project "${p.name || p.id}" in data/projects.json is not a board. Atlas will not convert or overwrite the file.`);
      return { ...b, id: unique(typeof b.id === 'string' && b.id ? b.id : `board-${j + 1}`, seenBoards) };
    });
    return { ...p, id: unique(typeof p.id === 'string' && p.id ? p.id : `project-${i + 1}`, seenProjects), boards };
  });
  if (!out.some(p => p.id === MILITARY_ID)) out.unshift(militaryWorkspace());
  return out;
}
const indexOf = projects => ({ format: INDEX_FORMAT, version: 3, note: INDEX_NOTE, projects: projects.map(p => ({ ...metaOf(p), boards: p.boards.map(b => b.id) })) });

/** Validates a whole workspace sent to the legacy PUT /api/workspace. */
function checkIncoming(projects) {
  const bad = () => fail(400, 'Expected { baseRevision, projects: [...] } with valid projects.');
  if (!Array.isArray(projects)) throw bad();
  const ids = new Set();
  for (const p of projects) {
    if (!isObj(p) || typeof p.id !== 'string' || !p.id || ids.has(p.id) || !Array.isArray(p.boards)) throw bad();
    ids.add(p.id);
    const bids = new Set();
    for (const b of p.boards) { if (!isObj(b) || typeof b.id !== 'string' || !b.id || bids.has(b.id)) throw bad(); bids.add(b.id); }
  }
}

export function createStore({ dataDir, log = console.log, autoBackupMs = AUTO_BACKUP_MS }) {
  const indexPath = path.join(dataDir, 'projects.json');
  const boardsDir = path.join(dataDir, 'boards');
  const backupDir = path.join(dataDir, 'backups');
  const boardPath = (pid, bid) => path.join(boardsDir, fileKey(pid), `${fileKey(bid)}.json`);
  const rel = file => path.relative(dataDir, file).split(path.sep).join('/');
  const revCache = new Map();
  let lastAuto = null;

  // Every operation runs one at a time, so a read never sees a half-applied save.
  let chain = Promise.resolve();
  const run = fn => { const job = chain.then(fn); chain = job.catch(() => {}); return job; };

  // ---------- backups ----------
  async function listBackups() {
    try {
      const names = (await fs.readdir(backupDir)).filter(n => n.endsWith('.json'));
      const stats = await Promise.all(names.map(async name => {
        const s = await fs.stat(path.join(backupDir, name));
        return { name, bytes: s.size, mtime: new Date(s.mtimeMs).toISOString() };
      }));
      return stats.sort((a, b) => b.mtime.localeCompare(a.mtime) || b.name.localeCompare(a.name));
    } catch { return []; }
  }
  async function writeBackup(name, text) {
    await fs.mkdir(backupDir, { recursive: true });
    const ext = path.extname(name), base = name.slice(0, -ext.length);
    for (let n = 1; ; n++) {
      const file = path.join(backupDir, n === 1 ? name : `${base}-${n}${ext}`);
      try { await fs.writeFile(file, text, { encoding: 'utf8', flag: 'wx' }); return file; } catch (e) { if (e.code !== 'EEXIST' || n > 99) throw e; }
    }
  }
  async function prune(prefix, keep) {
    for (const b of (await listBackups()).filter(x => x.name.startsWith(prefix)).slice(keep)) await fs.rm(path.join(backupDir, b.name), { force: true });
  }

  // ---------- board files ----------
  async function boardRevision(file) {
    let st;
    try { st = await fs.stat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const hit = revCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.revision;
    const revision = revisionOf(await fs.readFile(file, 'utf8'));
    revCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, revision });
    return revision;
  }
  async function writeBoard(pid, board) {
    const file = boardPath(pid, board.id), text = JSON.stringify(board);
    await writeAtomic(file, text);
    const st = await fs.stat(file);
    revCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, revision: revisionOf(text) });
    return revisionOf(text);
  }
  async function readBoardText(pid, bid) {
    const file = boardPath(pid, bid), text = await readText(file);
    if (text == null) throw fail(500, `Board file ${rel(file)} (board "${bid}") is missing. Atlas will not change the workspace until it is restored from data/backups.`);
    return { file, text };
  }
  function parseBoard(text, file) {
    try { return JSON.parse(text); } catch (e) { throw fail(500, `${rel(file)} is not valid JSON (${e.message}). Atlas will not overwrite it. Restore it from data/backups.`); }
  }
  /** One board saved in the 'atlas-project' format, so Settings → Restore from backup can bring it back. */
  async function backupBoard(entry, bid, reason) {
    const file = boardPath(entry.id, bid), text = await readText(file);
    if (text == null) return;
    let board;
    try { board = JSON.parse(text); } catch { await writeBackup(`board-${reason}-${stamp()}-${fileKey(bid)}.json`, text); return; }
    const why = reason === 'before-delete' ? 'before it was deleted' : 'before another device’s version replaced it';
    await writeBackup(`board-${reason}-${stamp()}-${fileKey(bid)}.json`, JSON.stringify({
      format: 'atlas-project', version: 2, exportedAt: new Date().toISOString(),
      note: `Board "${board?.name || bid}" saved by the Atlas host ${why}. Open it with Settings → Restore from backup.`,
      project: { ...metaOf(entry), boards: [board] },
    }, null, 2));
    await prune(`board-${reason}-`, reason === 'before-delete' ? 50 : 30);
  }
  /** A file at a board's path that the index does not list (left by an interrupted save) is kept before it is replaced. */
  async function keepOrphan(file) {
    const text = await readText(file);
    if (text != null) await writeBackup(`board-orphan-${stamp()}-${path.basename(file)}`, text);
  }

  // ---------- index and one-time conversion ----------
  const writeIndex = index => writeAtomic(indexPath, JSON.stringify(index, null, 2));
  async function hasBoardFiles() {
    try { return (await fs.readdir(boardsDir)).length > 0; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  }
  async function convertLegacy(text, raw) {
    const projects = prepareLegacy(raw);
    let backupName = '';
    if (text != null) {
      const file = await writeBackup(`projects-before-split-${stamp()}.json`, text);
      if (await fs.readFile(file, 'utf8') !== text) throw fail(500, 'Could not verify the backup of data/projects.json, so nothing was converted.');
      backupName = path.basename(file);
    }
    for (const name of await fs.readdir(dataDir)) if (/^boards-staging-\d+$/.test(name)) await fs.rm(path.join(dataDir, name), { recursive: true, force: true });
    const staging = path.join(dataDir, `boards-staging-${Date.now()}`);
    const written = [];
    for (const p of projects) for (const b of p.boards) {
      const file = path.join(staging, fileKey(p.id), `${fileKey(b.id)}.json`), t = JSON.stringify(b);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, t, 'utf8');
      written.push([file, t]);
    }
    await fs.mkdir(staging, { recursive: true });
    for (const [file, t] of written) if (await fs.readFile(file, 'utf8') !== t) throw fail(500, 'Could not verify the converted board files, so data/projects.json was left unchanged.');
    if (await exists(boardsDir)) {
      await fs.mkdir(backupDir, { recursive: true });
      let aside = path.join(backupDir, `boards-replaced-${stamp()}`);
      for (let n = 2; await exists(aside); n++) aside = path.join(backupDir, `boards-replaced-${stamp()}-${n}`);
      await renameRetry(boardsDir, aside);
      log(`Atlas: the previous board files were moved to ${rel(aside)} before conversion.`);
    }
    await renameRetry(staging, boardsDir);
    revCache.clear();
    // Written last: if anything above fails, projects.json is untouched and the conversion simply runs again.
    await writeIndex(indexOf(projects));
    if (text != null) log(`Atlas: converted data/projects.json to one file per board (${written.length} boards). The original is kept as data/backups/${backupName}.`);
  }
  /** Reads the index, converting a v0.2 file or creating the default workspace first. Only call inside run(). */
  async function loadIndex() {
    const text = await readText(indexPath);
    if (text == null) {
      if (await hasBoardFiles()) throw fail(500, 'data/projects.json is missing, but data/boards still holds board files. Atlas will not start a new workspace over them. Stop the host and copy the newest projects-*.json from data/backups to data/projects.json.');
      await convertLegacy(null, []);
      return loadIndex();
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw fail(500, `data/projects.json is not valid JSON (${e.message}). Atlas will not overwrite it. Restore a copy from data/backups.`); }
    if (Array.isArray(parsed)) { await convertLegacy(text, parsed); return loadIndex(); }
    const valid = isObj(parsed) && parsed.format === INDEX_FORMAT && Array.isArray(parsed.projects)
      && parsed.projects.every(p => isObj(p) && typeof p.id === 'string' && Array.isArray(p.boards) && p.boards.every(b => typeof b === 'string'));
    if (!valid) throw fail(500, 'data/projects.json is not a workspace this Atlas version can read. Atlas will not overwrite it. Restore a copy from data/backups.');
    if (!parsed.projects.some(p => p.id === MILITARY_ID)) {
      // The default workspace is never removed; putting it back only adds files.
      const m = militaryWorkspace();
      for (const b of m.boards) { await keepOrphan(boardPath(m.id, b.id)); await writeBoard(m.id, b); }
      parsed.projects.unshift({ ...metaOf(m), boards: m.boards.map(b => b.id) });
      await writeIndex(parsed);
      return loadIndex();
    }
    return { text, index: parsed };
  }

  // ---------- reading ----------
  async function manifestOf({ text, index }) {
    const all = [];
    const projects = [];
    for (const entry of index.projects) {
      const boards = [];
      for (const bid of entry.boards) {
        const revision = await boardRevision(boardPath(entry.id, bid));
        if (revision == null) await readBoardText(entry.id, bid); // throws the "missing board file" error
        boards.push({ id: bid, revision });
        all.push(revision);
      }
      projects.push({ id: entry.id, revision: metaRevision(entry), meta: metaOf(entry), boards });
    }
    return { revision: revisionOf(`${text}\n${all.join('\n')}`), projects };
  }
  async function assemble(index) {
    const projects = [];
    for (const entry of index.projects) {
      const boards = [];
      for (const bid of entry.boards) { const { file, text } = await readBoardText(entry.id, bid); boards.push(parseBoard(text, file)); }
      projects.push({ ...metaOf(entry), boards });
    }
    return projects;
  }
  /** A full snapshot in the old single-file format, at most once per interval while edits are being saved. */
  async function autoBackupIfDue(index) {
    if (lastAuto == null) { const newest = (await listBackups()).find(b => b.name.startsWith('projects-auto-')); lastAuto = newest ? Date.parse(newest.mtime) : 0; }
    if (Date.now() - lastAuto < autoBackupMs) return;
    await writeBackup(`projects-auto-${stamp()}.json`, JSON.stringify(await assemble(index), null, 2));
    lastAuto = Date.now();
    await prune('projects-auto-', 40);
  }
  async function dataBytes() {
    let total = 0;
    const walk = async dir => {
      let items = [];
      try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) { const p = path.join(dir, it.name); if (it.isDirectory()) await walk(p); else if (it.name.endsWith('.json')) total += (await fs.stat(p)).size; }
    };
    try { total += (await fs.stat(indexPath)).size; } catch {}
    await walk(boardsDir);
    return total;
  }

  const savedAt = () => new Date().toISOString();
  const conflict = (reason, revision) => ({ conflict: true, reason, revision });

  return {
    paths: { dataDir, indexPath, boardsDir, backupDir },
    listBackups,
    dataBytes: () => run(dataBytes),
    init: () => run(async () => { await loadIndex(); }),
    manifest: () => run(async () => manifestOf(await loadIndex())),
    readWorkspace: () => run(async () => {
      const st = await loadIndex();
      const manifest = await manifestOf(st);
      return { revision: manifest.revision, projects: await assemble(st.index), manifest };
    }),
    /** Raw board text plus its revision, or null when the project or board does not exist. */
    readBoard: (pid, bid) => run(async () => {
      const { index } = await loadIndex();
      if (!index.projects.some(p => p.id === pid && p.boards.includes(bid))) return null;
      const { file, text } = await readBoardText(pid, bid);
      parseBoard(text, file);
      return { revision: revisionOf(text), text };
    }),

    /** Saves one board if the host still holds baseRevision ('new' for a board the host has never seen). */
    saveBoard: (pid, bid, board, baseRevision, force = false) => run(async () => {
      if (!isObj(board) || board.id !== bid) throw fail(400, 'Expected { baseRevision, board } where board.id matches the address.');
      const st = await loadIndex();
      const entry = st.index.projects.find(p => p.id === pid);
      if (!entry) return conflict('project-missing', 'missing');
      const file = boardPath(pid, bid), listed = entry.boards.includes(bid);
      const current = listed ? await boardRevision(file) : null;
      if (listed && current == null) await readBoardText(pid, bid);
      if (!force) {
        if (!listed && baseRevision !== 'new') return conflict('deleted', 'deleted');
        if (listed && baseRevision !== current) return conflict(baseRevision === 'new' ? 'exists' : 'changed', current);
      }
      const text = JSON.stringify(board), revision = revisionOf(text);
      if (listed && revision === current) return { ok: true, revision, savedAt: savedAt(), unchanged: true };
      await autoBackupIfDue(st.index);
      if (listed && baseRevision !== current) await backupBoard(entry, bid, 'before-overwrite');
      if (!listed) await keepOrphan(file);
      await writeBoard(pid, board);
      if (!listed) { entry.boards.push(bid); await writeIndex(st.index); }
      return { ok: true, revision, savedAt: savedAt() };
    }),

    deleteBoard: (pid, bid, baseRevision, force = false) => run(async () => {
      const st = await loadIndex();
      const entry = st.index.projects.find(p => p.id === pid);
      if (!entry) return conflict('project-missing', 'missing');
      if (!entry.boards.includes(bid)) return { ok: true, revision: 'deleted', savedAt: savedAt(), unchanged: true };
      const file = boardPath(pid, bid), current = await boardRevision(file);
      if (!force && baseRevision !== current) return conflict('changed', current);
      if (entry.boards.length <= 1) return conflict('last-board', current);
      await autoBackupIfDue(st.index);
      await backupBoard(entry, bid, 'before-delete');
      entry.boards = entry.boards.filter(x => x !== bid);
      await writeIndex(st.index);
      await fs.rm(file, { force: true });
      revCache.delete(file);
      return { ok: true, revision: 'deleted', savedAt: savedAt() };
    }),

    /** Saves a project's own settings (name, description, …). Its boards are saved separately. */
    saveProject: (pid, meta, baseRevision, force = false) => run(async () => {
      if (!isObj(meta) || (meta.id != null && meta.id !== pid)) throw fail(400, 'Expected { baseRevision, project } where project.id matches the address.');
      const { boards: _ignored, ...fields } = meta;
      const next = { ...fields, id: pid }, revision = revisionOf(JSON.stringify(next));
      const st = await loadIndex();
      const i = st.index.projects.findIndex(p => p.id === pid);
      if (i < 0 && !force && baseRevision !== 'new') return conflict('deleted', 'deleted');
      if (i >= 0) {
        const current = metaRevision(st.index.projects[i]);
        if (!force && baseRevision !== current) return conflict(baseRevision === 'new' ? 'exists' : 'changed', current);
        if (revision === current) return { ok: true, revision, savedAt: savedAt(), unchanged: true };
      }
      await autoBackupIfDue(st.index);
      if (i < 0) st.index.projects.push({ ...next, boards: [] });
      else st.index.projects[i] = { ...next, boards: st.index.projects[i].boards };
      await writeIndex(st.index);
      return { ok: true, revision, savedAt: savedAt() };
    }),

    /**
     * Deletes a project and its boards, but only if the host still holds exactly what this device saw: its settings
     * revision and the revision of every board (a board added or changed elsewhere blocks it). The whole project is
     * backed up first in a form Settings → Restore from backup can bring back. The default workspace is never deleted.
     */
    deleteProject: (pid, baseRevision, boardRevisions = {}, force = false) => run(async () => {
      if (pid === MILITARY_ID) return conflict('protected', 'protected');
      const st = await loadIndex();
      const entry = st.index.projects.find(p => p.id === pid);
      if (!entry) return { ok: true, revision: 'deleted', savedAt: savedAt(), unchanged: true };
      const current = metaRevision(entry);
      if (!force) {
        const known = isObj(boardRevisions) ? boardRevisions : {};
        const same = Object.keys(known).length === entry.boards.length && (await Promise.all(entry.boards.map(async bid => known[bid] === await boardRevision(boardPath(pid, bid))))).every(Boolean);
        if (baseRevision !== current || !same) return conflict('changed', current);
      }
      await autoBackupIfDue(st.index);
      const boards = [];
      for (const bid of entry.boards) {
        const text = await readText(boardPath(pid, bid));
        if (text != null) { try { boards.push(JSON.parse(text)); } catch { boards.push({ id: bid, unreadable: text }); } }
      }
      await writeBackup(`project-before-delete-${stamp()}-${fileKey(pid)}.json`, JSON.stringify({
        format: 'atlas-project', version: 2, exportedAt: new Date().toISOString(),
        note: `Project "${entry.name || pid}" saved by the Atlas host before it was deleted. Open it with Settings → Restore from backup.`,
        project: { ...metaOf(entry), boards },
      }, null, 2));
      await prune('project-before-delete-', 30);
      st.index.projects = st.index.projects.filter(p => p.id !== pid);
      await writeIndex(st.index);
      const dir = path.join(boardsDir, fileKey(pid));
      for (const [file] of revCache) if (file.startsWith(dir + path.sep)) revCache.delete(file);
      await fs.rm(dir, { recursive: true, force: true });
      return { ok: true, revision: 'deleted', savedAt: savedAt() };
    }),

    /**
     * Whole-workspace save kept for pages loaded from Atlas 0.2. Only changed boards are written; boards missing
     * from a sent project are deleted (with a backup); projects missing from the request are kept.
     */
    saveWorkspace: (projects, baseRevision, force = false) => run(async () => {
      checkIncoming(projects);
      const st = await loadIndex();
      const current = await manifestOf(st);
      if (!force && baseRevision !== current.revision) return conflict('changed', current.revision);
      if (force) {
        await writeBackup(`projects-before-overwrite-${stamp()}.json`, JSON.stringify(await assemble(st.index), null, 2));
        await prune('projects-before-overwrite-', 20);
      } else await autoBackupIfDue(st.index);
      const removed = [];
      const entries = [];
      for (const p of projects) {
        const entry = st.index.projects.find(e => e.id === p.id);
        const before = entry ? entry.boards : [];
        for (const b of p.boards) {
          const file = boardPath(p.id, b.id);
          if (before.includes(b.id)) { if (revisionOf(JSON.stringify(b)) === await boardRevision(file)) continue; }
          else await keepOrphan(file);
          await writeBoard(p.id, b);
        }
        for (const bid of before) if (!p.boards.some(b => b.id === bid)) { await backupBoard(entry, bid, 'before-delete'); removed.push(boardPath(p.id, bid)); }
        entries.push({ ...metaOf(p), boards: p.boards.map(b => b.id) });
      }
      for (const e of st.index.projects) if (!projects.some(p => p.id === e.id)) entries.push(e);
      st.index.projects = entries;
      await writeIndex(st.index);
      for (const file of removed) { await fs.rm(file, { force: true }); revCache.delete(file); }
      return { ok: true, revision: (await manifestOf(await loadIndex())).revision, savedAt: savedAt() };
    }),
  };
}
