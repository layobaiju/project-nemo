# Search around (link analysis): design

Date: 2026-10-17 · Status: design approved in chat; the user asked to go straight on to the plan and the build · Atlas 0.4.2 → 0.5.0

## Goal

From any graph node, pull in what is connected to it, hop by hop, with labelled, sourced links. This is Palantir's
"search around".

**Success:**
- Select the node "osama binladen" on the Military board's graph and link it to Wikidata Q1317 once.
- Open Search around and see grouped connections, such as *member of → Al-Qaeda*, *founded by ← Maktab al-Khidamat*
  and *target ← killing of Osama bin Laden*.
- Tick some and add them. They appear as typed nodes around the selected one, joined by labelled links.
- Any new node can be expanded the same way.
- *Undo last expansion* removes exactly what was added.

## Data (checked live on 2026-10-17)

- **Outgoing connections:**
  - **Source:** the topic's own item-valued statements, taken from the cached Explore topic (`facts[].values[]` that have
    an `id`).
  - **Excluded:** `P31`, `P279` and Wikimedia housekeeping properties (`P910`, `P1343`, `P5008`, `P1424`, `P7867`,
    `P1792`, `P2354`, `P5125`, `P6104`, `P1151`, `P8989`).
- **Incoming connections:**
  - **Query:** one SPARQL query, `?item ?p wd:QID`, limited to role properties: `P710` participant, `P8031`
    perpetrator, `P8032` victim, `P533` target, `P664` organizer, `P112` founded by, `P488` chairperson, `P35` head of
    state, `P6` head of government, `P463` member of, `P102` member of political party, `P108` employer, `P1037`
    director/manager, `P3342` significant person, `P50` author, `P3320` board member, `P749` parent organization,
    `P127` owned by, `P276` location and `P159` headquarters location.
  - **Limit:** 300 rows. `capped` is set when the limit is reached.
  - **Speed:** 0.5–1.0 s for Q1317, Q34490 (al-Qaeda) and Q668 (India, capped).
- **Neighbour details:** one batched SPARQL query (≤ 300 ids per batch, at most 4 queries at once) returns each
  neighbour's description, instance-of labels, whether it has a position (P625) and whether it has a date (P585 or P580).
- **Node kind**, first match wins:
  1. `Actor` if instance of human (Q5).
  2. `Organisation` if a type label matches organisation, group, party, company, agency, militia, movement, army, force,
     government, ministry, bank, corporation, institution, union or network.
  3. `Historical event` if the item has a date, or a type label matches war, battle, attack, bombing, conflict,
     operation, event, election, massacre, incident, killing, invasion, revolution, siege or raid.
  4. `Place` if the item has a position, or a type label matches city, country, state, town, village, region,
     province, district, building, compound, capital, territory, island, mountain or river.
  5. `Source` if a type label matches book, document, letter, publication, written work, speech, manifesto, film or
     video.
  6. Otherwise `Note`.
- **Link direction** follows the Wikidata statement:
  - outgoing: the expanded node → the neighbour, e.g. *Osama bin Laden —member of→ Al-Qaeda*;
  - incoming: the neighbour → the expanded node, e.g. *killing of Osama bin Laden —target→ Osama bin Laden*.

## Host

- **Function:** `explore.neighbors(qid)` returns:

  ```
  { id, label,
    groups: [{ key: 'out:P463' | 'in:P8031', property, relation, direction: 'out' | 'in',
               items: [{ id, label, description, kind }] }],
    capped, errors }
  ```

- **Group order:** outgoing groups in fact order first, then incoming groups by size.
- **Duplicates:** the topic itself and duplicate items within a group are dropped.
- **Cache:** 24 h.
- **Partial failure:** a failed incoming query or details query is reported in `errors`; the outgoing groups still
  return.
- **Route:** `GET /api/explore/neighbors/:qid` (Q-id checked). It sits behind the same access-code and
  private-network checks as everything else.

## Client

- **`src/searchAround.ts`**, pure:
  - `wikidataIdOf(node)`
  - `linkNodeToWikidata(board, nodeId, candidate)`
  - `expandNode(board, nodeId, picks)` returns `{ board, added: { nodeIds, edgeIds } }`
  - `undoExpansion(board, added)`
- **New nodes:**
  - **Layout:** placed on a ring of radius 260 around the expanded node; a second ring at 420 when more than 16 nodes
    are added.
  - **Data:** each carries `data.wikidata`, `data.url`, `data.kind` and `data.detail` (the description).
  - **Duplicates:** a neighbour that already has a node on the board, matched by `data.wikidata`, is linked rather
    than duplicated.
- **New links:**
  - **Shape:** `makeEdge(source, target, relation, 'many-to-many')` with
    `data: { relation, cardinality, origin: 'Wikidata', property, note: 'From Wikidata (unverified)' }` and a dashed
    style.
  - **Duplicates:** a link with the same source, target and relation is not added twice.
- **Undo:** removes only the nodes the expansion created and the links it added.
- **Graph inspector:** a new "Search around" section for the selected node.
  - **Unlinked node:** "Find on Wikidata" runs an Explore search with the node's label and lists the candidates;
    "This is it" links the node.
  - **Linked node:** "Search around" lists the groups with counts, a filter box, checkboxes, "Add all (n)" per group
    and "Add selected (k)".
  - **After adding:** a notice, plus "Undo last expansion".
  - **Status:** loading, error and "Try again" states, and a note about the 300-link cap.
  - **Preview:** disabled in read-only preview.
- **Saving:** everything goes through `ctx.patchBoard`, so per-board saving, conflicts and backups apply.

## Limits (README)

- Connections come only from Wikidata, which is community-edited, so links are marked unverified.
- Incoming links are capped at 300 per lookup, which matters for very connected items such as countries.
- Only role properties are searched for incoming links, not every mention.

## Out of scope

- Automatic multi-hop expansion.
- Connections from news.
- Merging duplicate nodes the user created by hand (entity resolution comes with the connected investigation view).
