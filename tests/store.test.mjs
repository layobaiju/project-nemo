// Host storage: one-time conversion, per-board revisions and backups. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, copyFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, fileKey, INDEX_FORMAT } from '../server/store.mjs';
import { emptyBoard } from './fixtures.mjs';

const quiet = () => {};
const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'atlas-store-'));
const legacy = () => [
  { id: 'military-workspace', name: 'Military', description: 'Default', createdAt: '2026-01-01T00:00:00.000Z', boards: [emptyBoard('military-world', 'Global research map')] },
  { id: 'p1', name: 'Field Notes', description: '', createdAt: '2026-01-02T00:00:00.000Z', boards: [emptyBoard('b1', 'World overview', [{ id: 'e1', name: 'Record one', x: 51, y: 42 }]), emptyBoard('b2', 'Interviews')] },
];
async function legacyDir(projects = legacy()) {
  const dir = await tmpDir();
  const text = JSON.stringify(projects, null, 2);
  await writeFile(path.join(dir, 'projects.json'), text);
  return { dir, text };
}
const backups = async dir => (await readdir(path.join(dir, 'backups'))).sort();
const boardFile = (dir, pid, bid) => path.join(dir, 'boards', fileKey(pid), `${fileKey(bid)}.json`);
const revs = async store => {
  const m = await store.manifest();
  return Object.fromEntries(m.projects.flatMap(p => [[p.id, p.revision], ...p.boards.map(b => [`${p.id}/${b.id}`, b.revision])]));
};

test('a v0.2 projects.json is converted once into per-board files, losslessly, after a verified backup', async () => {
  const { dir, text } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  const ws = await store.readWorkspace();
  assert.deepEqual(ws.projects, legacy());

  const index = JSON.parse(await readFile(path.join(dir, 'projects.json'), 'utf8'));
  assert.equal(index.format, INDEX_FORMAT);
  assert.deepEqual(index.projects.map(p => [p.id, p.boards]), [['military-workspace', ['military-world']], ['p1', ['b1', 'b2']]]);
  assert.deepEqual(JSON.parse(await readFile(boardFile(dir, 'p1', 'b1'), 'utf8')), legacy()[1].boards[0]);
  const split = (await backups(dir)).filter(n => n.startsWith('projects-before-split-'));
  assert.equal(split.length, 1);
  assert.equal(await readFile(path.join(dir, 'backups', split[0]), 'utf8'), text, 'the original file is kept byte for byte');

  // Opening it again does not convert or back up again.
  assert.deepEqual((await createStore({ dataDir: dir, log: quiet }).readWorkspace()).projects, legacy());
  assert.equal((await backups(dir)).filter(n => n.startsWith('projects-before-split-')).length, 1);
});

test('rolling back by copying a backup over projects.json converts again and keeps the replaced boards', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  const r = await revs(store);
  await store.saveBoard('p1', 'b1', { ...legacy()[1].boards[0], name: 'Edited after upgrade' }, r['p1/b1']);
  const [split] = (await backups(dir)).filter(n => n.startsWith('projects-before-split-'));
  await copyFile(path.join(dir, 'backups', split), path.join(dir, 'projects.json'));

  const after = createStore({ dataDir: dir, log: quiet });
  assert.deepEqual((await after.readWorkspace()).projects, legacy(), 'the rolled-back version is what the host now serves');
  const names = await backups(dir);
  const aside = names.find(n => n.startsWith('boards-replaced-'));
  assert.ok(aside, 'the replaced board files are moved into backups, not deleted');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'backups', aside, fileKey('p1'), `${fileKey('b1')}.json`), 'utf8')).name, 'Edited after upgrade');
});

test('conversion fixes missing and duplicate ids instead of letting boards overwrite each other', async () => {
  const { dir } = await legacyDir([{ id: 'p', name: 'P', boards: [emptyBoard('x', 'First'), emptyBoard('x', 'Second'), { ...emptyBoard('', 'No id'), id: undefined }] }, { id: 'p', name: 'Same id', boards: [] }]);
  const ws = await createStore({ dataDir: dir, log: quiet }).readWorkspace();
  const p = ws.projects.find(x => x.name === 'P');
  assert.deepEqual(p.boards.map(b => [b.id, b.name]), [['x', 'First'], ['x-2', 'Second'], ['board-3', 'No id']]);
  assert.deepEqual(ws.projects.map(x => x.id), ['military-workspace', 'p', 'p-2']);
});

test('unreadable or orphaned data is never overwritten', async () => {
  const bad = await tmpDir();
  await writeFile(path.join(bad, 'projects.json'), '[{"id": "p", ');
  await assert.rejects(createStore({ dataDir: bad, log: quiet }).readWorkspace(), e => e.status === 500 && /not valid JSON/.test(e.message));
  assert.equal(await readFile(path.join(bad, 'projects.json'), 'utf8'), '[{"id": "p", ');

  const orphaned = await tmpDir();
  await mkdir(path.join(orphaned, 'boards', 'x'), { recursive: true });
  await writeFile(path.join(orphaned, 'boards', 'x', 'b.json'), '{}');
  await assert.rejects(createStore({ dataDir: orphaned, log: quiet }).manifest(), /projects.json is missing/);
  await assert.rejects(stat(path.join(orphaned, 'projects.json')), { code: 'ENOENT' });
});

test('per-board revisions: a stale save conflicts on that board only, and forcing keeps a backup', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  const loaded = await revs(store); // both "devices" loaded this
  const [, p1] = legacy();

  const a = await store.saveBoard('p1', 'b1', { ...p1.boards[0], name: 'Device A edit' }, loaded['p1/b1']);
  assert.equal(a.ok, true);
  const b2 = await store.saveBoard('p1', 'b2', { ...p1.boards[1], name: 'Device B edit' }, loaded['p1/b2']);
  assert.equal(b2.ok, true, 'a save to another board is not blocked by device A’s save');

  const stale = await store.saveBoard('p1', 'b1', { ...p1.boards[0], name: 'Device B edit' }, loaded['p1/b1']);
  assert.deepEqual(stale, { conflict: true, reason: 'changed', revision: a.revision });
  assert.equal(JSON.parse(await readFile(boardFile(dir, 'p1', 'b1'), 'utf8')).name, 'Device A edit');

  const same = await store.saveBoard('p1', 'b1', { ...p1.boards[0], name: 'Device A edit' }, a.revision);
  assert.equal(same.unchanged, true, 'identical content is not rewritten');

  const forced = await store.saveBoard('p1', 'b1', { ...p1.boards[0], name: 'Device B edit' }, loaded['p1/b1'], true);
  assert.equal(forced.ok, true);
  const kept = (await backups(dir)).find(n => n.startsWith('board-before-overwrite-'));
  const backup = JSON.parse(await readFile(path.join(dir, 'backups', kept), 'utf8'));
  assert.equal(backup.format, 'atlas-project', 'restorable with Settings → Restore from backup');
  assert.equal(backup.project.boards[0].name, 'Device A edit');
});

test('new boards, project settings and deletions are revision-checked', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  let r = await revs(store);

  assert.equal((await store.saveBoard('p1', 'b3', emptyBoard('b3', 'New board'), 'new')).ok, true);
  assert.deepEqual((await store.manifest()).projects[1].boards.map(b => b.id), ['b1', 'b2', 'b3'], 'a new board is appended to its project');
  assert.equal((await store.saveBoard('p1', 'b3', emptyBoard('b3', 'Other'), 'new')).reason, 'exists');
  assert.equal((await store.saveBoard('p1', 'gone', emptyBoard('gone', 'Gone'), 'abc')).reason, 'deleted');
  assert.equal((await store.saveBoard('nope', 'x', emptyBoard('x', 'X'), 'new')).reason, 'project-missing');
  await assert.rejects(store.saveBoard('p1', 'b1', emptyBoard('other', 'Mismatch'), r['p1/b1']), e => e.status === 400);

  const renamed = await store.saveProject('p1', { id: 'p1', name: 'Renamed', description: 'x', createdAt: '2026-01-02T00:00:00.000Z' }, r.p1);
  assert.equal(renamed.ok, true);
  assert.equal((await store.saveProject('p1', { id: 'p1', name: 'Stale', description: '' }, r.p1)).reason, 'changed');
  assert.equal((await store.manifest()).projects[1].boards.length, 3, 'saving settings keeps the board list');
  assert.equal((await store.saveProject('p2', { id: 'p2', name: 'Second project', description: '' }, 'new')).ok, true);

  r = await revs(store);
  assert.equal((await store.deleteBoard('p1', 'b2', 'stale')).reason, 'changed');
  assert.equal((await store.deleteBoard('p1', 'b2', r['p1/b2'])).ok, true);
  await assert.rejects(stat(boardFile(dir, 'p1', 'b2')), { code: 'ENOENT' });
  const del = JSON.parse(await readFile(path.join(dir, 'backups', (await backups(dir)).find(n => n.startsWith('board-before-delete-'))), 'utf8'));
  assert.equal(del.project.boards[0].name, 'Interviews');
  assert.equal((await store.deleteBoard('military-workspace', 'military-world', r['military-workspace/military-world'])).reason, 'last-board');
});

test('the 0.2 whole-workspace save still works, is revision-checked and leaves unchanged boards alone', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  const { revision, projects } = await store.readWorkspace();
  const untouched = (await stat(boardFile(dir, 'p1', 'b2'))).mtimeMs;
  projects[1].boards[0].name = 'Whole-workspace edit';
  projects[1].boards.push(emptyBoard('b9', 'Added by an old page'));
  const ok = await store.saveWorkspace(projects, revision);
  assert.equal(ok.ok, true);
  assert.equal((await stat(boardFile(dir, 'p1', 'b2'))).mtimeMs, untouched);
  assert.deepEqual((await store.readWorkspace()).projects, projects);
  assert.equal((await store.saveWorkspace(projects, revision)).reason, 'changed', 'the old revision is now stale');
});

test('automatic backups are full snapshots in the single-file format and can be restored', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet, autoBackupMs: 0 });
  const r = await revs(store);
  await store.saveBoard('p1', 'b2', { ...legacy()[1].boards[1], name: 'After backup' }, r['p1/b2']);
  const auto = (await backups(dir)).find(n => n.startsWith('projects-auto-'));
  const snapshot = JSON.parse(await readFile(path.join(dir, 'backups', auto), 'utf8'));
  assert.deepEqual(snapshot, legacy(), 'the snapshot holds the state before the save');

  const restored = await tmpDir();
  await copyFile(path.join(dir, 'backups', auto), path.join(restored, 'projects.json'));
  assert.deepEqual((await createStore({ dataDir: restored, log: quiet }).readWorkspace()).projects, legacy());
});

test('deleting a project is revision-checked, backed up first and removes its board files', async () => {
  const { dir } = await legacyDir();
  const store = createStore({ dataDir: dir, log: quiet });
  const m = await store.manifest();
  const p1 = m.projects.find(p => p.id === 'p1');
  const known = Object.fromEntries(p1.boards.map(b => [b.id, b.revision]));

  // Another device changed a board after this device last saw it: refuse.
  await store.saveBoard('p1', 'b2', { ...legacy()[1].boards[1], name: 'Changed elsewhere' }, known.b2);
  assert.deepEqual(await store.deleteProject('p1', p1.revision, known), { conflict: true, reason: 'changed', revision: p1.revision });
  // A board added elsewhere also blocks it.
  const fresh = Object.fromEntries((await store.manifest()).projects.find(p => p.id === 'p1').boards.map(b => [b.id, b.revision]));
  await store.saveBoard('p1', 'b3', emptyBoard('b3', 'Added elsewhere'), 'new');
  assert.equal((await store.deleteProject('p1', p1.revision, fresh)).reason, 'changed');

  assert.equal((await store.deleteProject('military-workspace', 'x', {}, true)).reason, 'protected', 'the default workspace is never deleted');

  const ok = await store.deleteProject('p1', p1.revision, {}, true);
  assert.equal(ok.ok, true);
  assert.deepEqual((await store.manifest()).projects.map(p => p.id), ['military-workspace']);
  await assert.rejects(stat(path.join(dir, 'boards', fileKey('p1'))), { code: 'ENOENT' });
  const name = (await backups(dir)).find(n => n.startsWith('project-before-delete-'));
  const kept = JSON.parse(await readFile(path.join(dir, 'backups', name), 'utf8'));
  assert.equal(kept.format, 'atlas-project', 'restorable with Settings → Restore from backup');
  assert.deepEqual(kept.project.boards.map(b => b.name), ['World overview', 'Changed elsewhere', 'Added elsewhere']);
  assert.equal(kept.project.name, 'Field Notes');

  assert.equal((await store.deleteProject('p1', 'anything', {})).ok, true, 'deleting twice is harmless');
});
