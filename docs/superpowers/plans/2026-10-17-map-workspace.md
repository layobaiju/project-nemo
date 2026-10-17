# Map workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Map page with satellite imagery, drawing (markers, routes, areas, labels), measuring, resources with
statuses and a time-stamped task log, all saved with the board.

**Architecture:**
- **Pure rules:** `src/geo.ts` and `src/ops.ts`, unit-tested.
- **Data model:** `src/model.ts` normalises the four new board lists.
- **Host:** `server/tiles.mjs` builds satellite tile URLs, and `server/host.mjs` proxies them.
- **Map:** `src/OpsMap.tsx` (MapLibre + Terra Draw).
- **Page:** `src/components/MapWorkspace.tsx`, the panels and the toolbar.

**Tech Stack:** MapLibre GL 6, terra-draw 1.35.0 with the MapLibre adapter 1.4.1, React 18, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-17-map-workspace-design.md`

## Global Constraints

- Vocabularies, task transitions, formatting thresholds and imagery zoom limits are exactly as in the spec.
- Every board change goes through `ctx.patchBoard`. The page shows nothing editable in read-only preview.
- No new network origins in the browser: imagery comes through `/api/map/sat/...`.
- Version 0.6.0.
- No git here: each task ends with a full `npm.cmd test`.

## Review Focus

1. **Old boards** without the new lists open without errors. Task 1 test `older boards get empty map lists`.
2. **Disallowed task transitions** (for example Requested → Done) are refused, and the log is unchanged. Task 1 test
   `task status follows the workflow`.
3. **Deleting a resource or a drawing** that tasks still point to leaves no dangling references in the task data.
   Task 1 tests `deleting a resource clears it from tasks` and `deleting a drawing clears it from tasks`.
4. **Tile addresses** that are out of range or have an unknown provider never reach upstream. Task 2 test
   `tile addresses are validated`.
5. **Area of a self-closing ring and tiny areas** format sensibly. Task 1 test `distances and areas`.

---

### Task 1: Data model, geometry and operations rules

**Files:**
- Create: `src/geo.ts`, `src/ops.ts`
- Modify: `src/types.ts` (types), `src/model.ts` (normalisers called from `normalizeBoard`)
- Test: `tests/ops.test.mjs`

- [ ] **Step 1: Failing tests:**
  - `distances and areas`:
    - London → Paris is about 343.5 km (±1).
    - A 1 km × 1 km square near the equator is about 1.00 km² (±0.01).
    - `formatDistance(0.85)` is `'850 m'` and `formatDistance(12.43)` is `'12.4 km'`.
    - `formatArea(0.00124)` is `'1,240 m²'` and `formatArea(3.46)` is `'3.5 km²'`.
  - `older boards get empty map lists`: `normalizeBoard({ id: 'b' })` has the four lists empty, and a bad feature
    (missing geometry) is dropped.
  - `features: add, update and delete, with a default layer`: the first feature creates the "Drawings" layer;
    `updatedAt` changes on update.
  - `deleting a layer moves its drawings to Drawings`.
  - `task status follows the workflow`:
    - Requested → Accepted → In progress → Done; the log has 4 entries, each with `by`.
    - Requested → Done is refused (the board is returned unchanged).
    - Cancelled → Reopen gives Requested.
  - `deleting a resource clears it from tasks`, and `deleting a drawing clears it from tasks`.
  - `drawings export as GeoJSON with their properties`.
- [ ] **Step 2: Run** `node --test tests/ops.test.mjs`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** `src/geo.ts`, `src/ops.ts`, the types and the normalisers.
- [ ] **Step 4: Run** the file. Expected: PASS. Add it to the `test` script and run `npm.cmd test`.

### Task 2: Satellite tile proxy

**Files:**
- Create: `server/tiles.mjs` exporting `satTileUrl(provider, z, x, y)`, which returns the upstream URL or `null`, and
  `SAT_ATTRIBUTION`.
- Modify: `server/host.mjs`: the `/api/map/sat/:provider/:z/:x/:y` route, using the tile cache.
- Test: `tests/tiles.test.mjs`, plus a route check in `tests/host.test.mjs`.

- [ ] **Step 1: Failing tests:** `tile addresses are validated`:
  - Esri z17 gives `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/{y}/{x}`.
  - EOX z15 gives `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/15/{y}/{x}.jpg`.
  - Each of these gives `null`: EOX z16, Esri z20, x = 2^z, a negative value, a non-integer, an unknown provider.
  - Host: `/api/map/sat/esri/2/9/0` returns 400 and `/api/map/sat/nope/1/0/0` returns 400.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run** `npm.cmd test`. Expected: all PASS.

### Task 3: Map page

**Files:**
- Create: `src/OpsMap.tsx`, `src/components/MapWorkspace.tsx`
- Modify: `src/ctx.ts` (`View` gains `'Map'`), `src/main.tsx` (menu entry and render),
  `src/InteractiveMap.tsx` (export `onlineStyle` and `offlineStyle`), `src/components.css`.

- [ ] **Step 1: Build the page** as the spec describes. Run `tsc`. Expected: exit 0.
- [ ] **Step 2: Build** `npm.cmd run build`. Expected: built.
- [ ] **Step 3: Browser check** on a data copy (port 4191):
  - Satellite imagery loads, from both sources.
  - Draw a marker with a symbol, a route (its length is shown) and an area (its size is shown); measure.
  - Reshape the route.
  - Add a resource, set its status and place it.
  - Create a task and move it to Done; the log shows 4 entries.
  - The board saves.
  - At 375 px wide there is no sideways scroll.

### Task 4: Docs and version

- [ ] README: a "Map workspace" subsection in section 4, the services table (Esri, EOX), limits, 0.6.0 changes.
  Version 0.6.0 in `package.json` and `server/host.mjs`.
- [ ] `npm.cmd test` and `npm.cmd run build`. Expected: all PASS.
