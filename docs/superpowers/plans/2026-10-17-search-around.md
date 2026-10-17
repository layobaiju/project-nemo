# Search around Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand any graph node into its Wikidata connections, with typed nodes, labelled and sourced links, and undo.

**Architecture:**
- **Host:** `server/explore.mjs` gains `neighbors(qid)`. It is built from the cached topic (outgoing links), one
  capped role query (incoming links) and one batched details query.
- **Route:** exposed as `GET /api/explore/neighbors/:qid`.
- **Client:** `src/searchAround.ts` (pure) applies picks to a board. A new section in the Graph inspector drives it.

**Tech Stack:** Node `node:test`, React 18 + TypeScript, `@xyflow/react`.

**Spec:** `docs/superpowers/specs/2026-10-17-search-around-design.md`

## Global Constraints

- Role properties, excluded properties and kind rules are exactly as listed in the spec.
- Incoming query `LIMIT 300`. Details batches ≤ 300 ids. All SPARQL goes through the existing 4-at-a-time limiter.
- SPARQL queries start with a marker comment line (`#atlas:incoming`, `#atlas:neighbors`) so the test fake can route
  them.
- Neighbour cache 24 h.
- Node ring radius 260, second ring 420 beyond 16 nodes.
- Links are dashed and carry `data.note: 'From Wikidata (unverified)'`.
- Version 0.5.0.
- No git here: each task ends with a full `npm.cmd test`.

## Review Focus

1. **Node not linked yet.** The node has no `data.wikidata`, so the panel offers a Wikidata search instead of failing.
   Task 3 test `linkNodeToWikidata sets the id and keeps the node's own label`.
2. **Neighbour already on the board.** The existing node is reused; repeat expansions never duplicate nodes or links.
   Task 3 test `expanding twice reuses nodes and adds no duplicate links`.
3. **Very connected entity.** The incoming list is capped and flagged, and the UI says so. Task 1 test
   `incoming links are capped and flagged`.
4. **Details query fails.** Neighbours still come back as `Note` with no description, and the error is reported.
   Task 1 test `a failed details lookup still returns the connections`.
5. **Undo after further edits.** Undo removes only what the expansion created, never a reused node. Task 3 test
   `undo removes only what the expansion created`.

---

### Task 1: Host neighbours lookup

**Files:**
- Modify: `server/explore.mjs`
- Modify: `tests/fixtures/explore/fake-fetch.mjs`: route the `#atlas:incoming` and `#atlas:neighbors` markers to the new
  fixtures `sparql-incoming.json` and `sparql-neighbors.json`.
- Test: `tests/explore.test.mjs`

**Interfaces:**
- Produces:
  - `explore.neighbors(qid)` returns
    `{ id, label, groups: { key, property, relation, direction, items: { id, label, description, kind }[] }[], capped, errors }`.
  - `export function nodeKind({ isHuman, types, hasCoord, hasDate }): string`

- [ ] **Step 1: Write the failing tests:**
  - `neighbours group outgoing facts and incoming roles, typed and directed`, for Q1317 with the fake:
    - `out:P463` holds `Al-Qaeda` with kind `Organisation`.
    - `out:P19` holds `Riyadh` with kind `Place`.
    - `in:P533` holds `killing of Osama bin Laden` with kind `Historical event`.
    - `in:P50` holds a `Source`.
    - No `P31` group; the topic itself is not among the items.
  - `nodeKind follows the spec's order`: covers each rule.
  - `incoming links are capped and flagged`: a fake returning 300 rows sets `capped: true`.
  - `a failed details lookup still returns the connections`: a rejected `#atlas:neighbors` query gives every kind
    `Note`, `errors.details` set, and the groups still present.
- [ ] **Step 2: Run** `node --test tests/explore.test.mjs`. Expected: FAIL, `neighbors` is not a function.
- [ ] **Step 3: Implement** `neighbors` and `nodeKind` as the spec describes.
- [ ] **Step 4: Run** `node --test tests/explore.test.mjs`. Expected: PASS.
- [ ] **Step 5: Run** `npm.cmd test`. Expected: all PASS.

### Task 2: Route

**Files:**
- Modify: `server/host.mjs`
- Test: `tests/host.test.mjs`, extending the explore route test.

- [ ] **Step 1: Failing test:** `/api/explore/neighbors/Q1317` returns 200 with `groups.length > 0`;
  `/api/explore/neighbors/x` returns 400.
- [ ] **Step 2: Implement** the route next to `/api/explore/events/:qid`.
- [ ] **Step 3: Run** `npm.cmd test`. Expected: all PASS.

### Task 3: Client graph operations

**Files:**
- Create: `src/searchAround.ts`
- Test: `tests/search-around.test.mjs`

**Interfaces:**
- Consumes: the neighbours shape from Task 1 (as TS types `Neighbors`, `NeighborGroup`, `NeighborItem` in
  `src/searchAround.ts`).
- Produces:
  - `wikidataIdOf(node: Node): string | undefined`
  - `linkNodeToWikidata(board: Board, nodeId: string, c: { id: string; description: string }): Board`
  - `expandNode(board: Board, nodeId: string, picks: { group: NeighborGroup; item: NeighborItem }[]): { board: Board; added: Expansion }`
  - `undoExpansion(board: Board, added: Expansion): Board`, where `Expansion = { nodeIds: string[]; edgeIds: string[] }`

- [ ] **Step 1: Failing tests:**
  - `expansion adds typed nodes on a ring and directed, labelled links`:
    - 3 picks give 3 nodes at distance 260 from the centre.
    - The edge for `out:P463` runs centre → Al-Qaeda; the edge for `in:P533` runs killing → centre.
    - `edge.data.note` is `'From Wikidata (unverified)'`.
  - `expanding twice reuses nodes and adds no duplicate links`.
  - `undo removes only what the expansion created`: a reused, pre-existing node and its other links stay.
  - `linkNodeToWikidata sets the id and keeps the node's own label`.
- [ ] **Step 2: Run** the file. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `src/searchAround.ts`.
- [ ] **Step 4: Run** the file. Expected: PASS. Add the file to the `test` script and run `npm.cmd test`.

### Task 4: Graph inspector UI, docs and version

**Files:**
- Create: `src/components/SearchAround.tsx`: the panel with link-to-Wikidata, groups, filter, picks, add, undo,
  loading and error states.
- Modify: `src/components/GraphView.tsx`: render the panel in the node inspector and keep the last expansion for undo.
- Modify: `src/api.ts`: add `getNeighbors(qid)`.
- Modify: `src/components.css`
- Modify: `README.md`: Graph section, limits, 0.5.0 changes.
- Modify: `package.json` and `server/host.mjs`: version 0.5.0.

- [ ] **Step 1:** Build the panel and its wiring. Run `tsc`. Expected: exit 0.
- [ ] **Step 2:** `npm.cmd test` and `npm.cmd run build`. Expected: all PASS and `built in`.
- [ ] **Step 3: Browser check** on a data copy (port 4191):
  - Link "osama binladen" to Q1317, then search around and add Al-Qaeda plus two incoming events.
  - Expand Al-Qaeda by one hop.
  - Undo the last expansion.
  - Confirm the board saves ("Saved on host").
