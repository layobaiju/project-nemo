# Explore: global search — design

Date: 2026-10-16 · Status: approved in chat, awaiting review of this written spec · Atlas 0.3.0 → 0.4.0

## 1. Goal

The user typed "osama binladen" into Atlas and expected "every piece of information and every link" about him, "like a global
data". Atlas only searched what the user had entered. This feature adds an **Explore** page. It searches free public sources
live, shows everything those sources hold about a topic, and lets the user save chosen pieces into a board with their source
attached.

**Success:** searching "osama binladen" shows the following on one page. Nothing enters the workspace until the user saves it.

- The Wikipedia summary.
- Key facts: born 1957-03-10 in Riyadh, died 2011-05-02 in Abbottabad, member of al-Qaeda, and similar.
- Dated related events, with map pins where a position exists. Example: the killing of Osama bin Laden, 2011-05-02, Abbottabad.
- Every link: Wikipedia's 500+ source links, about 160 database links and the articles in about 177 languages.
- News articles from GDELT, when GDELT answers.
- Matches from the user's own workspace.

**Agreed in chat:**
- Sources: Wikipedia + Wikidata, GDELT news, and the user's own workspace.
- A separate Explore page, not the World search box.
- Nothing is saved automatically.
- Saved items carry source, licence and access date, and start as "Unverified".

**Constraints kept from Atlas:**
- No paid service, account or API key.
- The Windows host makes every outside request, as it does for the basemap.
- LAN access-code and private-network rules apply.
- Atlas still bundles no event data.

## 2. Sources (checked from this PC on 2026-10-16)

| Source | What Atlas uses | Licence / terms | Checked |
|---|---|---|---|
| Wikidata API (`wbsearchentities`, `wbgetentities`) | Candidate matches; facts; labels; coordinates (P625); external IDs with formatter URLs (P1630); sitelinks | CC0. Wikimedia API etiquette: descriptive User-Agent, modest request rate | Q1317 has 213 properties, 162 external IDs and 177 sitelinks |
| Wikidata Query Service (SPARQL) | Items that reference the topic and carry a date (P585, P580) and an optional position (P625, or P276 → P625) | CC0 | 6 dated items for Q1317; 2 have positions |
| Wikipedia REST `page/summary` + Action API `prop=extlinks` | Summary, thumbnail, article URL; every external link in the article (500 per page, follows `elcontinue`, capped at 5,000) | Text is CC BY-SA 4.0: show attribution and a link to the article | 500+ links for "Osama_bin_Laden" |
| GDELT DOC 2.0 (`mode=artlist`) | News articles: title, URL, domain, date, language, source country. Articles since 2017-01-01 | Free, no key; cite the GDELT Project. One request per 5 seconds | **Returned HTTP 429 on all 3 attempts today, even 20 s apart.** Treated as best-effort (see §6) |
| The user's workspace | Records, graph nodes and folder items in every project and board, using the existing `matchesQuery` | Local | — |

Not used: ACLED (needs an account) and the UCDP API (needs a token). Scraping websites is also out.

## 3. User experience

**Sidebar:** a new **Explore** item sits between World and Folders.

**Search step:** type a name or topic. Atlas lists up to 10 Wikidata matches, each with a label, a description and its
English Wikipedia title. Example: "Osama bin Laden – founder of al-Qaeda (1957–2011)" and "Osama bin Laden – rogue bull elephant
in India". Picking one opens its topic page. A query that already looks like a Q-id (`Q1317`) opens it directly.

**Topic page:** sections, in order. Each section loads on its own, so one failing source never blanks the page.

1. **Header:** label, description, thumbnail, links to the Wikipedia article and the Wikidata item. A "Save to board" picker lists
   the current project's boards and defaults to the current board.
2. **Summary:** the Wikipedia extract, with "Text: Wikipedia, CC BY-SA 4.0" attribution and a link.
3. **Key facts:** a table of the Wikidata statements that read well as facts:
   - **Fields:** instance of, born / died (dates and places), citizenship, member of, occupation, position held, religion,
     significant events, location, start / end / point in time, founded by, participants.
   - **Values:** Wikidata labels, never raw Q-ids.
   - **Other properties:** "Show all N properties" expands the rest.
4. **Related events:**
   - **What's listed:** dated items, from the topic's own "significant event" (P793) plus the SPARQL query.
   - **Each row:** date, label, place, a "map position" badge and a Save button.
   - **Map:** events with positions appear on a small read-only map. It reuses `InteractiveMap` with temporary `EventItem`s.
5. **All links**, in three tabs with a filter box and counts:
   - **Wikipedia sources:** every external link in the article.
   - **Databases & official sites:** each external ID turned into a URL with the property's formatter URL, labelled with the
     property name (for example "FBI Most Wanted ID"). Official website (P856) comes first.
   - **Other languages:** the sitelinks.
   - Each link has "Save to folder". The tab has "Save all to a folder".
6. **News (GDELT):** loads after the rest. Shows up to 75 articles, newest first: title, outlet, date and language.
   - **Pages:** "Load older" pages back by date.
   - **When GDELT is busy:** the section says "GDELT is limiting requests; try again in a minute" and has a Retry button.
7. **In your workspace:** matching records, graph nodes and folder items from every project. Each one opens in place, switching
   project, board and view.

**Saving:** every action targets the board in the picker.

- **Save topic as record.** A record with:
  - **Title and description:** title = label; description = Wikipedia extract + Wikidata description.
  - **Category:** the first matching rule wins.
    1. `Actor` if instance of (P31) includes human (Q5).
    2. Otherwise, from the English labels of the P31 values:
       - `Armed organization`: armed, militant, terrorist, paramilitary, rebel, guerrilla or insurgent
       - `State force`: military unit, armed forces, army, navy, air force or police
       - `Conflict`: war, conflict, battle or insurgency
       - `Country`: country or sovereign state
       - `Equipment`: weapon, aircraft, vehicle, missile or firearm
    3. Otherwise `Event` if the item has a date (P585 or P580), else `Actor`.
  - **Dates:** P585 or P580 / P582. For people, birth and death (P569 / P570), noted in the description as a life span.
  - **Coordinates:** only from the item's own P625 or its location's (P276) P625. People get none: a birthplace is not where
    a person "is". The user can still use Pick on globe.
  - **Evidence:** two sources.
    - The Wikipedia article: publisher Wikipedia, licence CC BY-SA 4.0, claim "Summary as accessed on <date>",
      supports title / date / location where set.
    - The Wikidata item: publisher Wikidata, type Dataset, licence CC0.
  - **Status:** verification `Unverified`, confidence `Unverified`.
  - **Provenance:** origin `Explore (Wikidata/Wikipedia)`, dataset `Wikidata`, licence CC0, `originalId` = Q-id.
- **Save event as record.** The same rules, applied to the event's own Q-id.
- **Duplicates:** if the target board already has a record with that `provenance.originalId`, the button reads "On this board"
  and opens it.
- **Save as graph node:** label, kind (Actor, Organisation or Event), detail = description, plus `data.wikidata` and `data.url`.
- **Save link(s) to folder:**
  - **Where:** folder items of kind `link` (name, URL, note with source and section), in a folder named "Explore: <label>".
  - **Folder:** created if missing, reused after that.
  - **Duplicates:** a URL already in that folder is skipped.
- **News articles:** saved the same way as links, with the outlet and date in the note.

## 4. Architecture

**Host: `server/explore.mjs`, a new file.** It is pure apart from an injected `fetchJson`, so it can be tested without network.

- `searchTopics(q)` returns `[{ id, label, description, wikipediaTitle }]`.
- `getTopic(qid)` returns `{ id, label, description, aliases, types, wikipedia: { title, url, extract, thumbnail }, facts: [{ property, label, values: [{ text, id?, date?, coord? }] }], events: [{ id, label, date, endDate, coord?, place? }], links: { references: [{ url }], databases: [{ property, label, url }], languages: [{ lang, title, url }] }, attribution }`.
- `getNews(q, { before })` returns `{ articles: [{ title, url, domain, date, language, country }], busy?: true }`.
- **Cache:** in memory, with a TTL (topics and search 24 h, news 6 h) and a 50 MB cap. It is not written to `data/`.
- **Outbound requests:** a fixed allowlist of upstream hosts, so the host is never an open proxy. User-Agent
  `Atlas-Workspace/0.4 (self-hosted research tool)`. A 15 s timeout per request.
- **GDELT queue:** one request at a time, at least 5.5 s apart. After a 429 it backs off: 30 s, then 60 s, then 120 s. While
  backing off it returns `busy: true` immediately instead of waiting.
- **Errors:** each part of a topic fails on its own and is reported in `errors: { section: message }`.

**Host: routes in `server/host.mjs`.** These sit behind the existing private-network, host-name and access-code checks.

- `GET /api/explore/search?q=` validates the query (1–200 characters).
- `GET /api/explore/topic/:qid` requires `^Q\d{1,12}$`.
- `GET /api/explore/news?q=&before=` requires `before` to be `YYYYMMDDhhmmss`.

**Client:**
- `src/explore.ts` is pure and testable:
  - `topicToRecord(topic, accessed)`, `eventToRecord(event, topic, accessed)`
  - `topicToNode(topic)`, `linksToFolderItems(links, section)`
  - `findDuplicate(board, qid)`, `workspaceMatches(projects, query)`
- `src/api.ts` gets `searchTopics`, `getTopic` and `getNews`.
- `src/components/ExploreView.tsx` is the page. `View` in `src/ctx.ts` gains `'Explore'`. `src/main.tsx` adds the sidebar
  item and an `openInWorkspace` helper for workspace matches.
- **Saving:** goes through the existing `ctx.patchBoard` and `ctx.setProjects`. Per-board saving, conflicts and backups apply
  unchanged.

## 5. Testing

- **`tests/explore.test.mjs`, host side:**
  - Parsing, against small hand-made fixtures that mirror the real response shapes: search candidates; facts with resolved
    labels; dates with precision (year-only stays `YYYY`); positions from P625 or P276; formatter-URL substitution;
    `extlinks` continuation and the cap; SPARQL rows to events.
  - GDELT queue spacing and back-off, using an injected clock.
  - Input validation for the three routes.
- **`tests/explore.test.mjs`, client side:**
  - Topic and event to record: evidence, licence, `Unverified`, the coordinate rules, and the duplicate check by Q-id.
  - Link to folder items with duplicates skipped.
  - Workspace matches across projects.
- **End to end:** an extension of `tests/host.test.mjs`, with an injected fake upstream. `ATLAS_EXPLORE_FAKE=1` loads fixtures,
  so tests never touch the network. It checks that the routes answer and that a non-local request without the access code
  gets 401.
- **Manual check:** in the browser on a copy of the data, search "osama binladen", pick Q1317, save the topic, one event and
  the links, then confirm they appear on the board, the map and in Folders.

## 6. Limits to state honestly (README section 6 and on the page)

- No source has "everything". Wikipedia and Wikidata are community-edited and can be wrong or incomplete, which is why saved
  items start as `Unverified`.
- GDELT covers news from 2017 onward, allows one request per 5 seconds, and was refusing requests (429) when this was designed.
  The news section may often say "busy".
- Explore needs internet on the Windows PC. Results are cached in memory and are lost when the host restarts.
- Only English labels and the English Wikipedia summary in this version. Other languages appear as links.

## 7. Out of scope

- Automatic bulk import of global datasets.
- Background crawling.
- Other news sources or paid APIs.
- Translating articles.
- Following links to fetch their pages.
