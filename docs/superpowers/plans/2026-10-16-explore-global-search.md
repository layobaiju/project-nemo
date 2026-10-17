# Explore (global search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Explore page. A name or topic is searched live in Wikipedia, Wikidata, GDELT and the user's workspace, and the
page shows the summary, facts, dated events on a map, every link and news. The user saves chosen pieces into a board with
source and licence attached.

**Architecture:** `server/explore.mjs` fetches and normalises the outside sources. It has an injected `fetchText`, an
in-memory TTL cache and a GDELT request queue. `server/host.mjs` exposes it as three GET routes behind the existing access
checks. `src/explore.ts` turns a topic into Atlas records, nodes and folder links (pure, tested). `src/components/ExploreView.tsx`
renders the page and saves through `ctx.patchBoard`, so per-board saving, conflicts and backups apply unchanged.

**Tech Stack:** Node ≥ 22.18 built-in `fetch` and `node:test`, React 18 + TypeScript, MapLibre via the existing `InteractiveMap`.

**Spec:** `docs/superpowers/specs/2026-10-16-explore-global-search-design.md`

## Global Constraints

- No paid service, account or API key. Only these upstream hosts: `en.wikipedia.org`, `www.wikidata.org`, `query.wikidata.org`,
  `api.gdeltproject.org`.
- User-Agent `Atlas-Workspace/0.4 (self-hosted research tool)` on every upstream request. Timeout 15 s per request (SPARQL 30 s).
- Cache TTLs: search and topic 24 h; news 6 h. Cache cap 50 MB, memory only, nothing written to `data/`.
- GDELT: at most one request every 5.5 s. After HTTP 429, back off 30 s, then 60 s, then 120 s; a success resets this.
  While blocked, return `{ articles: [], busy: true, retryAfter }` at once. News starts at `20170101000000`; 75 articles per
  page, newest first.
- Wikipedia external links: follow `elcontinue`, de-duplicate, cap at 5,000.
- Saved records: `verification` and `confidence` are `Unverified`. Wikipedia evidence uses licence `CC BY-SA 4.0`; Wikidata
  evidence uses `CC0 / Public domain` (both in `LICENSES`). Provenance origin is `Explore (Wikidata/Wikipedia)`, `originalId`
  is the Q-id.
- Route input: `q` 1–200 characters after trimming; Q-id `^Q\d{1,12}$`; `before` `^\d{14}$`.
- TS files imported by tests use `import type` for types and `.ts` extensions (Node type stripping).
- Version 0.4.0 (`package.json`, `VERSION` in `server/host.mjs`, README sample output).
- No git repository here: each task ends with the full `npm.cmd test` run instead of a commit.

## Review Focus

1. **Spelling, quotes, non-Latin scripts.** Inputs like `osama binladen`, `"bin laden"` or `أسامة بن لادن` must still search
   and never break the GDELT phrase. Covered in Task 1, `news query is quoted safely`.
2. **No English Wikipedia article.** A Wikidata-only topic renders with `wikipedia: null` and no error. Task 1,
   `topic without an English article`.
3. **Very large topics** (for example "United States"). SPARQL `VALUES` lists are chunked to ≤ 300 ids and sent by POST;
   extlinks stop at 5,000. Task 1, `large topics are chunked and capped`.
4. **One source down or the PC offline.** Each section reports its own error; search returns 502 with a readable message
   instead of crashing. Task 1, `a failing source does not blank the topic`, and Task 2, `upstream failure is a 502`.
5. **Saving twice.** The same Q-id saved again to the same board must not create a duplicate record, and links already in the
   folder are skipped. Task 3, `duplicates are detected per board`.

---

### Task 1: Host explore module

**Files:**
- Create: `server/explore.mjs`
- Create: `tests/fixtures/explore/*.json` (hand-trimmed copies of real responses: `wp-search`, `wd-search`, `entity-Q1317`,
  `entity-Q99` (no enwiki), `summary`, `extlinks-1`, `extlinks-2`, `sparql-props`, `sparql-items`, `sparql-events`, `gdelt`)
- Create: `tests/fixtures/explore/fake-fetch.mjs` (default export `fetchText(url, init)` that serves the fixtures by URL
  pattern; returns status 429 for GDELT when the query contains `busy`)
- Test: `tests/explore.test.mjs`

**Interfaces:**
- Produces:
  - `createExplore({ fetchText?, now?, sleep?, log? })` returning `{ search(q), topic(qid), news(q, before?) }`.
    - `fetchText(url, { method?, body?, headers?, timeoutMs? })` resolves to `{ status, text }`. The default uses global
      `fetch` with the User-Agent and refuses hosts outside the allowlist.
  - `search(q)` resolves to `Candidate[]`, where `Candidate = { id, label, description, wikipediaTitle: string | null }`, at
    most 10. Wikipedia `generator=search` hits (with `pageprops.wikibase_item`, in `index` order) come first, then
    `wbsearchentities` hits not already listed. If `q` is a Q-id, returns that single id. Throws
    `Object.assign(Error, { status: 502 })` only if both sources fail.
  - `topic(qid)` resolves to `Topic`:

    ```
    { id, label, description, aliases: string[], types: string[], isHuman: boolean,
      wikipedia: { title, url, extract, thumbnail } | null,
      facts: [{ property, label, values: [{ text, id?, date?, coord? }] }],
      coord: [lng, lat] | null, dates: { start, end, kind: 'life' | 'event' | '' },
      events: [{ id, label, date, endDate, coord: [lng, lat] | null, place }],
      links: { references: Link[], databases: Link[], languages: Link[] },
      attribution, errors: { [section]: message }, fetchedAt }
    ```

    where `Link = { url, label, note }`.
  - `news(q, before?)` resolves to `{ articles: [{ title, url, domain, date: 'YYYY-MM-DD', language, country }], busy?: true,
    retryAfter?: seconds, error?: string }`.
  - Exported pure helpers: `wikidataTime(value)`, `parsePoint(wkt)`, `formatterUrl(fmt, id)`, `chunk(list, size)`.

- [ ] **Step 1: Write the failing tests** in `tests/explore.test.mjs`, using `createExplore({ fetchText: fakeFetch, now, sleep })`
  with a fake clock:
  - `search finds Osama bin Laden from a misspelled name`: `search('osama binladen')` has first item
    `{ id: 'Q1317', label: 'Osama bin Laden', description: 'Founder of al-Qaeda (1957–2011)', wikipediaTitle: 'Osama bin Laden' }`;
    no id appears twice; `search('Q1317')` gives `[{ id: 'Q1317', … }]`.
  - `wikidataTime keeps precision`: precision 11 gives `'1957-03-10'`, 10 gives `'1957-03'`, 9 gives `'1957'`, below 9 gives
    the year; `'+0500-…'` gives `'0500'`.
  - `topic facts use labels, dates and positions`:
    - The facts include `{ label: 'date of birth', values: [{ text: '1957-03-10', date: '1957-03-10' }] }` and
      place of birth `Riyadh` with `coord` `[46.71, 24.63]` (to 2 decimals).
    - A deprecated statement in the fixture is absent, and no fact has an external-id property.
    - `isHuman` is true; `dates` is `{ start: '1957-03-10', end: '2011-05-02', kind: 'life' }`; `coord` is null.
  - `links: formatter URLs, official site first, all Wikipedia sources`:
    - `databases[0]` is the P856 website, and the P214 item has url `https://viaf.org/viaf/97678624` and label
      `VIAF cluster ID`.
    - `references` merges `extlinks-1` and `extlinks-2` with duplicates removed and `//x` turned into `https://x`.
    - `languages` holds the `frwiki` sitelink.
  - `events: dated items only, one row per item, positions from the item or its place`: `killing of Osama bin Laden` has
    `date` `'2011-05-02'` and a coord; `History of the United States (1991–2008)` has `date` `'1991'` (year precision); the
    row with an unknown date is dropped; items are unique.
  - `topic without an English article`: `topic('Q99')` has `wikipedia === null` and `errors.wikipedia` undefined.
  - `a failing source does not blank the topic`: with the SPARQL requests rejecting, facts still list `P19` with value
    `text: 'Q3692'`, `errors.labels` is set and `events` is `[]`.
  - `large topics are chunked and capped`: `chunk` of 650 ids gives 300/300/50; a fake with 12 extlinks pages of 500 stops
    at 5,000 references.
  - `news is spaced, backs off on 429 and is cached`:
    - Two different queries make the second request wait at least 5,500 ms (the fake `sleep` records it).
    - A 429 gives `busy: true, retryAfter: 30`, and the next call within 30 s returns `busy` with no request made.
    - After the wait a 429 gives `retryAfter: 60`; a success then resets the back-off.
    - The same query within 6 h makes no request.
  - `news query is quoted safely`: `news('"bin laden"')` requests `query=%22bin%20laden%22`; a non-JSON GDELT reply gives
    `{ articles: [], error: <its text> }`.
- [ ] **Step 2: Run the tests to verify they fail.** Run `node --test tests/explore.test.mjs`. Expected: FAIL, cannot find
  `server/explore.mjs`.
- [ ] **Step 3: Implement `server/explore.mjs`.**
  - **Topic requests:**
    - `wbgetentities` (`props=labels|descriptions|aliases|claims|sitelinks/urls`, `languages=en`).
    - Then, in parallel:
      - Wikipedia `rest_v1/page/summary/<title>` and the extlinks loop (`formatversion=2`).
      - Three SPARQL POSTs to `https://query.wikidata.org/sparql` with `Accept: application/sparql-results+json`:
        - properties: `?p ?pLabel ?fmt`, with `OPTIONAL { ?p wdt:P1630 ?fmt }`;
        - items: `?i ?iLabel ?coord`, with `OPTIONAL { ?i wdt:P625 ?coord }`, for every item value and quantity unit;
        - events: `{ ?item ?p wd:QID . ?prop wikibase:directClaim ?p } UNION { wd:QID wdt:P793 ?item }`, with
          `p:P585/psv:P585` or `p:P580/psv:P580` giving `wikibase:timeValue` and `wikibase:timePrecision`, optional
          `P582`, `P625` and `P276`→`P625`.
  - **Fact order:** P31, P569, P19, P570, P20, P1196, P27, P463, P106, P39, P140, P793, P276, P585, P580, P582, P17, P131,
    P112, P710, P1344; the rest by label.
  - **Which statements become what:** deprecated ranks are skipped. `external-id` and P856 go to `links.databases`, not facts.
  - **Cache:** a `Map` of key to `{ value, expires, bytes }`, evicting oldest first above 50 MB.
- [ ] **Step 4: Run the tests to verify they pass.** Run `node --test tests/explore.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Run the full suite.** Run `npm.cmd test` (after adding `tests/explore.test.mjs` to the `test` script).
  Expected: all PASS.

### Task 2: Host routes

**Files:**
- Modify: `server/host.mjs`
  - Create the explore instance next to the store.
  - If `ATLAS_EXPLORE_FAKE` is set, dynamically import that module's default export as `fetchText`.
  - Add the routes after the map proxy, which puts them behind the access-code check.
  - Bump `VERSION` to `'0.4.0'`.
- Test: `tests/host.test.mjs` (extend `startHost` to accept extra env)

**Interfaces:**
- Consumes: `createExplore` from Task 1.
- Produces:
  - `GET /api/explore/search?q=` returns 200 `Candidate[]`.
  - `GET /api/explore/topic/:qid` returns 200 `Topic`.
  - `GET /api/explore/news?q=&before=` returns 200 news result.
  - Validation failure returns 400 `{ error }`; upstream failure returns 502 `{ error }`. Responses carry
    `cache-control: no-store`.

- [ ] **Step 1: Write the failing test** `explore routes answer from the injected source and keep the access checks`, with
  the host started using `ATLAS_EXPLORE_FAKE=tests/fixtures/explore/fake-fetch.mjs`:
  - `search?q=osama%20binladen` returns 200 and `[0].id === 'Q1317'`.
  - `topic/Q1317` returns 200 with `facts.length > 0` and `links.references.length > 0`.
  - `topic/Q1317x` returns 400; `search?q=` returns 400; a 201-character `q` returns 400.
  - `news?q=Osama%20bin%20Laden` returns 200 with `articles.length > 0`.
  - `search` with `x-forwarded-for: 192.168.1.50` returns 401.
  - `upstream failure is a 502`: `search?q=offline` (the fake rejects every request for it) returns 502 with an `error`
    string.
- [ ] **Step 2: Run** `node --test tests/host.test.mjs`. Expected: FAIL with 404 on `/api/explore/search`.
- [ ] **Step 3: Implement the routes** in `server/host.mjs`, as described in Interfaces.
- [ ] **Step 4: Run** `node --test tests/host.test.mjs`. Expected: PASS.
- [ ] **Step 5: Run** `npm.cmd test`. Expected: all PASS.

### Task 3: Client conversions

**Files:**
- Create: `src/explore.ts`
- Modify: `src/model.ts`
  - Add `recordSearchText(e: EventItem): string` (title, place, description, conflict name, classification, countries,
    actor names, tags).
  - Use it in `src/components/WorldView.tsx` in place of the local `recordText`.
- Test: `tests/explore-client.test.mjs` (uses `tests/fixtures/explore/topic-Q1317.json`, produced by calling
  `topic('Q1317')` in Task 1's fake and saved)

**Interfaces:**
- Consumes: the `Topic` and news shapes from Task 1 (declared as TS types in `src/explore.ts`: `Candidate`, `Topic`,
  `TopicEvent`, `TopicLink`, `NewsArticle`, `NewsResult`).
- Produces:
  - `categoryFor(topic: Topic): string`
  - `topicToRecord(topic: Topic, accessed: string): EventItem`
  - `eventToRecord(ev: TopicEvent, topic: Topic, accessed: string): EventItem`
  - `topicToNode(topic: Topic, id: string, x: number, y: number): Node`
  - `newsToLinks(articles: NewsArticle[]): TopicLink[]`
  - `saveLinks(board: Board, topicLabel: string, links: TopicLink[]): { board: Board; added: number }`. Uses the folder
    `Explore: <label>`, creating it if missing; items are `{ id, name, kind: 'link', url, body: note, nodeIds: [],
    recordIds: [], createdAt }`; URLs already present are skipped.
  - `findDuplicate(board: Board, qid: string): EventItem | undefined`, matching `provenance.originalId`.
  - `workspaceMatches(projects: Project[], query: string): WorkspaceMatch[]`, capped at 50, where
    `WorkspaceMatch = { kind: 'record' | 'node' | 'item'; projectId; boardId; id; label; where }`.

- [ ] **Step 1: Write the failing tests:**
  - `a topic becomes an unverified, sourced record`: `topicToRecord(Q1317, '2026-10-16')` has:
    - `name` `'Osama bin Laden'`, `category` `'Actor'`, `date` `'1957-03-10'`, `endDate` `'2011-05-02'`;
    - `longitude` undefined;
    - `evidence.map(e => e.license)` equal to `['CC BY-SA 4.0', 'CC0 / Public domain']`;
    - `evidence[0].url` `'https://en.wikipedia.org/wiki/Osama_bin_Laden'`;
    - `verification` `'Unverified'`, `provenance.originalId` `'Q1317'`;
    - `recordIssues(record).filter(i => i.level === 'error')` empty.
  - `an event becomes a mapped record`: `eventToRecord(killing, Q1317, …)` has `category` `'Event'`, `date` `'2011-05-02'`,
    `longitude` ≈ 73.24, `latitude` ≈ 34.17, `tags` including `'Osama bin Laden'`, and Wikidata evidence `CC0 / Public domain`.
  - `categories follow the spec's rules`: human gives `Actor`; types `['terrorist organization']` give `Armed organization`;
    `['military unit']` gives `State force`; `['war']` gives `Conflict`; `['sovereign state']` gives `Country`;
    `['missile']` gives `Equipment`; no types with an event date gives `Event`; no types and no date gives `Actor`.
  - `duplicates are detected per board`: after adding `topicToRecord` to board A, `findDuplicate(A, 'Q1317')` is defined and
    `findDuplicate(B, 'Q1317')` undefined. `saveLinks(A, label, refs)` adds `refs.length`; a second call adds 0; there is
    one folder named `'Explore: Osama bin Laden'`.
  - `workspace matches cover records, nodes and folder items in every project`: a node labelled `'osama binladen'` in
    project P2 is found by `'Osama bin Laden'`, with `kind: 'node'` and `projectId: 'P2'`.
  - `a topic becomes a graph node`: `topicToNode` gives `data.kind` `'Actor'`, `data.wikidata` `'Q1317'` and `data.url` the
    Wikipedia URL.
- [ ] **Step 2: Run** `node --test tests/explore-client.test.mjs`. Expected: FAIL, missing `src/explore.ts`.
- [ ] **Step 3: Implement `src/explore.ts`.**
  - **Evidence:**
    - The Wikipedia source: title is the article title, publisher `Wikipedia`, sourceType `Other`, claim
      `Summary as accessed on <date>`, `supports` `['title', 'date', 'location']` filtered to the fields that are set.
    - The Wikidata source: title `Wikidata <Q-id>`, publisher `Wikidata`, sourceType `Dataset`, `supports` the same fields.
  - **Description:** the extract, then `\n\nWikidata: <description>`. For life spans, prefix `Life span (birth–death). `.
- [ ] **Step 4: Run** `node --test tests/explore-client.test.mjs`. Expected: PASS.
- [ ] **Step 5: Run** `npm.cmd test` (add the file to the `test` script). Expected: all PASS.

### Task 4: Explore page

**Files:**
- Create: `src/components/ExploreView.tsx`
- Modify: `src/api.ts` (add `searchTopics(q)`, `getTopic(qid)`, `getNews(q, before?)`; a non-200 response throws an `Error`
  with the host's `error`)
- Modify: `src/ctx.ts` (add `'Explore'` to `View`)
- Modify: `src/main.tsx`
  - Add the `['Explore', Compass]` menu entry between World and Folders.
  - Render `<ExploreView ctx={ctx} openMatch={openMatch} />`.
  - `openMatch(m)` sets the project and board, then the view (`record` → World, `node` → Graph, `item` → Folders).
- Modify: `src/components.css` (explore layout, which must fit at phone width)
- Modify: `src/components/SettingsView.tsx`: add Wikipedia (CC BY-SA 4.0), Wikidata (CC0) and GDELT (free, cite GDELT; one
  request per 5 s) to `SERVICES`.

**Interfaces:**
- Consumes: Task 1 routes (through `src/api.ts`) and Task 3 functions.
- Produces: `ExploreView({ ctx, openMatch }: { ctx: Ctx; openMatch: (m: WorkspaceMatch) => void })`.

- [ ] **Step 1: Build the page** following spec §3:
  - Search box and candidate list; a Q-id opens directly.
  - Topic header with a "Save to board" select over `ctx.project.boards`.
  - Summary with attribution, the facts table (first 12 rows, then "Show all N properties"), and events with Save buttons.
  - A mini `InteractiveMap` over `eventToRecord` results that have coordinates, with no-op callbacks and `pickMode=false`.
  - Link tabs with counts, a filter (`matchesQuery`), "Save to folder" per link and "Save all".
  - The news section loads after the topic: Retry when `busy`, and "Load older" passes the oldest article's date as
    `before`.
  - "In your workspace" from `workspaceMatches`.
  - Save buttons call `ctx.patchBoard(fn, boardId)` then `ctx.notify(…)`. Use "On this board" when `findDuplicate` finds
    the Q-id. All buttons are disabled in read-only preview.
- [ ] **Step 2: Type-check.** Run `node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.
- [ ] **Step 3: Build.** Run `npm.cmd run build`. Expected: `built in`, no errors.
- [ ] **Step 4: Manual check in the browser pane**, on a copy of `data/` served by a second host on port 4190:
  - Search `osama binladen` and pick Q1317. The page shows the summary, facts, events with pins and links
    (references > 500).
  - Save the topic, the event "killing of Osama bin Laden" and all database links. Each appears on the board, on the World
    map and in Folders.
  - Saving again shows "On this board".
  - The news section shows articles or the busy message.
  - Check at 375 px width: no horizontal page scroll.

### Task 5: Docs and version

**Files:**
- Modify: `README.md`
  - Section 4: a new "Explore (global search)" subsection.
  - Section 5: add the services rows (Wikipedia, Wikidata, GDELT) and their terms.
  - Section 6: Explore limits, from spec §6.
  - Section 7: file table rows and a "Changes in 0.4.0" block.
  - Sample output: `Atlas 0.4.0`.
  - The opening line "Atlas contains no built-in event data" stays true; add that Explore looks things up live on request.
- Modify: `package.json` (`"version": "0.4.0"`, and the test script includes `tests/explore.test.mjs` and
  `tests/explore-client.test.mjs`)

- [ ] **Step 1: Edit the docs and version** as listed.
- [ ] **Step 2: Run** `npm.cmd test` and `npm.cmd run build`. Expected: all PASS and `built in`.
