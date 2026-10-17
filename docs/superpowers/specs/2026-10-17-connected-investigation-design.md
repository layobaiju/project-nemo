# Connected investigation view: design

Date: 2026-10-17 · Status: design approved in chat, part by part; this written spec awaits review · Atlas 0.6.0 → 0.7.0

## Goal

People, organisations, places and events become shared objects across a project. One **Investigate** page shows
everything Atlas holds about one of them, in linked panes:

- its profile;
- its connections;
- its records on a map and on a timeline;
- its sources and folder material.

Selecting something in one pane updates the others. Likely duplicates are suggested, and merging them is the user's call.

## Decisions made with the user

- **Layout:** one new linked page, Investigate. The existing pages are not reworked. Graph and World only learn to open
  with an entity highlighted.
- **Where entities come from:** graph nodes, actor names on records, and countries on records. Free-text place names
  are not used: they are too noisy.
- **Merging is link-only:** records and nodes keep their original wording. A merged entity lists every spelling as
  an alias. **Unmerge** splits it again.
- **Approach:** entities are *derived* from the project's data every time it changes. Only the user's decisions are
  stored: merges and "not the same" pairs. There is no entity register and no migration.

## Entities

- **Kinds and families:**

  | Kind shown | Family | Comes from |
  |---|---|---|
  | Person | actor | node kind `Actor`; record actor type `Individual` |
  | Organisation | actor | node kind `Organisation`; record actor types `State force`, `Armed group`, `Government / political body`, `International organization`, `Civil society / NGO` |
  | Other actor | actor | record actor type `Other / unknown` or empty |
  | Place | place | node kind `Place`; record countries |
  | Event | event | node kinds `Event`, `Historical event` |

  Other node kinds (Note, Source, Claim, Idea and so on) do not make entities.

- **Scope:** every board in the current project.
- **Mentions:** each occurrence is a *mention*.
  - **Node mention:** `{ boardId, nodeId, label, kind, wikidata? }`.
  - **Actor mention:** `{ boardId, recordId, name, type, role, attribution }`.
  - **Country mention:** `{ boardId, recordId, name }`.
- **Keys:**
  - A Wikidata-linked node has the key `wd:<QID>`.
  - Every mention also has a name key, `n:<family>:<normalizeName(name)>`.
  - `normalizeName` is the existing search normaliser: case, accents, punctuation and extra spaces are ignored.
- **Grouping**, in this order:
  1. Node mentions with the same QID form one entity.
  2. A name-only mention joins the single QID entity of the same family whose label or alias has its name key.
     - If two different QID entities share that name, the mention isn't guessed. It stays in its own name-only
       entity, which is offered as a possible duplicate of both.
  3. The remaining name-only mentions group by name key. Within the actor family, Person, Organisation and Other
     actor all group together.
  4. Merge decisions are applied last (see *Decisions*).
- **What the user sees:**
  - **Display name:** the chosen merge name if there is one; else the most common label among QID nodes; else the
    most common spelling. Ties go to the first seen.
  - **Kind:** the QID node's kind, else the most common kind among the mentions.
  - **Aliases:** every other spelling.
- **An entity's records** are the records that:
  - list it as an actor (role and attribution as recorded);
  - list it as a country;
  - are linked to one of its nodes, through `node.data.recordId` or `record.nodeId`.
- **An entity's folder items** are items linked to its nodes, or to the records its nodes stand for. They are not
  every record that mentions it: a country would otherwise pull in half the project.
- **An entity's sources** are the evidence on its records, de-duplicated by URL (or by title when there is no URL),
  with the number of records each supports.

## Connections

- **Graph links:** an edge between a node of entity A and a node of entity B.
  - Shows the edge's relationship and direction, and the board it is on.
  - Drawn solid.
- **Listed together:** entities that appear as actors, countries or linked nodes on the same record.
  - Shows the number of shared records.
  - Drawn dashed and labelled *listed together on N records — not evidence of a relationship*.
- **Ranking:** up to 24 neighbours are shown, graph links first, then by shared-record count. A note gives the total
  when there are more.

## Possible duplicates

- **When a pair is suggested:** both entities are in the same family, they don't have two different QIDs, they
  aren't marked "not the same", and either:
  - **Close spelling:** the edit distance between the normalised names is at most 2, and both names have at least 6
    letters. Example: *Usama bin Ladin* and *Osama bin Laden*.
  - **Containment:** every word of the shorter name appears in the longer one, and the shorter name has at least 5
    letters. Example: *bin Laden* and *Osama bin Laden*.
- **Numbered names:** names whose digits differ are never suggested, e.g. *Group 1* and *Group 11*, or *Brigade 4*
  and *Brigade 5*.
- **Ambiguous name-only entities** from grouping step 2 are suggested against each QID entity they could be.
- **Order and limit:** at most 200 suggestions, those with more mentions first.
- **Speed:** edit distance is only computed when the lengths differ by 2 or less.

## Decisions (stored)

- **Where:** in the project's settings as `entityDecisions`, saved through the existing project save: revision-checked,
  synced, backed up, and covered by the existing conflict banner.

  ```
  entityDecisions: {
    merges:   [{ id, keys: string[], name: string, at: ISO date, by: device }],
    distinct: [[keyA, keyB]]
  }
  ```

- **Merge:** stores every key of both entities, so the merge survives a node later gaining a QID. An entity joins a
  merge when any of its keys is in `keys`.
  - When two merges would overlap, they are combined.
  - A merge whose keys match fewer than two current entities is kept but has no effect, so it applies again if the
    data comes back.
- **Unmerge:** removes the merge.
- **Not the same:** stores the pair of keys, which stops that suggestion.
- **Kinds:** a merge across families (an actor with a place) is refused.
- **Read-only devices:** they can view but not change decisions.
- **Normalising:** `normalizeProjects` keeps `entityDecisions` and drops malformed entries.

## The Investigate page

- **Menu:** **Investigate**, after Explore. The page is lazy-loaded, like the Map page.
- **Left: entity list.**
  - Groups: People, Organisations, Other actors, Places, Events. Each is sorted by number of mentions.
  - A search box that also matches aliases.
  - **Possible duplicates (N)** at the top. It opens a list of pairs showing the reason, both names and their counts,
    with **Merge** and **Not the same** buttons.
- **Top: profile.**
  - Name, kind, aliases, a Wikidata link when there is a QID, and the node's summary.
  - Counts: records, nodes, folder items and boards.
  - Buttons: **Open in Graph**, **Show on World**, **Explore** (`ctx.searchWorld(name)`), **Merge with…** and
    **Unmerge** (only for a merged entity).
- **Panes**, side by side on wide screens and stacked on iPad and phone:
  - **Connections:**
    - A small SVG diagram with the entity in the centre and its neighbours on a ring, using the line styles above.
    - Clicking a neighbour makes it the focus. **Back** returns to the previous one.
    - Clicking a line lists the records behind it (listed together) or the edges (graph links).
  - **Map:** the existing World map component, showing only the entity's records with coordinates, coloured by
    verification and framed to fit them.
  - **Timeline:** an SVG strip of the entity's dated records along a year axis. Undated records are counted beside it.
- **Linked selection:** clicking a record on the map, the timeline or the Records tab selects it in all three. It is
  highlighted on the map, ringed on the timeline, and its compact summary shows with **Open record**.
- **Bottom tabs:**
  - **Records:** each with the entity's role, e.g. *Actor · Alleged*, *Country* or *Linked node*.
  - **Sources.**
  - **Folders.**
  - **Appears on:** each board with its counts and an Open button.
- **Merge with…:**
  - Searches entities of the same family.
  - Shows both entities side by side with their counts and a choice of the name to show, then **Merge**.
- **Remembered:** the selected entity and tab, per viewer (`usePersisted`).
- **Empty project:** explains where entities come from and offers **Explore** and **Graph**.

## Opening other pages with an entity highlighted

- **The shell** gains a focus, `{ label, boardId?, nodeIds, recordIds }`. It lives in memory only and is never saved
  to a board.
- **Open in Graph:**
  - Switches to the board holding the entity's node, with a menu when several boards do.
  - Rings those nodes, dims the rest and fits the view to them.
  - A chip, *Highlighting Osama bin Laden ×*, clears the focus.
- **Show on World:** shows only the entity's records on the current board's map and list. A chip, *Showing 12 records
  for Osama bin Laden ×*, clears it. If none are on the current board, the chip offers the boards that have them.

## Code

- **`src/entities.ts`**, pure and tested:
  - `buildEntities(project, decisions)` returns `{ entities, byKey }`. Each entity holds `{ key, keys, name, kind,
    family, aliases, qid?, mentions, recordRefs, nodeRefs }`.
  - `connectionsOf(index, key)`.
  - `suggestDuplicates(index, decisions)`.
  - `entityFolderItems` and `entitySources`.
  - `merge`, `unmerge` and `markDistinct`, which return new `entityDecisions`.
  - `normalizeDecisions`.
- **`src/components/InvestigateView.tsx`**: the page, `ConnectionsDiagram`, `TimelineStrip`, the merge dialog and the
  duplicates list. It reuses `InteractiveMap` and `RecordSummary`.
- **Small changes:**
  - `src/main.tsx`: menu entry, lazy import, focus state and project-settings patching for decisions.
  - `src/ctx.ts`: `View` gains `'Investigate'`; `Ctx` gains `focus`, `setFocus` and `patchProject`.
  - `src/components/GraphView.tsx` and `src/components/WorldView.tsx`: focus chip and highlighting.
  - `src/model.ts`: keeps `entityDecisions`.
  - `src/components.css`.
  - README: an *Investigate* section, these limits and *Changes in 0.7.0*. Version 0.7.0 goes in `package.json`,
    `package-lock.json`, `server/host.mjs` and the README sample output.
- **Host:** no changes. Decisions travel in the existing `PUT /api/projects/:projectId`.
- **Performance:** `buildEntities` is memoised on the project's boards. Target: under 300 ms for a project holding a
  5,000-record board.

## Testing

- **`tests/entities.test.mjs`:**
  - grouping by QID;
  - grouping by name across Person, Organisation and Other actor;
  - places kept apart from actors;
  - an ambiguous name not guessed but suggested;
  - display name and aliases;
  - an entity's records, folder items and sources;
  - graph-link and listed-together connections, with their counts and ranking;
  - suggestions: Usama/Osama, containment, and not suggesting pairs with different QIDs or already marked distinct;
  - merge, overlapping merges, unmerge, not the same, a merge surviving a node gaining a QID, and cross-family
    merges refused;
  - `normalizeDecisions` dropping bad entries;
  - 5,000-record build time.
- **Sync:** a test that changing decisions produces one project save and no board saves.
- **Browser check** on a copy of the data, on host port 4191, covering:
  - the entity list and profile;
  - linked selection across the map, timeline and list;
  - clicking a connection;
  - merge, unmerge and not the same;
  - Open in Graph and Show on World with their chips;
  - phone width (375 px) without sideways scrolling.
- **Full run:** `npm.cmd test` and `npm.cmd run build`.

## Limits (README)

- **Matching:** uses names and Wikidata IDs only. Two different people with the same name and no Wikidata ID show as
  one entity. Linking a node to Wikidata (*Find on Wikidata* in Graph) separates them.
- **Listed together:** means only that two names appear on the same records. It is not a relationship, and it
  doesn't show coordination or responsibility.
- **Spellings:** a different spelling is only suggested, never merged on its own. Names in other scripts are not
  matched to their English forms.
- **Scope:** entities cover one project at a time.

## Out of scope

- Entities from free-text place names or from Map-workspace drawings.
- Automatic merging of near matches.
- Entities that span projects.
- Editing records on the Investigate page; *Open record* does that.
- Splitting one name-only entity into several people.
