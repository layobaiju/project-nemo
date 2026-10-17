# Atlas Workspace

Atlas is a local-first workspace for research, investigations, planning, software design and knowledge mapping. A Windows PC hosts the app and stores all project data. Macs and iPads on the same private network open Atlas in a browser.

**Atlas contains no built-in event data.** The map shows only records you enter or import. It is not a live feed and not a complete database of anything.

The **Explore** page looks things up live in Wikipedia, Wikidata and GDELT news when you search. It saves only what you choose, with its source and licence attached.

The **Investigate** page shows each person, organisation, place and event in a project with its records, connections, map, timeline and sources, and suggests likely duplicates for you to merge.

The **Map** page is a satellite planning map with drawings, resources and a task log. Both maps can **find places** (cities, towns, villages, landmarks) through OpenStreetMap.

The **Watchlist** follows people, groups, places and topics. The Windows host checks news and Wikidata on a schedule and shows what is new.

---

## 1. Run it on Windows (PowerShell)

Requires **Node.js 20 or newer** (`node --version`). The tests need 22.18 or newer; Node 24 is recommended.

Open **PowerShell** and run each line:

```powershell
cd "C:\Users\layob\OneDrive\Desktop\project nemo\Atlas-Workspace-MVP"
npm.cmd install
npm.cmd run build
npm.cmd run host
```

Use `npm.cmd`, not `npm`: PowerShell may block the `npm.ps1` script, and the `.cmd` shim avoids that.

The host prints something like this:

```
Atlas 0.8.0 host is running.
  This PC:     http://localhost:4174
  LAN access:  http://192.168.1.10:4174
  Access code for Mac/iPad (enter once per device): KT65-NXD4
  Data folder: ...\data (projects.json + one file per board in boards)
```

- On the Windows PC, open **http://localhost:4174**. No code is needed there.
- Keep the PowerShell window open while you work. Press `Ctrl+C` to stop the host.
- After you change source code, run `npm.cmd run build` again, then restart the host.

Optional settings go before the command, in the same PowerShell window:

```powershell
$env:PORT=4175; npm.cmd run host                             # use a different port
$env:ATLAS_DATA_DIR="D:\AtlasData"; npm.cmd run host         # keep data outside OneDrive
$env:ATLAS_ACCESS_CODE="MY-OWN-CODE"; npm.cmd run host       # fixed LAN access code
```

## 2. Open Atlas on a Mac or iPad (same network)

1. Connect the Mac or iPad to the **same Wi-Fi or LAN** as the Windows PC.
2. In Safari or Chrome, open the `LAN access` address printed by the host, for example `http://192.168.1.10:4174`. Use the `192.168.x.x` address of your home network. The other addresses belong to virtual adapters or Tailscale.
3. Enter the **access code** from the PowerShell window. You can also find it under **Settings → Windows host and LAN access** on the PC. Each device needs it only once.
4. On iPad, you can tap **Share → Add to Home Screen** to get a full-screen app icon.

If the page doesn't load:

- **Windows network profile.** Your Wi-Fi network must be set to *Private*: Settings → Network & internet → Wi-Fi → your network → Network profile type → Private.
- **Firewall.** When Windows first asks about Node.js, allow it on **Private networks only**. If you missed that prompt, go to Windows Security → Firewall & network protection → *Allow an app through firewall* → **Node.js JavaScript Runtime** → tick **Private** (not Public).
- **Address changed.** Your router can give the PC a new address after a restart; it was `.9` before and is `.10` now. Check the host output, or set a DHCP reservation for the PC in your router.

### Security

The host has no accounts and no HTTPS. It is built for a trusted home or office network:

- It accepts connections only from this PC and private addresses: `192.168.x`, `10.x`, `172.16–31.x`, link-local, and Tailscale `100.64/10`. All other addresses are refused.
- LAN devices need the **access code**. The approval is stored in a cookie, so each device enters it once. Codes are rate-limited against guessing. **Settings → New code** creates a new code, which signs out every device.
- Requests that use an unknown host name are rejected, which blocks DNS-rebinding attacks. Cross-site writes are also rejected. Unlike version 0.1, other websites cannot read your data.
- **Never port-forward or publicly expose this server.** Anyone on your Wi-Fi could still see unencrypted traffic.
- `data/host-config.json` holds the access code and a secret. Don't share it. Exports and backups never include it.
- `$env:ATLAS_LAN_CODE="off"` disables the code. This is not recommended.

## 3. Your data and backups

All data stays in the **`data`** folder on the Windows PC:

- `data/projects.json` is a small index of your projects, their names and descriptions, and the order of their boards.
- Each board is its own file in `data/boards/<project>/<board>.json`. A board file holds the board's records, graph, folders and import log.

**Saving is per board.**
- Atlas sends only the boards you changed. Editing a small board never resends a board with thousands of imported records, and the host rewrites only that board's file. Project names and descriptions are saved separately.
- Each save is checked against the version of *that board* that you loaded. If another device saved the same board first, a banner names the board, for example *Board "UCDP GED 2010–2019" was changed on another device*. You can choose **Download my copy**, **Load latest from host** or **Keep this device's version**.
- Only that board waits for your choice. Your other boards keep saving. Atlas never overwrites silently.
- If another device deleted a board you are editing, you can **Accept the deletion** or **Keep this device's version**, which puts the board back.
- Devices pick up other devices' saves within about 12 seconds. Only boards that changed are downloaded. If you are editing a board that changed elsewhere, Atlas doesn't replace it; it shows a conflict instead.

**Upgrading from 0.2** happens automatically the first time the 0.3 host starts:
1. The host copies the old single-file `projects.json` to `data/backups/projects-before-split-<date>.json` and checks the copy.
2. It writes one file per board and checks each file.
3. Only then does it replace `projects.json` with the index.

If any step fails, the old `projects.json` stays as it was and the host tries again on the next start. A 0.2 host refuses to open the new format rather than overwrite it.

**Automatic backups** go to `data/backups/`:
- `projects-auto-*.json`: a full copy of the workspace every 10 minutes while you edit. The last 40 are kept.
- `board-before-overwrite-*.json`: a board as it was before **Keep this device's version** replaced it. The last 30 are kept.
- `board-before-delete-*.json`: a board as it was before it was deleted. The last 50 are kept.
- `projects-before-split-*.json` and `projects-before-v0.2-*.json`: the snapshots taken before the 0.3 and 0.2 upgrades. These are never removed.
- `boards-replaced-*` folders: board files set aside during a rollback (see below).

Writes are atomic, and Atlas retries if OneDrive briefly locks a file. If `projects.json` or a board file is ever unreadable, the host refuses to replace it.

**Getting data back:**
- **Roll back the whole workspace:** stop the host, copy a `projects-*.json` backup over `data/projects.json`, then start the host. The host converts the backup into board files again and moves the current board files to `data/backups/boards-replaced-<date>/`, so nothing is lost.
- **Bring back one board:** Settings → *Restore from backup…*, choose a `board-*.json` file, and add it as a copy.
- **Full backup:** Settings → *Download full backup*, or open `http://localhost:4174/api/export`. It's a single file in the same format as before.
- **Restore from backup:** Settings → *Restore from backup…*. You see a preview first. Existing projects are never replaced; a project with a matching ID is skipped or added as a copy.

Older records are migrated in memory without loss. Their old `x/y` map positions and source lines are kept, and a board is rewritten only when you edit it.

## 4. What Atlas does

### Projects, boards, folders
- One project can hold many **boards** (subprojects), and each board has a world map, a graph, a timeline and folders.
- A **Military** research workspace is created by default and is never removed.
- **Virtual folders** are managed inside Atlas, not in Windows Explorer. They hold notes, reference links and sketches. Each item can link to **several graph nodes and records**, independently of where it is filed.

### Records, evidence and uncertainty
**Add record**, or click the globe and choose *Add record at this point*. Clicks no longer create records by accident. The record editor has these tabs:

| Tab | Fields |
|---|---|
| Record | title (neutral wording), category, conflict/incident classification, context name, description, tags |
| Place & time | start/end date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`), date precision, place, latitude/longitude, location precision, countries/regions, **Pick on globe** |
| Actors | name, type (state force, armed group, …), role, **attribution status** (Unknown / Alleged / Suspected / Claimed / Disputed / Confirmed / Coded by dataset), note |
| Casualties | metric, population, **low / best / high**, status (Reported / Estimate / Confirmed / Disputed), **definition** |
| Equipment | references identified in sources (reference only; no operational detail) |
| Sources | title, publisher, URL, published and accessed dates, type, reliability, stance (supports / contradicts / context), **the specific claim**, and **which fields or items it supports** |
| Assessment | verification status, analyst confidence, attribution uncertainty, analyst notes (kept apart from evidence) |
| Provenance | origin, dataset, licence, original ID, import batch, comparison links |

Atlas keeps statement types visibly separate:
- **Facts** are fields backed by linked sources.
- **Allegations** are attributions marked alleged, claimed, suspected or disputed.
- **Estimates** are casualty figures marked as estimates or as reported.
- **Interpretation** goes in analyst notes.

Live checks flag problems as you type:
- **These block saving:** a reversed casualty range, an invalid date or coordinate, or a source with neither title nor URL.
- **These are warnings:** a figure or a "Confirmed" attribution with no supporting source, a record marked "Verified" with fewer than two supporting sources, or a source that isn't linked to any field.

### Import (CSV, JSON, GeoJSON, UCDP GED)
Use **World → Import**, **Settings → Import records** or **Overview → Import records**. The wizard has four steps:

1. **File.** Choose a file. It is read in the browser and nothing is sent until you confirm. There is a downloadable **CSV template**.
2. **Columns and filters.** Columns are mapped automatically and you can adjust them. You can filter by date range or text and set a maximum number of records (10,000 at most).
3. **Provenance and licence.** Enter the dataset name, version, publisher, URL, licence, citation, which fields the file's sources support, and confirm that you may use the data. **Imports with an unknown licence are refused.**
4. **Validate and review.** Each row shows its errors and warnings. **Duplicates are found and left unselected:**
   - the same dataset record ID;
   - the same title and date;
   - the same category within 1 day and 2 km;
   - duplicates within the same file.

   You can include possible duplicates explicitly, and they stay flagged. Records go into a **new board** (recommended) or an existing one. Nothing is ever overwritten.

Every import is logged on its board (file, dataset, licence, counts), and **Remove this import's records** undoes it.

**UCDP GED (optional, free).** The UCDP Georeferenced Event Dataset is licensed **CC BY 4.0**.
1. Download the CSV from <https://ucdp.uu.se/downloads/>. No account is needed.
2. The UCDP *API* requires an access token, so Atlas uses the file instead.
3. Atlas detects GED columns and handles them as follows:
   - **Fatalities:** UCDP's low/best/high figures and per-side deaths are kept as **estimates**, with UCDP's definitions.
   - **Sides:** labelled *as coded*, with attribution *Coded by dataset*.
   - **Precision:** `where_prec` and `date_prec` are mapped to location and date precision.
   - **Citation:** the dataset citation is stored on every record.
4. The full file has hundreds of thousands of events. Filter by date or country and import in batches of a few thousand.
5. Cite UCDP and the GED version you used.

### Explore (global search)
Open **Explore** in the sidebar and type a name, place, organisation or event. Misspellings such as `osama binladen` still find **Osama bin Laden**. Pick the right match from the list, then the topic page shows:

- **Summary:** from the English Wikipedia article, with attribution and a link.
- **Key facts:** from Wikidata, for example dates and places of birth and death, citizenship, memberships, occupations and significant events. Click a linked value, such as *Al-Qaeda*, to explore it.
- **Related events:** dated items from Wikidata. Events with a known position appear on a small map.
- **All links**, in four tabs, each searchable:
  - every source the Wikipedia article cites (for Osama bin Laden, about 700);
  - database and official pages (about 160, such as library and government records);
  - the article in other languages (about 177);
  - **news from GDELT** (2017 onward, newest first, *Load older* for more).
- **In your workspace:** your own records, graph nodes and folder items that match.

Nothing is saved automatically. You choose:

- **Save as record:** the topic or a single event goes onto the board you pick.
  - The record starts as **Unverified**. Its sources are the Wikipedia article (CC BY-SA 4.0) and the Wikidata item (CC0).
  - It carries its Wikidata ID, so saving it twice shows *On this board* instead.
  - Events keep their map position. People don't get one, because a birthplace is not where a person is.
- **Add to graph:** the topic becomes a node.
- **Save to a folder:** links go into a folder named `Explore: <topic name>`. Links already in that folder are skipped.

How it works:

- The Windows host makes every request to Wikipedia, Wikidata and GDELT. Macs and iPads only talk to the host.
- The first look-up of a topic takes a few seconds. Repeats come from a memory cache: 24 hours for topics, 6 hours for news.
- GDELT allows one request every 5 seconds. When it refuses, the News tab says so and offers **Retry**.
- If a source is down, only its section shows an error, with **Try again**.

### Investigate (connected view)
The **Investigate** page (menu, after Explore) gathers everything the current project holds about one person, organisation, place or event.
- **Where entities come from:** nothing needs retyping.
  - graph nodes of kind Actor, Organisation, Place, Event or Historical event, including those added by Explore and Search around;
  - the actors listed on records;
  - the countries on records.
  - These are matched across every board in the project:
    - the same Wikidata ID is one entity;
    - otherwise the same name is one entity, ignoring case, accents, punctuation and spacing. People, organisations and other actors can share a name; places and events stay apart.
- **The page:**
  - **Left:** the entity list, grouped by People, Organisations, Other actors, Places and Events, with search over names and aliases. On iPad and phone it opens from the **Entities** button.
  - **Top:** the profile, with its name, kind, other spellings, Wikidata link, summary and counts. Buttons: **Open in Graph**, **Show on World**, **Explore**, **Merge with…** and **Unmerge**.
  - **Connections:** the entity in the middle and up to 24 others around it.
    - Solid arrows are your graph links, with their relationship and direction.
    - Dashed lines mean *listed together on N records*: two names on the same records, not evidence of a relationship.
    - Click a line to see the records behind it; click a neighbour to move to it (**Back** returns).
  - **Map and Timeline:** the entity's records on a map and along a year axis. Clicking a record on the map, the timeline or the list selects it in all three and shows its summary.
  - **Bottom tabs:** Records (with the entity's role, e.g. *Actor · Alleged*), Sources (de-duplicated, with how many records each supports), Folders (material linked to its nodes) and Appears on (its boards).
- **Leaving the page:**
  - **Open in Graph** rings the entity's nodes and dims the rest.
  - **Show on World** shows only its records.
  - A chip at the top says so; **Clear** ends it.
- **Possible duplicates:**
  - Atlas suggests pairs spelled almost the same (*Usama bin Ladin* / *Osama bin Laden*), names inside other names (*bin Laden*), and plain names shared by several Wikidata entities.
  - Numbered names such as *Group 1* and *Group 11* are never suggested.
  - Nothing is merged automatically: choose **Merge…** (and the name to show) or **Not the same**.
- **Merging only links.** Records and nodes keep their own wording, every spelling is listed as an alias, and **Unmerge** splits them again.
  - Decisions are saved in the project's settings, so they sync, conflict-check and back up like everything else.
  - Read-only previews can look but not merge.

### Watchlist
The **Watchlist** page (menu, after Investigate) follows people, groups, places and topics.
- **What you can watch:**
  - **Watch** on an Investigate profile or an Explore topic follows an entity. It checks news, plus Wikidata changes when it has a Wikidata ID.
  - **Add keyword watch** follows a phrase in the news (e.g. *Sudan ceasefire*), optionally English-language articles only.
- **When checks run:** the Windows host checks every 6 hours by default (hourly, daily or only when you press **Check now**). An overdue check starts shortly after the host starts.
- **What counts as new:**
  - The first check only records what is already there.
  - Later checks show articles not seen before for that watch, and Wikidata changes such as *date of death added* or *member of: removed X; added Y*.
  - Wikidata alerts are marked *unverified* and link to the item's edit history.
- **Reading alerts:**
  - The menu badge counts new alerts. Opening a watch marks its alerts seen on every device; **Mark all seen** clears everything.
  - **Save to board** files a news link in the folder *Watch: \<name\>* on the current board.
- **Editing:** change the name or news phrase, switch English-only, pause, or remove a watch (and its alerts). A new phrase starts a fresh baseline.
- **Storage:** watches and alerts are kept in `data/watch.json` on the host, never in projects or boards.

### Similar-record matching
Turn on **Find similar historical records** on the World view and select a record. Atlas then compares it with others on this board or in the whole project:

| Factor | Weight |
|---|---|
| Time proximity | 20 |
| Location distance | 20 |
| Overlapping actors | 15 |
| Category | 10 |
| Classification / conflict name | 10 |
| Shared countries | 10 |
| Shared sources | 8 |
| Shared equipment | 4 |
| Similar wording | 3 |

- Missing data **scores zero**, so sparse records never look similar. Each match shows its score, the share of fields that could be compared, and every reason.
- Approximate coordinates are capped.
- You can turn individual factors on or off.
- *Create comparison link…* saves a link labelled **comparison (analyst-created)**, with an optional note. You can also add both records to the graph.

Similarity is a research lead. It does **not** show coordination, shared responsibility, causation or a common actor.

### Map
- The globe is MapLibre, and it rotates, zooms and pans with pinch and two-finger rotate on iPad. Country labels and borders come from **OpenFreeMap**, proxied through the Windows host so Mac and iPad only need to reach the PC.
- The MapLibre worker is copied into the build from the installed package, so it is always served locally.
- Markers are coloured by verification status. Clicking a marker shows its details and an **Open record** button.
- **Search** covers title, place, actor, country and tags. **Date filters** offer presets or from/to fields, with an option to keep undated records. There is also a verification filter.
- **Layers:** Events, Countries, Conflicts, Actors, Armed groups, State forces, Casualties, Equipment, Sources.
  - A record shows when it matches **any** enabled layer; *only* isolates one layer, and the **?** button explains each rule.
  - *Countries* controls the basemap labels and borders.
  - *Casualties* also draws rings sized by the reported figure.
- **If the basemap can't load,** Atlas says why (for example, the host is offline) and switches to bundled **Natural Earth** country outlines. Records and markers keep working. Hovering shows the country name. You can also choose *Basemap: offline outlines* by hand.
- A data-quality filter lists records **without coordinates** (older flat-map records), **unsourced** records and untouched **placeholders**. Placeholders can be removed after confirmation; nothing is deleted automatically.
- **Find place** (toolbar) searches OpenStreetMap for a city, town, village or landmark. Picking a result frames it on the globe; records are not filtered.

### Map workspace
The **Map** page (menu, after World) is a planning map for the current board.
- **Basemaps:**
  - **Satellite (Esri):** detailed, building-level imagery.
  - **Satellite (Sentinel-2):** EOX's 10 m cloud-free mosaic from 2023.
  - **Streets** and **offline outlines** also work.
  - The menu sits at the top right. Imagery comes through the Windows host, like the other basemaps.
- **Find a place:** the search box at the top right looks up cities, towns, villages and landmarks in OpenStreetMap.
  - Type a name and press **Search** or Enter.
  - Picking a result flies there and drops a temporary pin with its name, since satellite images carry no labels.
  - **Add as marker** saves it as a flag marker on the board.
- **Toolbar:**
  - **Draw:** Select, Marker, Route, Area, Rectangle, Circle, Label and Measure.
  - **Style:** pick one of 20 symbols (safe location, embassy, hospital, checkpoint, hazard, team, vehicle, landing site, meeting point and more) and one of 8 colours before you draw.
- **How to draw:**
  - Markers and labels: one click.
  - Routes: click each point, then click the last point again (or double-click) to finish.
  - Areas: click the corners, then click the first point to close. Rectangles and circles take two clicks.
  - Routes show their length and an arrow at the end; areas show their size.
  - **Measure** shows a distance as you click and saves nothing.
- **Editing:** click a drawing to edit its name, symbol, colour, layer and notes, see its length or area, **Zoom to** it, **Reshape** it (drag its points, then **Done reshaping**) or delete it. Markers can be dragged.
- **Layers:** group drawings into layers. A layer can be hidden or locked, and locked drawings can't be selected or moved. Deleting a layer moves its drawings to *Drawings*. A tick box also shows the board's own records with a position.
- **Resources:** teams, vehicles, aircraft, boats or equipment.
  - Each has a status: *Ready* (green), *In use* (blue), *Needs attention* (amber) or *Offline* (grey).
  - **Place on map** puts one on the map, where it shows as an icon ringed in its status colour. You can drag it later.
  - A position is wherever someone last placed it; nothing is tracked live.
- **Tasks:** a task log with a title, a type, and optionally a resource and a drawing.
  - Status moves *Requested → Accepted → In progress → Done*, or *Cancelled*; **Reopen** sends a finished task back to *Requested*.
  - Each change is logged with the time, the device and an optional note.
- **Download GeoJSON** exports the board's drawings for QGIS and other GIS tools.
- Everything saves with the board, so per-board saving, conflicts, backups and project export cover it.

### Graph
- Graph nodes are movable and connectable. Click a node or connection to edit its label, kind, status, summary, relationship and **cardinality** (1:1, 1:N, N:1, N:M).
- The default relationship and cardinality for new connections is set in the toolbar.
- **Auto layout** offers layered, grid or circle arrangements.
- **Add records as nodes** turns the board's records into nodes.
- **Suggest links** proposes connections based on shared actors, sources, conflict names or saved comparisons. Each one waits for you to accept or dismiss it; Atlas no longer invents "related to" edges.
- **Search around** pulls in what a node is connected to. Select a node and look at **Search around** in the panel on the right.
  - A node made by hand is first linked to Wikidata: **Find on Wikidata** suggests matches, and **This is it** links it. Nodes added from Explore are already linked.
  - **Search around** lists the node's connections, grouped by relationship:
    - → *its own statements*, e.g. *member of → Al-Qaeda*, *place of birth → Riyadh*;
    - ← *items that name it in a role*, e.g. participant, perpetrator, target, founder, leader, member, author or location.
  - Tick what you want, or use **Add all** for a group, then **Add selected**. Each new node gets a type (Actor, Organisation, Place, Historical event or Source) and goes on a ring around the node. A neighbour already on the board is linked, not duplicated.
  - Links are dashed, labelled with the relationship, point the way the Wikidata statement does, and are marked *From Wikidata (unverified)*.
  - Expand any new node the same way, hop by hop. **Undo last expansion** removes exactly what was just added.

### Touch and Apple Pencil
- **Device modes:** Windows, macOS or iPad. Atlas detects the device automatically, and you can change it in the top bar. iPad mode enlarges touch targets and graph handles and uses 16 px inputs so iOS doesn't zoom.
- **Settings → Preview layouts…** shows a read-only copy of Atlas at iPad, MacBook and Windows screen sizes.
- **Sketch** (Graph or Folders view):
  - pen with pressure, highlighter, eraser, colours, width, and undo/redo;
  - **Pencil only** mode ignores palm and finger contact, and turns on automatically when a pencil is detected;
  - sketches save as PNGs to a folder you choose and can link to a node.

### Export
All exports keep linked records and source metadata.

| Export | Contents |
|---|---|
| Board records (JSON) | Lossless: evidence, actors, figures, provenance, comparison links, import log. Re-importable. |
| Board records (CSV) | Spreadsheet. Columns match the import template; formula-like cells are neutralised. Re-importable, but only the first casualty figure keeps its own columns. |
| Evidence register (CSV) | One row per source, with the claim and the fields it supports. |
| GeoJSON | For QGIS and other GIS tools. Embeds the full record, so Atlas can re-import it losslessly. |
| Project JSON | All boards, graphs, folders and links. |
| Full workspace backup | Every project, downloaded from the host. |

## 5. Cost, services and licences

Atlas uses no paid service, trial, account or API key.

| Component | Terms | Needs internet? |
|---|---|---|
| [OpenFreeMap](https://openfreemap.org/) basemap (styles, tiles, fonts) | Free public instance. No registration, no API key, no limit on views or requests (checked 2026-10-15). **Attribution required** and shown on the map. It is a hosted third-party service: if it is unreachable, Atlas falls back to offline outlines. | Yes, on the Windows host |
| OpenStreetMap data (in the basemap) | ODbL 1.0, © OpenStreetMap contributors (OpenMapTiles schema) | — |
| [Natural Earth](https://www.naturalearthdata.com/) outlines, via `world-atlas` (ISC) | Public domain. Bundled for the offline fallback. Borders are illustrative. | No |
| MapLibre GL JS | BSD-3-Clause | No |
| React Flow (`@xyflow/react`) | MIT. Its attribution badge is hidden, which MIT allows; the authors ask commercial users to support them. | No |
| React, lucide-react, topojson-client, Vite, TypeScript | MIT / ISC / Apache-2.0 | No |
| UCDP GED (optional import, **not bundled**) | CC BY 4.0. Cite UCDP and the version. | Only to download |
| [Wikipedia](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content) (Explore) | Article text CC BY-SA 4.0; Atlas shows attribution and saves the article as a cited source. Free API, no account. | Yes, on the Windows host |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Licensing) (Explore) | CC0. Facts, dates, places, related events and database links through the free API and Query Service. | Yes, on the Windows host |
| [GDELT Project](https://www.gdeltproject.org/) (Explore news) | Free news index; cite the GDELT Project. One request every 5 seconds. Articles belong to their publishers: Atlas shows titles and links only. | Yes, on the Windows host |
| [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) (Map workspace) | No key or account. Attribution "Esri, Maxar, Earthstar Geographics" is shown on the map. **Esri's terms of use apply:** fine for personal research; check them before any commercial use. | Yes, on the Windows host |
| [EOX Sentinel-2 cloudless 2023](https://s2maps.eu/) (Map workspace) | CC BY-NC-SA 4.0: **non-commercial use only**, with attribution (shown on the map). Contains modified Copernicus Sentinel data 2023. | Yes, on the Windows host |
| [OpenStreetMap Nominatim](https://nominatim.org/) (place search on both maps) | Free public service under the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most one request per second, results cached, no search-as-you-type. Data ODbL, © OpenStreetMap contributors, shown with the results. | Yes, on the Windows host |
| Terra Draw, terra-draw-maplibre-gl-adapter (Map workspace drawing) | MIT | No |

If you import other datasets, follow their licences. The import wizard records licence and citation on every record.

## 6. Honest limitations

- **No event data is included.** Records exist only after you enter them or import a properly licensed file.
- **Place search finds places, not records' coordinates.** It searches OpenStreetMap only when you press Search (one search per second at most). It doesn't fill in coordinates on records by itself: use *Pick on globe*, or add the place as a marker on the Map page. Results depend on OpenStreetMap's coverage and spelling.
- **The basemap needs internet** on the Windows PC. Offline, you get country outlines only: no labels, roads or towns.
- **Conflicts are resolved per board,** not per record or field. If two devices edit the same board, you keep one version of that board. "Keep this device's version" replaces the host's copy of that board, which is backed up first.
- **Large boards still cost time when you change them.** Atlas sends only changed boards, but it sends a changed board whole:
  - A 5,000-record UCDP board is about 17 MB. Saving it takes about half a second on the Windows PC and a few seconds over Wi-Fi from an iPad.
  - When another device changes a large board, every device downloads that board again.
  - Splitting big imports into several boards keeps edits fast. Tens of thousands of records on one board also slow down the map and the first load.
- **Full backups use disk space.** Each `projects-auto-*` backup is a complete copy of the workspace, so 40 of them take 40 times its size. OneDrive also syncs them if Atlas lives in a OneDrive folder; use `ATLAS_DATA_DIR` to keep data elsewhere.
- **No user accounts, HTTPS or audit log.** One shared access code covers all LAN devices.
- **Some judgements are left to you.** Atlas checks sources' structure, not their truthfulness. Similarity and duplicate checks are heuristics. Neutral-language hints are advisory.
- **Apple Pencil limits.** Pressure works where the browser reports it (Safari on iPad does). Sketches are PNGs and can't be edited as vectors.
- **Investigate matches by name and Wikidata ID only.**
  - Two different people with the same name and no Wikidata ID show as one entity. Linking a node to Wikidata (*Find on Wikidata* in the Graph view) separates them.
  - A different spelling is only suggested, never merged on its own. Names in other scripts are not matched to their English forms.
  - *Listed together* means two names appear on the same records. It is not a relationship and doesn't show coordination or responsibility.
  - Entities cover one project at a time. Free-text place names and Map-workspace drawings are not used.
- **Watchlist checks are leads, not facts.**
  - Checks run only while the Windows host is running. There are no email or phone notifications, and at most 100 watches.
  - GDELT matches by phrase from 2017 onward, so common names catch unrelated people; sharpen the phrase in **Edit**.
  - Wikidata changes can be mistakes or vandalism.
- **Search around only knows Wikidata.**
  - Connections come from Wikidata, which is community-edited, so links are marked unverified.
  - Incoming links are searched only through roles (participant, founder, member, location and similar), not every mention.
  - Incoming links stop at 300 per lookup, which matters for very connected items such as countries.
- **Explore shows what public sources hold, not everything.**
  - Wikipedia and Wikidata are edited by volunteers and can be wrong, out of date or one-sided. That is why saved items start as *Unverified*: check important facts in the cited sources.
  - GDELT covers news from 2017 onward only and often limits requests. While it does, the News tab stays empty until you retry.
  - Different spellings of a name in different languages (such as Usama, Osama, Oussama) are not merged.
  - Summaries and labels are in English. Other languages appear as links.
  - Explore needs internet on the Windows PC. Its cache is in memory and empties when the host restarts.
- **The Map workspace is a drawing and planning tool, not a live picture.**
  - Satellite images are mosaics of different dates, which can be years old, and differ from place to place.
  - Sentinel-2 imagery stops at zoom 15 (about 10 m per pixel); Esri goes to zoom 19 where it has detail.
  - Distances and areas are worked out on a sphere and are accurate to about 0.5 %. Routes are straight lines between your points; there is no road routing.
  - Resource positions are wherever someone last placed them. There is no live GPS tracking.
- **Files and history.** There is no general file or attachment upload beyond notes, links and sketches, and no version history beyond the automatic backups.

## 7. Development

```powershell
npm.cmd run dev      # Vite dev server on port 5173 (LAN-visible); keep "npm.cmd run host" running in another window for /api
npm.cmd test         # logic, security, storage and sync tests, plus an end-to-end host test (Node 22.18+)
npm.cmd run build    # type-check + production build (also syncs the MapLibre worker)
```

| Path | Contents |
|---|---|
| `server/host.mjs` | HTTP host: static files, workspace and per-board API, basemap proxy |
| `server/store.mjs` | Storage: index + one file per board, per-board revisions, 0.2 conversion, backups |
| `server/security.mjs` | Private-network allowlist, host/origin checks, access codes |
| `src/sync.ts` | Which boards to save, picking up other devices' saves, conflict wording |
| `server/watch.mjs`, `src/watch.ts`, `src/components/WatchlistView.tsx`, `WatchButton.tsx` | Watchlist: scheduled news and Wikidata checks, `data/watch.json`, the page, badge and Watch buttons |
| `server/geocode.mjs`, `src/components/PlaceSearch.tsx` | Place search on both maps (OpenStreetMap Nominatim, spaced and cached) |
| `src/entities.ts`, `src/components/InvestigateView.tsx`, `InvestigatePanes.tsx`, `EntityMerge.tsx` | Investigate: entities derived from nodes, record actors and countries; connections; duplicate suggestions; merge decisions; the page, its diagram and timeline, and the merge dialog |
| `server/explore.mjs`, `src/explore.ts` | Explore: Wikipedia/Wikidata/GDELT look-ups, cache and rate limit; turning topics into records, nodes and links |
| `src/components/MapWorkspace.tsx`, `src/OpsMap.tsx`, `src/ops.ts`, `src/geo.ts`, `server/tiles.mjs` | Map workspace: page and panels; map, drawing and overlays; drawings, layers, resources and task rules; lengths and areas; satellite tile addresses |
| `src/types.ts`, `src/model.ts` | Data model, vocabularies, migration, validation, layer rules |
| `src/importer.ts`, `src/exporters.ts` | CSV parser, mapping, UCDP GED preset, duplicates, exports |
| `src/similarity.ts`, `src/graph.ts` | Explainable similarity; graph layouts and link suggestions |
| `src/components/*` | World, Graph, Folders, Timeline, Settings, record editor, import wizard, sketch |
| `tests/*.test.mjs` | Node built-in test runner; no extra dependencies. `tests/fixtures/explore` stands in for the public sources, so tests never use the network |

### Changes in 0.8.0
- New **Watchlist** page:
  - follow Investigate entities, Explore topics (**Watch** button) and news keywords;
  - the Windows host checks GDELT news and Wikidata changes every 6 hours (hourly, daily or manual) and shows what is new, with a menu badge;
  - the first check only records a baseline;
  - news alerts can be saved to a board folder (*Watch: name*);
  - Wikidata alerts are marked unverified.
- Watches and alerts live in `data/watch.json`, not in projects or boards. Checks run only while the host runs. There are no email or phone alerts, and at most 100 watches.
- **Place search** on the Map workspace (with a temporary pin and **Add as marker**) and on the World view (**Find place**), through OpenStreetMap Nominatim.
- API: `GET|POST /api/watch`, `GET /api/watch/summary`, `PUT|DELETE /api/watch/:id`, `POST /api/watch/check`, `POST /api/watch/seen`, `PUT /api/watch/settings`, `GET /api/geo/search?q=`.

### Changes in 0.7.0
- New **Investigate** page (connected view):
  - one profile per person, organisation, place or event across the project;
  - connections (graph links and records listed together), a map and a timeline with linked selection;
  - sources, folder material and boards for each entity;
  - **Open in Graph** and **Show on World** open with the entity highlighted.
- **Possible duplicates** with **Merge**, **Unmerge** and **Not the same**. Merges are link-only and are saved as `entityDecisions` in the project's settings. Records and nodes are never changed.
- No new API: decisions travel in the existing `PUT /api/projects/:projectId`.

### Changes in 0.6.0
- New **Map** page (Map workspace) for the current board:
  - switchable satellite imagery (Esri and Sentinel-2) as well as streets and offline outlines;
  - markers with 20 symbols, routes with length and direction, areas, rectangles, circles and text labels, in layers you can hide or lock;
  - measuring, reshaping, and GeoJSON export of the drawings;
  - resources with statuses and map positions;
  - a task log with a fixed status workflow and a time-stamped history.
- Boards gain `mapFeatures`, `mapLayers`, `resources` and `tasks`; older boards get empty lists.
- API: `GET /api/map/sat/:provider/:z/:x/:y` (`esri` up to zoom 19, `eox` up to zoom 15), behind the same access-code and private-network checks.

### Changes in 0.5.0
- **Search around** (link analysis) in the Graph view. Link a node to Wikidata, then add its connections as typed nodes with labelled, directed, sourced links, hop by hop, with undo.
- API: `GET /api/explore/neighbors/:qid`.

### Changes in 0.4.2
- Projects can be deleted: Settings → Project and boards → **Delete project**.
  - The host first saves the whole project as `data/backups/project-before-delete-*.json`, which Settings → *Restore from backup…* can bring back.
  - If another device changed the project in the meantime, nothing is deleted and a banner asks what to do.
  - Other devices remove the project automatically unless they have unsaved edits in it.
  - The Military workspace stays protected.
- API: `DELETE /api/projects/:projectId` with `{ baseRevision, boardRevisions }`.

### Changes in 0.4.1
- World search: a line under the box says how many of this board's records match. **Enter** goes to the first match on the map, or, when nothing on the board matches, opens Explore and searches public sources (for example, typing `india` and pressing Enter).
- Explore: related events are looked up separately and only through properties that tie an event to the topic (participant, target, location, and so on). Large topics such as countries no longer time out; the page shows first and events follow with their own *Try again*.

### Changes in 0.4.0
- New **Explore** page: live search in Wikipedia, Wikidata and GDELT news, with a summary, key facts, dated events on a map, every cited and database link, news, and matches from your own workspace. Topics, events and links are saved to a board only when you choose, with source and licence.
- Search boxes everywhere ignore case, accents, extra spaces and word order, and match `binladen` to `bin Laden`. An empty World search explains why and points to matching graph nodes.
- API: `GET /api/explore/search?q=`, `GET /api/explore/topic/:qid`, `GET /api/explore/news?q=&before=`. They are behind the same LAN access-code and private-network checks.

### Changes in 0.3.0
- Per-board saving: each board is stored in its own file with its own revision. Only changed boards are sent and written, and devices download only boards that changed elsewhere.
- Conflicts are per board, and the banner names the board. Other boards keep saving while you decide.
- One-time, verified conversion of `data/projects.json`, with the original kept in `data/backups`. Rolling back by copying a backup over `projects.json` still works.
- Board backups before an overwrite or deletion can be restored from Settings. `/api/workspace` and `/api/export` work as before.
- API: `GET /api/workspace/manifest`, `GET|PUT|DELETE /api/boards/:projectId/:boardId`, `PUT /api/projects/:projectId`. Each write sends `baseRevision`, and the host answers `409 { error: "conflict", reason }` when that revision is stale.

### Changes in 0.2.0
- Evidence-first record model: actors with attribution status, casualty ranges with definitions, equipment references, and sources linked to the claims and fields they support.
- Import wizard (CSV, JSON, GeoJSON, UCDP GED) with licence gate, validation, duplicate detection, batch log and undo.
- Explainable similarity with coverage, selectable factors and labelled comparison links.
- Map layer rules, date-range filter, verification colours, safe click-to-add, pick on globe, and offline Natural Earth fallback.
- Graph node and edge inspector, cardinality editing, three layouts, reviewable link suggestions.
- Host: revision-checked saves, conflict banner, atomic writes, rolling backups, gzip, LAN access code, private-network allowlist, DNS-rebinding and cross-site protection. The `*` CORS header was removed.
- Sketch tool with pencil-only mode, eraser and undo; folder items linked to many nodes and records; device modes and layout preview.
