# Map workspace: design

Date: 2026-10-17 · Status: approved in chat; the user asked to go straight on to the plan and the build · Atlas 0.5.0 → 0.6.0

## Goal

A planning map like the user's screenshot. It has:

- detailed satellite imagery;
- markers with symbols, routes, areas and text labels drawn on top;
- measuring;
- a list of resources with statuses;
- a task log whose status changes are time-stamped.

Everything belongs to the current board and saves like the rest of the board.

## Decisions made with the user

- **Imagery:** both sources, switchable.
  - **Esri World Imagery:** detailed, building-level. Attribution "Esri, Maxar, Earthstar Geographics".
  - **EOX Sentinel-2 cloudless 2023:** 10 m, CC BY-NC-SA 4.0. Attribution "Sentinel-2 cloudless by EOX IT Services GmbH
    (contains modified Copernicus Sentinel data 2023)".
  - **Also:** the existing street map and the offline outlines.
- **Out of scope:**
  - automatic road routing;
  - live GPS tracking of people or devices;
  - control or tasking of real drones or aircraft;
  - weapons, targeting or threat-avoidance tools.

## Data (per board; older boards get empty lists)

- **`mapFeatures: MapFeature[]`**:

  ```
  { id, kind: 'marker' | 'route' | 'area' | 'label',
    geometry: GeoJSON Point | LineString | Polygon,
    shape?: 'polygon' | 'rectangle' | 'circle',
    symbol, color, name, notes, layer, createdAt, updatedAt }
  ```

- **`mapLayers: MapLayer[]`**: `{ id, name, visible, locked }`. A layer called "Drawings" is created on first use.
- **`resources: Resource[]`**: `{ id, name, type, status, position: [lng, lat] | null, notes, updatedAt }`.
- **`tasks: OpsTask[]`**:

  ```
  { id, title, type, resourceId, featureId, status,
    log: [{ at, status, note, by }],
    createdAt, updatedAt }
  ```

- **Vocabularies:**
  - **Symbols (20):** safe location, embassy/consulate, hospital, school, place of worship, shelter/camp, checkpoint,
    roadblock, hazard, fire, flood, damage, team, vehicle, aircraft, landing site, meeting point, observation, note,
    flag.
  - **Colours (8)**, a fixed palette.
  - **Resource types:** Team, Vehicle, Aircraft, Boat, Equipment, Other.
  - **Resource statuses:** Ready (green), In use (blue), Needs attention (amber), Offline (grey).
  - **Task statuses:** Requested → Accepted → In progress → Done, with Cancelled possible from any open status and
    Reopen from Done or Cancelled back to Requested.
  - **Task log:** every change appends `{ at, status, note, by: device }`.

## Geometry

- **Route length:** the sum of haversine distances (`haversineKm`).
- **Area:** the spherical polygon formula, `|Σ (λ2 − λ1)(2 + sin φ1 + sin φ2)| · R² / 2` with R = 6371.0088 km.
- **Formatting:**
  - distance: under 1 km as "850 m", else "12.4 km";
  - area: under 0.1 km² as "1,240 m²", else "3.5 km²".
- **Label positions:** routes at their midpoint by length; areas at the vertex average.

## Host

- **Route:** `GET /api/map/sat/:provider/:z/:x/:y` with provider `esri` (z ≤ 19) or `eox` (z ≤ 15). x and y must be
  integers within 0…2^z − 1; anything else gets a 400.
- **Fetching:** the upstream URL is built by `server/tiles.mjs` (pure). Responses go through the existing 64 MB tile
  cache, with `cache-control: public, max-age=86400`.
- **Access:** behind the same access-code and private-network checks as the rest of the API.

## Client

- **`src/geo.ts`** (pure): `lineKm`, `polygonKm2`, `formatDistance`, `formatArea`, `lineMidpoint`, `polygonCenter`,
  `bearing`.
- **`src/ops.ts`** (pure):
  - **Vocabularies:** symbols, colours, types, statuses.
  - **Features:** `addFeature`, `updateFeature`, `deleteFeature`.
  - **Layers:** `addLayer`, `updateLayer`, `deleteLayer`. Deleting a layer moves its features to "Drawings".
  - **Resources:** `addResource`, `updateResource`, `deleteResource`. Deleting a resource clears it from tasks.
  - **Tasks:** `createTask`, `setTaskStatus` (rejects transitions that aren't allowed), `deleteTask`.
  - **Export:** `drawingsGeoJSON`.
- **`src/model.ts`**: the board normaliser fills and cleans the four new lists.
- **`src/components/MapWorkspace.tsx`**: the page.
  - **Left panel:** tabs Layers, Resources and Tasks, plus an editor for the selected drawing (name, symbol, colour,
    layer, notes, size, Reshape, Delete).
  - **Map area:** a toolbar with Select, Marker, Route, Area, Rectangle, Circle, Label, Measure and a symbol/colour
    picker; the basemap menu; GeoJSON export.
- **`src/OpsMap.tsx`**: MapLibre plus Terra Draw.
  - **Drawing:** routes, areas, rectangles and circles are drawn with Terra Draw. Reshape puts the feature into Terra
    Draw's select mode. Markers, labels and resource placement are single clicks.
  - **Rendering:** shapes go in Atlas's own GeoJSON layers. Markers, labels, resources, route-end arrows and
    shape captions are DOM markers.
  - **Locked layers:** cannot be selected or moved.
- **Saving:** every change goes through `ctx.patchBoard`, so per-board saving, syncing, conflicts, backups and exports
  apply.
- **Dependencies:** `terra-draw@1.35.0` and `terra-draw-maplibre-gl-adapter@1.4.1`, both MIT, pinned, released at
  least two weeks ago.

## Limits (README)

- Satellite imagery dates differ by place and can be years old.
- Esri's terms apply to its imagery: fine for personal research; check them before commercial use.
- Distances and areas are on a sphere, accurate to about 0.5 %.
- There is no road routing and no live positions. Resource positions are what someone last placed.
