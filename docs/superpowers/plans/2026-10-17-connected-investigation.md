# Connected Investigation View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Investigate page that shows each person, organisation, place and event in a project, along with its
records, connections, map, timeline, sources and folder material. Possible duplicates are suggested for the user to
merge.

**Architecture:**
- Entities are derived in a pure module (`src/entities.ts`) from graph nodes, record actors and record countries.
- Only the user's merge and "not the same" decisions are stored, in the project's settings (`project.entityDecisions`).
  They are saved by the existing revision-checked project save.
- The page is lazy-loaded.
- Graph and World only learn to show an in-memory focus chip.

**Tech Stack:** React 18 + TypeScript (Vite), MapLibre (existing `InteractiveMap`), `node:test` with type stripping.

**Spec:** `docs/superpowers/specs/2026-10-17-connected-investigation-design.md`

## Global Constraints

- **Test imports:** TS files imported by tests use `import type` for types and `.ts` extensions in import paths. Run
  tests with `npm.cmd test` and build with `npm.cmd run build`. On Windows, use `npm.cmd`, not `npm`.
- **Records and nodes are never modified** by entity features: merging is link-only.
- **Decisions go in `project.entityDecisions`:**
  `{ merges: [{ id, keys: string[], name, at, by }], distinct: [[keyA, keyB]] }`.
- **No host changes.** Decisions travel in the existing `PUT /api/projects/:projectId`.
- **Copy for "listed together" lines:** *listed together on N records — not evidence of a relationship*.
- **Performance target:** `buildEntities` takes under 300 ms for a project holding a 5,000-record board.
- **Version:** 0.7.0 in `package.json`, `package-lock.json` (both version lines), `server/host.mjs` `VERSION`, and the
  README sample output.
- **No commits:** this folder is not a git repository, so there are no commit steps. Test on copied data, with the test
  host on port 4191, never the user's host on 4174.

## Review Focus

1. **Numbered names** (*Group 1* / *Group 11* in UCDP imports) must not flood the duplicates list. Excluded when their
   digits differ; tested in Task 2.
2. **Blank and repeated actors:** an empty or whitespace-only actor name, or the same actor twice on one record, must
   not create an empty entity or count a record twice. Tested in Task 1.
3. **Remembered selection:** a selected entity remembered from before a merge, an unmerge or a node deletion must
   still resolve through `byKey` or fall back cleanly. Tested in Task 3; the UI fallback is in Task 5.
4. **Edges inside an entity or with missing ends:** an edge between two nodes of the same entity, or to a missing node,
   must not create a self-connection or crash. Tested in Task 2.
5. **Malformed decisions:** junk in `entityDecisions` (from a hand-edited file or another version) is dropped, not
   thrown. A project that never had decisions must not gain the field on load, which would cause a save of every
   project. Tested in Task 3.

---

### Task 1: Entities from nodes, actors and countries

**Files:**
- Modify: `src/types.ts` (add `EntityDecisions`, `MergeDecision`; `Project.entityDecisions?`)
- Create: `src/entities.ts`
- Test: `tests/entities.test.mjs` (new; add to the `test` script in `package.json`, before `tests/host.test.mjs`)

**Interfaces:**
- Produces, in `src/types.ts`:

  ```ts
  export type MergeDecision = { id: string; keys: string[]; name: string; at: string; by: string };
  export type EntityDecisions = { merges: MergeDecision[]; distinct: [string, string][] };
  // Project gains: entityDecisions?: EntityDecisions
  ```

- Produces, in `src/entities.ts`:

  ```ts
  export type Family = 'actor' | 'place' | 'event';
  export type EntityKind = 'Person' | 'Organisation' | 'Other actor' | 'Place' | 'Event';
  export type Mention =
    | { type: 'node'; boardId: string; nodeId: string; name: string; kind: EntityKind; qid?: string }
    | { type: 'actor'; boardId: string; recordId: string; name: string; kind: EntityKind; role: string; attribution: string }
    | { type: 'country'; boardId: string; recordId: string; name: string; kind: 'Place' };
  export type RecordRef = { boardId: string; recordId: string; role: string };
  export type NodeRef = { boardId: string; nodeId: string };
  export type Entity = { key: string; keys: string[]; name: string; kind: EntityKind; family: Family; aliases: string[];
    qids: string[]; mentions: Mention[]; records: RecordRef[]; nodes: NodeRef[]; mergeId?: string; ambiguous?: string[] };
  export type EntityIndex = { entities: Entity[]; byKey: Map<string, Entity> };
  export const FAMILY: Record<EntityKind, Family>;
  export function nodeEntityKind(kind: string): EntityKind | null;
  export function actorEntityKind(type: string): EntityKind;
  export function nameKey(family: Family, name: string): string; // `n:${family}:${normalizeName(name)}`
  export function buildEntities(project: Project, decisions?: EntityDecisions): EntityIndex;
  export function entityRecords(project: Project, e: Entity): { boardId: string; record: EventItem; role: string }[];
  export function entitySources(project: Project, e: Entity): { evidence: Evidence; count: number }[];
  export function entityFolderItems(project: Project, e: Entity): { boardId: string; folder: string; item: FolderItem }[];
  ```

- Consumes: `normalizeName` from `src/model.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/entities.test.mjs`

  Use a helper `proj(boards)` that returns `normalizeProjects([{ id: 'p', name: 'P', description: '', boards }])[0]`.
  Build boards with `emptyBoard` from `tests/fixtures.mjs`, then add nodes, edges, events and folders. Make records
  with `newEvent({...})` from `src/model.ts`.

  ```js
  test('a Wikidata ID makes one entity across boards, and plain names join it', () => {
    // board A: node {label:'Osama bin Laden', kind:'Actor', wikidata:'Q1317'}
    // board B: node {label:'Usama bin Laden', kind:'Actor', wikidata:'Q1317'}, record with actor {name:'osama  BIN laden', type:'Individual', attribution:'Alleged'}
    const ix = buildEntities(p);
    const e = ix.byKey.get('wd:Q1317');
    assert.equal(e.kind, 'Person'); assert.deepEqual(e.qids, ['Q1317']);
    assert.equal(e.nodes.length, 2); assert.equal(e.records.length, 1);
    assert.equal(e.records[0].role, 'Actor · Alleged');
    assert.ok(e.aliases.includes('Usama bin Laden'));
    assert.equal(ix.byKey.get(nameKey('actor', 'Osama bin Laden')), e);
  });
  test('Person, Organisation and Other actor share names; places stay apart', () => {
    // node {label:'Al-Qaeda', kind:'Organisation'} (no QID); record actor {name:'Al-Qaeda', type:'Armed group'};
    // record actor {name:'al qaeda', type:''}; record countries ['Georgia']; record actor {name:'Georgia', type:'Individual'}
    // expect: one actor entity 'Al-Qaeda' (kind Organisation, 1 node, 2 records); 'Georgia' as Place and as Person are 2 entities
  });
  test('a name shared by two Wikidata entities is not guessed', () => {
    // nodes {John Smith, Q1} and {John Smith, Q2}; record actor 'John Smith'
    const ix = buildEntities(p);
    const plain = ix.byKey.get(nameKey('actor', 'John Smith'));
    assert.deepEqual(plain.ambiguous.sort(), ['wd:Q1', 'wd:Q2']);
    assert.notEqual(plain, ix.byKey.get('wd:Q1'));
  });
  test('display name prefers the Wikidata label, then the most common spelling', () => { /* 2× 'Hamas', 1× 'HAMAS' → name 'Hamas', aliases ['HAMAS'] */ });
  test('blank actors are skipped and a record counts once per entity', () => {
    // record with actors [{name:'  '}, {name:'Group X', role:'Side A'}, {name:'group x', role:'Side B'}] and countries ['Iraq','Iraq']
    // expect: no entity with empty name; Group X has records.length === 1; Iraq has records.length === 1
  });
  test('records linked through nodes, folder items and sources', () => {
    // node N (kind 'Historical event', recordId R1); record R2 with nodeId N; folder item linked to node N, another to R1, another to an unrelated record
    // R1 and R2 carry evidence with the same URL and one with a different URL
    // expect: entity records R1, R2 with role 'Linked node'; entityFolderItems → the 2 related items only;
    // entitySources → 2 rows, the shared URL with count 2 first
  });
  test('other node kinds make no entities', () => { /* kinds Note, Source, Claim → ix.entities.length === 0 */ });
  test('a project with a 5,000-record board builds quickly', () => {
    const p = proj([emptyBoard('big', 'UCDP', ucdpRecords(5000))]);
    const t = performance.now(); const ix = buildEntities(p); const ms = performance.now() - t;
    assert.ok(ms < 300, `${ms} ms`);
    assert.equal(ix.byKey.get(nameKey('place', 'Country 3')).records.length, 125);
  });
  ```

- [ ] **Step 2:** Run `node --test tests/entities.test.mjs`. Expected: FAIL (`src/entities.ts` not found).

- [ ] **Step 3: Implement `src/entities.ts`.**
  - **Mapping:**
    - Node kinds: `Actor` → Person, `Organisation` → Organisation, `Place` → Place, `Event` and `Historical event` →
      Event, anything else → `null`.
    - Actor types: `Individual` → Person, `Other / unknown` or empty → Other actor, any other type → Organisation.
  - **Mentions:** collected in board order, nodes before records. Names are trimmed. Mentions with an empty
    normalised name are skipped.
  - **Grouping:** follows the spec, steps 1–3.
    - A QID group indexes the name keys of its node labels.
    - A name-only mention joins the QID group when that name key belongs to exactly one QID. With two or more, the
      group is keyed by the name and carries `ambiguous` (the `wd:` keys).
  - **Record refs:** de-duplicated per `(boardId, recordId)`; the first role wins.
    - Roles are `Actor · <attribution or Unknown>`, `Country` and `Linked node`.
    - A node's linked records are `node.data.recordId` and every record whose `nodeId === node.id`.
  - **Entity fields:**
    - `key` is `wd:<first QID>`, else the name key. Task 3 adds `m:<mergeId>`.
    - `keys` holds every `wd:` key plus every mention's name key.
    - `byKey` maps every key, and `key` itself.
  - **Name, kind and aliases:**
    - The name is the most common label among QID node mentions, else the most common spelling. Ties go to the first
      seen.
    - The kind is the first QID node's kind, else the most common mention kind.
    - Aliases are the other distinct trimmed spellings.
  - **Sources:** de-duplicated by `normalizeUrl(url)`, or by `normalizeName(title)` when there is no URL. Sorted by
    count, highest first.
  - **Folder items:** items whose `nodeIds` (or legacy `nodeId`) include one of the entity's nodes, or whose
    `recordIds` include a record reached through a node (role `Linked node`).

- [ ] **Step 4:** Run `node --test tests/entities.test.mjs`. Expected: PASS, 8 tests.

### Task 2: Connections and duplicate suggestions

**Files:**
- Modify: `src/entities.ts`
- Test: `tests/entities.test.mjs`

**Interfaces:**
- Consumes: `EntityIndex`, `Entity`, `RecordRef` from Task 1; `EntityDecisions` from `src/types.ts`.
- Produces:

  ```ts
  export type GraphLink = { boardId: string; edgeId: string; relation: string; outgoing: boolean };
  export type Connection = { key: string; name: string; kind: EntityKind; graph: GraphLink[]; shared: { boardId: string; recordId: string }[] };
  export function connectionsOf(project: Project, index: EntityIndex, key: string, limit?: number): { shown: Connection[]; total: number }; // limit default 24
  export type DuplicateSuggestion = { a: string; b: string; reason: 'spelling' | 'contains' | 'same-name' };
  export function suggestDuplicates(index: EntityIndex, decisions?: EntityDecisions, limit?: number): DuplicateSuggestion[]; // limit default 200
  export function editDistance(a: string, b: string, max: number): number; // returns max + 1 when over max
  ```

- [ ] **Step 1: Write the failing tests**

  ```js
  test('graph links and listed-together connections, ranked', () => {
    // board: nodes A (Q1, Actor), B (Q2, Organisation), C (Q3, Actor); edges A→B {data:{relation:'member of'}}, A→A2 where A2 is a second node with Q1, A→'missing'
    // records r1, r2 list actors 'A-name' and 'Group Z'; r3 lists 'A-name' and country 'Iraq'
    const { shown, total } = connectionsOf(p, ix, 'wd:Q1');
    assert.equal(shown[0].key, 'wd:Q2'); assert.deepEqual(shown[0].graph.map(g => [g.relation, g.outgoing]), [['member of', true]]);
    assert.equal(shown[1].name, 'Group Z'); assert.equal(shown[1].shared.length, 2);
    assert.ok(!shown.some(c => c.key === 'wd:Q1'), 'no self-connection'); assert.equal(total, 3);
    assert.equal(connectionsOf(p, ix, 'wd:Q1', 1).shown.length, 1);
  });
  test('duplicate suggestions: spelling, containment, same name', () => {
    // actors 'Usama bin Ladin' and 'Osama bin Laden' → reason 'spelling'
    // 'bin Laden' and 'Osama bin Laden' → 'contains'; the ambiguous 'John Smith' → 'same-name' against wd:Q1 and wd:Q2
  });
  test('no suggestions for numbered names, short names, different Wikidata IDs, other families or distinct pairs', () => {
    // 'Group 1' vs 'Group 11'; 'Brigade 4' vs 'Brigade 5'; 'Hamas' vs 'Hama' (under 6 letters);
    // nodes 'Paris' Q90 vs 'Paris' Q830149 (different QIDs); Place 'Georgia' vs Person 'Georgie';
    // and 'Usama bin Ladin'/'Osama bin Laden' when decisions.distinct holds their keys → none of these appear
  });
  test('edit distance stops early', () => { assert.equal(editDistance('usama bin ladin', 'osama bin laden', 2), 2); assert.equal(editDistance('abcdef', 'uvwxyz', 2), 3); });
  ```

- [ ] **Step 2:** Run `node --test tests/entities.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - **Connections:**
    - Build `nodeOwner` (`boardId:nodeId` → entity) and `recordOwners` (`boardId:recordId` → entity set) from the
      index.
    - Graph links come from the edges whose two ends belong to different entities, one of them this one. The relation
      is `edge.data.relation`, else the label before ` · `, else `related to`.
    - Listed together means another entity on one of this entity's records.
    - Ranking: entities with graph links first, then by shared count (highest first), then by name.
  - **Suggestions:**
    - Compare within a family, considering at most the 3,000 entities with the most mentions per family.
    - **Skip a pair when:** both have QIDs and they don't overlap; their keys are a `distinct` pair (either order);
      or the digit strings of the two names differ.
    - **`spelling`:** both normalised names have at least 6 letters or digits, their lengths differ by at most 2, and
      `editDistance` is 2 or less.
    - **`contains`:** every word of the shorter name is in the longer one, and the shorter name has at least 5
      letters.
    - **`same-name`:** the ambiguous entity paired with each of its `ambiguous` keys.
    - **Order:** by the combined mention count, highest first, then cut to `limit`.

- [ ] **Step 4:** Run `node --test tests/entities.test.mjs`. Expected: PASS, 12 tests.

### Task 3: Merge decisions, saved with the project

**Files:**
- Modify: `src/entities.ts` (decision helpers; applying merges in `buildEntities`)
- Modify: `src/model.ts` (`normalizeDecisions`; `normalizeProjects` keeps the field only when present)
- Test: `tests/entities.test.mjs`, `tests/sync.test.mjs`

**Interfaces:**
- Produces:

  ```ts
  // src/model.ts
  export function normalizeDecisions(raw: unknown): EntityDecisions;
  // src/entities.ts
  export const emptyDecisions: () => EntityDecisions;
  export function mergeEntities(d: EntityDecisions, a: Entity, b: Entity, name: string, by: string, at?: string): EntityDecisions | null; // null when families differ
  export function unmerge(d: EntityDecisions, mergeId: string): EntityDecisions;
  export function markDistinct(d: EntityDecisions, a: Entity, b: Entity): EntityDecisions;
  ```

- [ ] **Step 1: Write the failing tests**

  ```js
  test('merge, overlapping merges, unmerge and remembered keys', () => {
    let d = mergeEntities(emptyDecisions(), usama, osama, 'Osama bin Laden', 'Windows', '2026-10-17T10:00:00Z');
    let ix = buildEntities(p, d); const m = ix.byKey.get(osama.key);
    assert.equal(m, ix.byKey.get(usama.key)); assert.equal(m.name, 'Osama bin Laden'); assert.equal(m.key, `m:${d.merges[0].id}`);
    assert.equal(m.records.length, usama.records.length + osama.records.length); assert.ok(m.aliases.includes('Usama bin Ladin'));
    d = mergeEntities(d, m, binLaden, 'Osama bin Laden', 'iPad');
    assert.equal(d.merges.length, 1, 'overlapping merges are combined');
    assert.equal(mergeEntities(d, m, iraqPlace, 'x', 'Windows'), null, 'actor + place refused');
    ix = buildEntities(p, unmerge(d, d.merges[0].id)); assert.notEqual(ix.byKey.get(usama.key), ix.byKey.get(osama.key));
  });
  test('a merge survives a node gaining a Wikidata ID and is inert when one side is gone', () => {
    // merge two name-only entities; then give one of their nodes wikidata 'Q5' → still one entity with key m:<id>
    // remove the other side's mentions entirely → buildEntities still works and the remaining entity has no mergeId
  });
  test('not the same', () => { const d = markDistinct(emptyDecisions(), usama, osama); assert.equal(suggestDuplicates(buildEntities(p, d), d).length, 0); });
  test('malformed decisions are dropped and absent decisions stay absent', () => {
    assert.deepEqual(normalizeDecisions({ merges: [{ keys: ['a'] }, null, { id: 'm', keys: ['a', 'b'], name: 'X', at: '', by: '' }], distinct: [['a'], ['a', 'b'], 7] }),
      { merges: [{ id: 'm', keys: ['a', 'b'], name: 'X', at: '', by: '' }], distinct: [['a', 'b']] });
    assert.deepEqual(normalizeDecisions('junk'), { merges: [], distinct: [] });
    assert.ok(!('entityDecisions' in normalizeProjects([{ id: 'p', name: 'P', boards: [] }])[0]));
  });
  ```

  In `tests/sync.test.mjs`:

  ```js
  test('changing entity decisions sends one project save and no board saves', () => {
    const { projects, base } = setup();
    const edited = projects.map(p => ({ ...p, entityDecisions: { merges: [], distinct: [['n:actor:a', 'n:actor:b']] } }));
    assert.deepEqual(planSave(edited, base).map(o => o.kind), ['project']);
  });
  ```

- [ ] **Step 2:** Run `node --test tests/entities.test.mjs tests/sync.test.mjs`. Expected: the new entities tests FAIL.
  The sync test may already pass, because the project meta is free-form; that confirms no sync change is needed.

- [ ] **Step 3: Implement.**
  - **Applying merges in `buildEntities`:** after grouping, union-find over the groups. Each merge unions every
    group that has any of its `keys`. A union across families is ignored.
  - **A merged entity** (two or more groups) gets `key: 'm:'+id`, `mergeId`, the merge's `name`, and `keys`
    including `m:` + id.
  - **`mergeEntities`:**
    - Store `[...a.keys, ...b.keys]`, de-duplicated.
    - Drop existing merges whose keys overlap and fold their keys in.
    - `id = uid()`, `at` defaults to `nowIso()`.
  - **`markDistinct`:** add `[a.key, b.key]`, sorted. Suggestions also skip a pair when any key of one entity and any
    key of the other form a distinct pair.
  - **`normalizeProjects`:** `...(p.entityDecisions != null ? { entityDecisions: normalizeDecisions(p.entityDecisions) } : {})`.

- [ ] **Step 4:** Run `npm.cmd test`. Expected: all tests PASS (83 earlier plus the new ones).

### Task 4: Shell: Investigate entry, focus and project patching

**Files:**
- Modify: `src/ctx.ts`, `src/main.tsx`
- Modify: `src/InteractiveMap.tsx` (optional props for a compact, fit-to-records map)
- Create: `src/components/InvestigateView.tsx` (stub: heading only; filled in Task 5)

**Interfaces:**
- Produces, in `src/ctx.ts`:

  ```ts
  export type View = 'Overview' | 'Graph' | 'World' | 'Map' | 'Explore' | 'Investigate' | 'Folders' | 'Timeline' | 'Settings';
  export type Focus = { label: string; nodeIds: string[]; recordIds: string[]; n: number };
  // Ctx gains:
  focus: Focus | null; setFocus: (f: Focus | null) => void;
  patchProject: (fn: (p: Project) => Project) => void; // current project's own fields; no-op in preview
  ```

- Produces, in `src/InteractiveMap.tsx`, optional props:
  - `onAddAt?`: when it is absent, clicking empty map does nothing;
  - `fit?: { bounds: [[number, number], [number, number]]; n: number }`: `fitBounds` with padding 40 and `maxZoom` 8
    when `n` changes, and once after the style loads;
  - `compact?: boolean`: hides the operation note.

- [ ] **Step 1:** Add the types and the ctx fields.
  - In `main.tsx`:
    - `const [focus, setFocus] = useState<Focus | null>(null)`;
    - `patchProject = fn => setProjects(ps => ps.map(p => (p.id === pid ? { ...fn(p), boards: p.boards } : p)))`;
    - a lazy `InvestigateView` with the fallback "Loading the investigation view…";
    - menu entry `['Investigate', ScanSearch]` after Explore (lucide `ScanSearch`).
  - `focus` is cleared when the project changes.
- [ ] **Step 2:** Add the `InteractiveMap` optional props. WorldView keeps passing `onAddAt`, so its behaviour is
  unchanged.
- [ ] **Step 3:** Run `npm.cmd run build`. Expected: `✓ built`, with a separate `InvestigateView-*.js` chunk.

### Task 5: The Investigate page

**Files:**
- Modify: `src/components/InvestigateView.tsx`: the page, entity list, profile, tabs, selection state.
- Create: `src/components/InvestigatePanes.tsx`: `ConnectionsDiagram` and `TimelineStrip`, pure SVG.
- Create: `src/components/EntityMerge.tsx`: `MergeDialog` and `DuplicatesList`.
- Modify: `src/components.css`: a block of classes prefixed `inv-`.

**Interfaces:**
- Consumes:
  - from Tasks 1–3: everything exported by `src/entities.ts`;
  - from Task 4: `ctx.focus`, `ctx.setFocus`, `ctx.patchProject`, and the `InteractiveMap` props;
  - existing: `RecordSummary` (`{ e, onEdit, compact }`), `usePersisted`, `ctx.searchWorld`, `ctx.openRecord`.
- Produces:

  ```ts
  export function ConnectionsDiagram(p: { center: Entity; connections: Connection[]; total: number; onFocus: (key: string) => void; onLink: (c: Connection) => void }): JSX.Element;
  export function TimelineStrip(p: { items: { id: string; start: number; end: number; color: string }[]; undated: number; selectedId: string; onSelect: (id: string) => void }): JSX.Element;
  export function MergeDialog(p: { index: EntityIndex; a: Entity; onMerge: (b: Entity, name: string) => void; onClose: () => void }): JSX.Element;
  export function DuplicatesList(p: { index: EntityIndex; suggestions: DuplicateSuggestion[]; readOnly: boolean; onMerge: (a: Entity, b: Entity) => void; onDistinct: (a: Entity, b: Entity) => void }): JSX.Element;
  ```

- [ ] **Step 1:** Build `index` with `useMemo(() => buildEntities(project, project.entityDecisions), [project.boards, project.entityDecisions])`.
  - Remembered state: `usePersisted('atlas.inv.entity', '')` and `usePersisted('atlas.inv.tab', 'records')`.
  - The entity shown is `index.byKey.get(saved) ?? the entity with the most mentions`.
  - An empty index shows the empty state with **Explore** and **Graph** buttons.
- [ ] **Step 2: Left list and profile.**
  - **List:**
    - Groups in the order People, Organisations, Other actors, Places, Events, each sorted by mentions.
    - The search box uses `matchesQuery` over the name and aliases.
    - **Possible duplicates (N)** opens `DuplicatesList`.
  - **Profile:**
    - name, kind, aliases, a Wikidata link (`https://www.wikidata.org/wiki/<QID>`, `target="_blank" rel="noreferrer"`),
      and the summary from the first node's `data.detail`;
    - counts of records, nodes, folder items and boards;
    - buttons: **Open in Graph** (a board menu when its nodes are on several boards), **Show on World**, **Explore**,
      **Merge with…** and **Unmerge**. Merge and Unmerge are disabled when read-only.
  - **Narrow screens:** below 900 px the list is a drawer, opened by a **Entities** button.
- [ ] **Step 3: Panes.**
  - **`ConnectionsDiagram`:**
    - an SVG with a 300 × 260 viewBox; the centre at (150,130); neighbours on a ring of radius 105, each with a 14-character
      label;
    - graph links drawn solid with an arrow in their direction; listed-together lines dashed (`4 4`);
    - a `<title>` on each dashed line with the exact Global Constraints copy;
    - a footnote "Showing 24 of N" when `total > shown.length`;
    - **Back** pops a history stack of keys.
  - **Clicking a line** fills the Records tab with only the records behind it (shared records). For graph links it
    lists the edges ("Board · relation →"). A **Show all** button clears that filter.
  - **Map:** `InteractiveMap` with the entity's records that have coordinates, `compact`, no `onAddAt`, and the World
    page's persisted basemap. `fit` is the records' bounding box, padded by 1° when there is a single record.
  - **`TimelineStrip`:**
    - dated records via `dateSpan`; the x axis from the minimum to the maximum year, with ticks every 1, 5, 10 or 50
      years to give at most 8 ticks;
    - a dot per record, coloured by `VERIFICATION_COLORS`, with the selected dot ringed;
    - "N undated" after the strip.
- [ ] **Step 4: Linked selection and tabs.**
  - One `selectedRecord` state is shared by the map's `onSelect`, the timeline's `onSelect` and the record rows.
  - The selected record shows in `RecordSummary compact` with **Open record**.
  - **Tabs:**
    - Records: name, date, role, verification;
    - Sources: title or URL, publisher, "supports N records";
    - Folders: item name and folder, and the board when it isn't the current one;
    - Appears on: each board with its counts and **Open**.
- [ ] **Step 5: Merging.**
  - **`MergeDialog`:**
    - searches entities of the same family, excluding the entity itself;
    - shows both side by side with their counts;
    - has radio buttons for the name (both names plus aliases).
  - **Merge** calls `ctx.patchProject(p => ({ ...p, entityDecisions: mergeEntities(p.entityDecisions ?? emptyDecisions(), a, b, name, ctx.device)! }))`,
    then selects the merged key.
  - **Unmerge** and **Not the same** use `unmerge` and `markDistinct` in the same way.
  - Notices: "Merged. Records keep their own wording." and "Unmerged."
- [ ] **Step 6:** Run `npm.cmd run build`. Expected: `✓ built`.

### Task 6: Graph and World open with the entity highlighted

**Files:**
- Modify: `src/components/InvestigateView.tsx` (the Open in Graph and Show on World handlers)
- Modify: `src/components/GraphView.tsx`, `src/components/WorldView.tsx`, `src/components.css`

**Interfaces:**
- Consumes: `ctx.focus` and `ctx.setFocus` from Task 4.

- [ ] **Step 1: Open in Graph** calls `ctx.setFocus({ label, nodeIds, recordIds, n: Date.now() })`, then
  `ctx.selectBoard(boardId)` and `ctx.setView('Graph')`. **Show on World** does the same with `'World'` and the board
  holding most of its records.
- [ ] **Step 2: GraphView.**
  - **Derived node classes** (never saved):
    - when the focus has nodes on this board, `shownNodes` get `className` `focus-hit` or `focus-dim`;
    - `<ReactFlow key={ctx.focus?.n} fitViewOptions={{ nodes: hits.map(id => ({ id })), padding: 0.5 }}>`.
  - **The chip:**
    - *Highlighting {label}* with × (`setFocus(null)`);
    - or, when nothing is on this board, *None of {label}'s nodes are on this board* with buttons for the boards that
      have them.
- [ ] **Step 3: WorldView.**
  - When `ctx.focus` is set, `filtered` also requires `focus.recordIds` to include the record.
  - The chip reads *Showing N records for {label}* with ×, or, when none are on this board, offers the boards that have
    them.
- [ ] **Step 4:** Run `npm.cmd run build`, then `npm.cmd test`. Expected: built, and all tests pass.

### Task 7: Browser check, README and version

**Files:**
- Modify: `README.md`, `package.json`, `package-lock.json`, `server/host.mjs`

- [ ] **Step 1: Test host.** Copy `data/projects.json` and `data/boards` into `<scratchpad>/checkdata`. Start
  `PORT=4191 ATLAS_DATA_DIR=<scratchpad>/checkdata ATLAS_BIND=127.0.0.1 node server/host.mjs` in the background.
- [ ] **Step 2: Browser check** at `http://localhost:4191/`, with the pane visible (take screenshots, since MapLibre
  doesn't render while the pane is hidden):
  - Explore-saved entities appear with their Wikidata links;
  - the counts match the boards;
  - selecting a record on the map rings it on the timeline and shows its summary;
  - clicking a connection line filters the records;
  - merging two test entities, then unmerging them, and **Not the same**;
  - **Open in Graph** and **Show on World**, each with a chip that clears;
  - at 375 px wide: no sideways scrolling, and the list drawer opens.
- [ ] **Step 3: README.**
  - an *Investigate (connected view)* subsection in section 4, after Explore;
  - the spec's *Limits* in section 6;
  - a file-table row for `src/entities.ts`, `src/components/InvestigateView.tsx`, `InvestigatePanes.tsx` and
    `EntityMerge.tsx`;
  - *Changes in 0.7.0*;
  - the sample output shows `Atlas 0.7.0`.
- [ ] **Step 4:** Bump the version to 0.7.0 everywhere listed in Global Constraints. Run `npm.cmd test` (all pass) and
  `npm.cmd run build` (✓ built).
- [ ] **Step 5: Clean up.** Reset the viewport (preset desktop), close the browser tab, and stop the process listening
  on port 4191.
