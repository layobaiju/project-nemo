// Client save planning, remote pick-up and conflict wording. Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjects } from '../src/model.ts';
import { applyRemote, applySaved, baselineFrom, boardKey, conflictActions, conflictFor, conflictMessage, diffRemote, forgetProject, planSave, projectKey } from '../src/sync.ts';
import { emptyBoard, ucdpRecords } from './fixtures.mjs';

const BIG = ucdpRecords(5000);
function setup() {
  const projects = normalizeProjects([
    { id: 'p1', name: 'Research', description: '', boards: [emptyBoard('big', 'UCDP GED 2010–2019', BIG), emptyBoard('small', 'Small notes')] },
  ]);
  const manifest = { revision: 'w1', projects: [{ id: 'p1', revision: 'm1', meta: { id: 'p1', name: 'Research', description: '' }, boards: [{ id: 'big', revision: 'r-big' }, { id: 'small', revision: 'r-small' }] }] };
  return { projects, manifest, base: baselineFrom(projects, manifest) };
}
const editBoard = (projects, bid, fn) => projects.map(p => ({ ...p, boards: p.boards.map(b => (b.id === bid ? fn(b) : b)) }));

test('nothing is sent after loading, even though the 5,000-record board was normalised', () => {
  const { projects, base } = setup();
  assert.equal(projects[0].boards[0].events.length, 5000);
  assert.deepEqual(planSave(projects, base), []);
});

test('editing a small board sends only that board, never the 5,000-record one', () => {
  const { projects, base } = setup();
  const edited = editBoard(projects, 'small', b => ({ ...b, name: 'Small notes (edited)' }));
  const ops = planSave(edited, base);
  assert.deepEqual(ops.map(o => [o.kind, o.key, o.baseRevision]), [['board', boardKey('p1', 'small'), 'r-small']]);
  const body = JSON.stringify({ baseRevision: ops[0].baseRevision, board: ops[0].board, force: false });
  const bigBytes = JSON.stringify(projects[0].boards[0]).length;
  assert.ok(body.length < 1000, `request body is ${body.length} bytes`);
  assert.ok(bigBytes > 5_000_000, `the big board is ${bigBytes} bytes and stays on this device`);

  applySaved(base, ops[0], 'r-small-2');
  assert.deepEqual(planSave(edited, base), [], 'a saved board is not sent again');
});

test('editing the 5,000-record board sends only that board', () => {
  const { projects, base } = setup();
  const edited = editBoard(projects, 'big', b => ({ ...b, events: [...b.events.slice(1)] }));
  assert.deepEqual(planSave(edited, base).map(o => o.key), [boardKey('p1', 'big')]);
});

test('project settings, new boards and deleted boards are separate operations', () => {
  const { projects, base } = setup();
  const p = projects[0];
  const next = [{ ...p, name: 'Renamed', boards: [p.boards[0], emptyBoard('fresh', 'Fresh board')] }];
  const ops = planSave(next, base);
  assert.deepEqual(ops.map(o => [o.kind, o.key, o.baseRevision]), [
    ['project', projectKey('p1'), 'm1'],
    ['board', boardKey('p1', 'fresh'), 'new'],
    ['delete', boardKey('p1', 'small'), 'r-small'],
  ]);
  assert.equal('boards' in ops[0].meta, false, 'project settings never carry board contents');
});

test('a board in conflict waits while other boards keep saving; a project that failed to be created holds back its boards', () => {
  const { projects, base } = setup();
  const edited = editBoard(editBoard(projects, 'small', b => ({ ...b, name: 'x' })), 'big', b => ({ ...b, name: 'y' }));
  assert.deepEqual(planSave(edited, base, new Set([boardKey('p1', 'small')])).map(o => o.key), [boardKey('p1', 'big')]);

  const withNew = [...projects, ...normalizeProjects([{ id: 'p2', name: 'New project', boards: [emptyBoard('n1', 'N1')] }])];
  assert.deepEqual(planSave(withNew, base).map(o => o.key), [projectKey('p2'), boardKey('p2', 'n1')]);
  assert.deepEqual(planSave(withNew, base, new Set([projectKey('p2')])), []);
});

test('conflict banners name the affected board and offer the right choices', () => {
  const { projects, base } = setup();
  const [op] = planSave(editBoard(projects, 'small', b => ({ ...b, events: [] })), base);
  const c = conflictFor(op, 'changed');
  assert.equal(c.name, 'Small notes');
  assert.equal(conflictMessage(c), 'Board “Small notes” was changed on another device. Your recent edits to it here are not saved yet.');
  assert.deepEqual(conflictActions(c), { download: true, load: 'Load latest from host', keep: 'Keep this device’s version' });

  const [del] = planSave([{ ...projects[0], boards: [projects[0].boards[0]] }], base);
  const d = conflictFor(del, 'changed');
  assert.equal(d.reason, 'deleted-here');
  assert.match(conflictMessage(d), /^Board “Small notes” was deleted on this device, but another device changed it/);
  assert.match(conflictMessage({ ...c, reason: 'deleted' }), /^Board “Small notes” was deleted on another device/);
  assert.equal(conflictActions({ ...c, reason: 'last-board' }).keep, null);
});

const remote = (manifest, changes) => ({ ...manifest, projects: manifest.projects.map(p => ({ ...p, ...changes })) });

test('another device’s save to a clean board is downloaded alone and merged in host order', () => {
  const { projects, manifest, base } = setup();
  const m = remote(manifest, { boards: [{ id: 'small', revision: 'r-small-2' }, { id: 'big', revision: 'r-big' }, { id: 'added', revision: 'r-added' }] });
  const plan = diffRemote(m, base, projects);
  assert.deepEqual(plan.fetch, [{ pid: 'p1', bid: 'small' }, { pid: 'p1', bid: 'added' }], 'the unchanged 5,000-record board is not downloaded');
  assert.deepEqual(plan.conflicts, []);

  const fetched = [
    { pid: 'p1', bid: 'small', board: emptyBoard('small', 'Small notes (from Mac)'), revision: 'r-small-2' },
    { pid: 'p1', bid: 'added', board: emptyBoard('added', 'Added on iPad'), revision: 'r-added' },
  ];
  const r = applyRemote(projects, base, m, plan, fetched);
  assert.deepEqual(r.projects[0].boards.map(b => b.name), ['Small notes (from Mac)', 'UCDP GED 2010–2019', 'Added on iPad']);
  assert.equal(r.projects[0].boards[1], projects[0].boards[0], 'the big board object is untouched');
  assert.deepEqual(planSave(r.projects, base), [], 'merged boards are not sent back');
});

test('another device’s save to a board edited here becomes a conflict, not an overwrite', () => {
  const { projects, manifest, base } = setup();
  const edited = editBoard(projects, 'small', b => ({ ...b, name: 'Edited here' }));
  const m = remote(manifest, { boards: [{ id: 'big', revision: 'r-big' }, { id: 'small', revision: 'r-small-2' }] });
  const plan = diffRemote(m, base, edited);
  assert.deepEqual(plan.fetch, []);
  assert.deepEqual(plan.conflicts.map(c => [c.bid, c.reason, c.name]), [['small', 'changed', 'Edited here']]);

  // Edited between the manifest check and the download: still a conflict.
  const clean = diffRemote(m, base, projects);
  const late = applyRemote(edited, base, m, clean, [{ pid: 'p1', bid: 'small', board: emptyBoard('small', 'Theirs'), revision: 'r-small-2' }]);
  assert.equal(late.projects[0].boards[1].name, 'Edited here');
  assert.deepEqual(late.conflicts.map(c => c.bid), ['small']);

  // "Load latest from host" takes theirs on purpose.
  const taken = applyRemote(edited, base, m, clean, [{ pid: 'p1', bid: 'small', board: emptyBoard('small', 'Theirs'), revision: 'r-small-2' }], new Set([boardKey('p1', 'small')]));
  assert.equal(taken.projects[0].boards[1].name, 'Theirs');
  assert.equal(base.boards.get(boardKey('p1', 'small')).revision, 'r-small-2');
});

test('boards deleted elsewhere are removed when clean and kept as a conflict when edited here', () => {
  const { projects, manifest, base } = setup();
  const m = remote(manifest, { boards: [{ id: 'big', revision: 'r-big' }] });
  const clean = applyRemote(projects, base, m, diffRemote(m, base, projects), []);
  assert.deepEqual(clean.projects[0].boards.map(b => b.id), ['big']);

  const fresh = setup();
  const edited = editBoard(fresh.projects, 'small', b => ({ ...b, name: 'Still needed' }));
  const plan = diffRemote(m, fresh.base, edited);
  assert.deepEqual(plan.conflicts.map(c => [c.bid, c.reason]), [['small', 'deleted']]);
  assert.deepEqual(plan.remove, []);
});

function twoProjects() {
  const projects = normalizeProjects([
    { id: 'p1', name: 'Research', description: '', boards: [emptyBoard('a', 'Board A')] },
    { id: 'p2', name: 'Scratch', description: '', boards: [emptyBoard('b', 'Board B'), emptyBoard('c', 'Board C')] },
  ]);
  const manifest = { revision: 'w', projects: [
    { id: 'p1', revision: 'm1', meta: { id: 'p1', name: 'Research', description: '' }, boards: [{ id: 'a', revision: 'ra' }] },
    { id: 'p2', revision: 'm2', meta: { id: 'p2', name: 'Scratch', description: '' }, boards: [{ id: 'b', revision: 'rb' }, { id: 'c', revision: 'rc' }] },
  ] };
  return { projects, manifest, base: baselineFrom(projects, manifest) };
}

test('deleting a project sends one deletion carrying every board revision, and nothing for its boards', () => {
  const { projects, base } = twoProjects();
  const ops = planSave(projects.filter(p => p.id !== 'p2'), base);
  assert.deepEqual(ops.map(o => [o.kind, o.key, o.baseRevision, o.name]), [['delete-project', projectKey('p2'), 'm2', 'Scratch']]);
  assert.deepEqual(ops[0].boardRevisions, { b: 'rb', c: 'rc' });
  applySaved(base, ops[0], 'deleted');
  assert.equal(base.projects.has('p2'), false);
  assert.equal([...base.boards.values()].some(b => b.pid === 'p2'), false);
  assert.deepEqual(planSave(projects.filter(p => p.id !== 'p2'), base), []);
});

test('project deletion conflicts name the project and offer the right choices', () => {
  const { projects, base } = twoProjects();
  const [op] = planSave(projects.filter(p => p.id !== 'p2'), base);
  const here = conflictFor(op, 'changed');
  assert.deepEqual([here.kind, here.reason, here.name], ['project', 'deleted-here', 'Scratch']);
  assert.equal(conflictMessage(here), 'Project “Scratch” was deleted on this device, but another device changed it in the meantime.');
  assert.deepEqual(conflictActions(here), { download: false, load: 'Restore the host’s version', keep: 'Delete it anyway' });
  assert.equal(conflictMessage(conflictFor(op, 'protected')), 'Project “Scratch” is Atlas’s default workspace and cannot be deleted.');
});

test('a project deleted on another device disappears here, unless it was edited here', () => {
  const { projects, manifest, base } = twoProjects();
  const gone = { ...manifest, projects: manifest.projects.filter(p => p.id !== 'p2') };
  const clean = applyRemote(projects, base, gone, diffRemote(gone, base, projects), []);
  assert.deepEqual(clean.projects.map(p => p.id), ['p1']);
  assert.equal(base.projects.has('p2'), false);

  const again = twoProjects();
  const edited = again.projects.map(p => (p.id === 'p2' ? { ...p, boards: [{ ...p.boards[0], name: 'Edited here' }, p.boards[1]] } : p));
  const plan = diffRemote(gone, again.base, edited);
  assert.deepEqual(plan.conflicts.map(c => [c.kind, c.reason, c.name]), [['project', 'deleted', 'Scratch']]);
  assert.match(conflictMessage(plan.conflicts[0]), /^Project “Scratch” was deleted on another device/);

  // "Keep this device's version": forget what the host had, so the next save creates the project again.
  forgetProject(again.base, 'p2');
  assert.deepEqual(planSave(edited, again.base).map(o => [o.kind, o.key, o.baseRevision]), [
    ['project', projectKey('p2'), 'new'], ['board', boardKey('p2', 'b'), 'new'], ['board', boardKey('p2', 'c'), 'new'],
  ]);
});

test('changing entity decisions sends one project save and no board saves', () => {
  const { projects, base } = setup();
  const edited = projects.map(p => ({ ...p, entityDecisions: { merges: [], distinct: [['n:actor:a', 'n:actor:b']] } }));
  assert.deepEqual(planSave(edited, base).map(o => [o.kind, o.key]), [['project', projectKey('p1')]]);
});
