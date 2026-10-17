# Watchlists and Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Windows host checks watched entities and keywords against GDELT news and Wikidata on a schedule. Atlas
shows what is new in a Watchlist page and a menu badge.

**Architecture:**
- **Host:** `server/watch.mjs` holds the pure comparison helpers and a service. The service keeps
  `data/watch.json`, runs the schedule and uses the existing Explore client with a new `fresh` option. The host exposes
  it under `/api/watch`.
- **App:** a lazy Watchlist page, a polled badge, and Watch buttons on Investigate and Explore.

**Tech Stack:** Node (host), React 18 + TypeScript (Vite), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-17-watchlists-design.md`

## Global Constraints

- **Tooling:**
  - Tests import TS files with `.ts` extensions and `import type` for types.
  - Run `npm.cmd test` and `npm.cmd run build`; on Windows, use `npm.cmd`.
- **Limits:**
  - up to 100 watches;
  - up to 50 news alerts per watch per check;
  - up to 1,000 seen URLs per watch;
  - 500 alerts kept;
  - `label` and `query` 1–200 characters;
  - `qid` matches `^Q\d{1,12}$`;
  - `intervalHours` is one of 0, 1, 6 or 24, with a default of 6;
  - an overdue round starts 30 s after start-up;
  - the timer ticks every 60 s.
- **Ignored Wikidata properties:** P8687, P3744, P373, P18.
- **Copy:**
  - busy news error: *GDELT is limiting requests; will retry next round*;
  - Wikidata alerts are tagged *unverified*;
  - the history link is `https://www.wikidata.org/w/index.php?title=<QID>&action=history`;
  - saved news goes to the folder *Watch: \<label\>*.
- **Separation:** watches and alerts never touch projects or boards. `/api/export` gains `watch: { settings, watches }`,
  without alerts, `seenUrls` or snapshots.
- **API checks:** all `/api/watch*` routes sit behind the existing private-network, host-header, origin and access-code
  checks.
- **Version:** 0.8.0 in `package.json`, `package-lock.json` (both version lines), `server/host.mjs` and the README sample
  output.
- **No commits** (not a git repository). Test on copied data, with the host on port 4191; never use the user's host on
  4174.

## Review Focus

1. **Partial Wikidata answers** (`topic.errors` not empty) must not produce change alerts. Tested in Task 2 (a service
   round with a partial topic).
2. **Editing the phrase or English-only** resets the news baseline, so no flood of "new" articles. Tested in Task 2.
3. **A round already running when Check now is pressed** must not start a second round or double-count. Tested in
   Task 2 (`check()` during a round answers *already checking*).
4. **A corrupt or hand-edited `watch.json`** must not crash the host. It is set aside and the service starts empty.
   Tested in Task 2.
5. **Removing a watch during a round** must not resurrect it when the round saves. Tested in Task 2 (remove between two
   watches of a round; the file has no trace of it).

---

### Task 1: Pure comparison helpers, and a fresh Explore read

**Files:**
- Create: `server/watch.mjs` (pure exports only in this task)
- Modify: `server/explore.mjs`:
  - `topic(qid, { fresh } = {})` and `news(q, before, { fresh } = {})` skip the cache read when `fresh` is set;
  - `topic` also finds a redirected entity and reports `redirectedTo`.
- Test: `tests/watch.test.mjs` (new; add it to the `test` script before `tests/host.test.mjs`) and
  `tests/explore.test.mjs`

**Interfaces:**
- Produces, in `server/watch.mjs`:

  ```js
  export const IGNORED_PROPERTIES; // Set of 'P8687', 'P3744', 'P373', 'P18'
  export const LIMITS = { watches: 100, newsPerCheck: 50, seenUrls: 1000, alerts: 500, text: 200 };
  export const INTERVALS = [0, 1, 6, 24];
  export function snapshotOf(topic) // → { label, description, aliases: string[] (sorted, unique), facts: { [P]: { label, values: string[] (sorted, unique) } } }
  export function diffSnapshots(prev, next) // → [{ property?, label, added: string[], removed: string[], text }]
  export function pickNewArticles(seenUrls, articles, { englishOnly = false, baseline = false, max = 50, keep = 1000 } = {}) // → { fresh, seenUrls }
  export const normalizeQuery = q => String(q).toLowerCase().replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  export function normalizeWatchFile(raw) // → { format: 'atlas-watch', version: 1, settings: { intervalHours, lastRoundAt? }, watches, alerts }
  ```

- Produces, in `server/explore.mjs`: the topic result gains `redirectedTo?: string` when Wikidata answered with a
  different ID.

- [ ] **Step 1: Write the failing tests** in `tests/watch.test.mjs`

  ```js
  const topic = (over = {}) => ({ id: 'Q1', label: 'Osama bin Laden', description: 'founder of al-Qaeda', aliases: ['Usama bin Laden'], errors: {},
    facts: [{ property: 'P31', label: 'instance of', values: [{ text: 'human' }] }, { property: 'P8687', label: 'social media followers', values: [{ text: '100' }] }], ...over });
  test('snapshots keep facts sorted and drop ignored properties', () => {
    const s = snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'B' }, { text: 'A' }, { text: 'A' }] }] }));
    assert.deepEqual(s.facts, { P463: { label: 'member of', values: ['A', 'B'] } });
    assert.ok(!('P8687' in snapshotOf(topic()).facts));
  });
  test('differences between snapshots', () => {
    const a = snapshotOf(topic()), b = snapshotOf(topic({ description: 'Saudi militant', aliases: ['Usama bin Laden', 'UBL'],
      facts: [{ property: 'P31', label: 'instance of', values: [{ text: 'human' }] }, { property: 'P570', label: 'date of death', values: [{ text: '2011-05-02' }] }] }));
    assert.deepEqual(diffSnapshots(a, b).map(c => c.text), ['Description changed: “founder of al-Qaeda” → “Saudi militant”', 'Also known as added: UBL', 'date of death added: 2011-05-02']);
    assert.deepEqual(diffSnapshots(a, snapshotOf(topic({ facts: [...topic().facts].reverse() }))), [], 'order does not matter');
    const m = diffSnapshots(snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'X' }] }] })), snapshotOf(topic({ facts: [{ property: 'P463', label: 'member of', values: [{ text: 'Y' }] }] })));
    assert.equal(m[0].text, 'member of: removed X; added Y');
    assert.equal(diffSnapshots(a, snapshotOf(topic({ label: 'Usama bin Ladin' })))[0].text, 'Label changed: “Osama bin Laden” → “Usama bin Ladin”');
  });
  test('new articles: baseline, English only and caps', () => {
    const art = (i, language = 'English') => ({ title: `T${i}`, url: `https://n.example/${i}`, domain: 'n.example', date: '2026-10-17', language, country: '' });
    const first = pickNewArticles([], [art(1), art(2)], { baseline: true });
    assert.deepEqual(first.fresh, []); assert.deepEqual(first.seenUrls, ['https://n.example/1', 'https://n.example/2']);
    const next = pickNewArticles(first.seenUrls, [art(3), art(4, 'French'), art(1)], { englishOnly: true });
    assert.deepEqual(next.fresh.map(a => a.title), ['T3']);
    assert.equal(next.seenUrls[0], 'https://n.example/3');
    const many = Array.from({ length: 80 }, (_, i) => art(100 + i));
    assert.equal(pickNewArticles([], many).fresh.length, 50);
    assert.equal(pickNewArticles(Array.from({ length: 1000 }, (_, i) => `https://old/${i}`), [art(9)]).seenUrls.length, 1000);
  });
  test('watch files are normalised', () => {
    assert.deepEqual(normalizeWatchFile('junk'), { format: 'atlas-watch', version: 1, settings: { intervalHours: 6 }, watches: [], alerts: [] });
    assert.equal(normalizeWatchFile({ settings: { intervalHours: 5 } }).settings.intervalHours, 6);
    assert.equal(normalizeWatchFile({ watches: [{ id: 'w', kind: 'keyword', label: 'x', query: 'x' }, { kind: 'nope' }] }).watches.length, 1);
  });
  ```

  In `tests/explore.test.mjs`, follow its existing fake-fetch style:

  ```js
  test('fresh reads skip the cache, and redirected items are reported', async () => {
    // count wbgetentities calls: topic('Q1317') twice → 1 call; topic('Q1317', { fresh: true }) → 2 calls
    // a fetch answering ids=Q5 with { entities: { Q6: { id: 'Q6', redirects: { from: 'Q5', to: 'Q6' }, labels: {...}, claims: {} } } } → topic('Q5').redirectedTo === 'Q6'
    // news('x') twice → 1 GDELT call; news('x', undefined, { fresh: true }) → 2 calls
  });
  ```

- [ ] **Step 2:** Run `node --test tests/watch.test.mjs tests/explore.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - **Change texts:**
    - `Label changed: “a” → “b”` and `Description changed: “a” → “b”`;
    - `Also known as added: …` or `Also known as removed: …`;
    - per property, ordered by label: `<label> added: …`, `<label> removed: …`, or `<label>: removed …; added …`;
    - values are joined with `, `.
  - **Order:** label, then description, then aliases, then properties.
  - **Redirects:** use `data.entities[qid] || Object.values(data.entities).find(e => e?.redirects?.from === qid)`.

- [ ] **Step 4:** Run the same command. Expected: PASS.

### Task 2: The watch service

**Files:**
- Modify: `server/watch.mjs` (`createWatch`)
- Test: `tests/watch.test.mjs`

**Interfaces:**
- Consumes: the Task 1 helpers; `writeAtomic` and `stamp` from `server/store.mjs`; an `explore` with
  `news(q, before, { fresh })` and `topic(qid, { fresh })`.
- Produces:

  ```js
  export function createWatch({ dataDir, explore, now = Date.now, timers = { every: setInterval, after: setTimeout, clear: clearInterval }, log = console.warn, startDelayMs = 30000 })
  // → { init(), list(), summary(), add(input), update(id, patch), remove(id), check(id?), idle(), markSeen(sel), setSettings({ intervalHours }), status(), start(), stop() }
  ```

  - **`init()`** loads `watch.json`. A file that won't parse is renamed `watch.json.corrupt-<stamp>`.
  - **`list()`** returns `{ settings, status, watches, alerts }`. Watches carry `unseen` and leave out `seenUrls`,
    `snapshot` and `newsBaselined`. Alerts are newest first.
  - **`summary()`** returns `{ unseen, running, watched: [{ id, qid?, query, label }] }`.
  - **`add`, `update` and `setSettings`** throw `Error` with `.status` 400, 404 or 409, with messages from the spec.
  - **`check(id?)`** returns `{ started: true }`, or `{ started: false, reason: 'already checking' }`.
  - **`idle()`** resolves when the current round ends.
  - **`markSeen({ ids } | { watchId } | { all: true })`** returns `{ unseen }`.
  - **`status()`** returns `{ running, done, total, current, lastRoundAt, nextRoundAt }`.

- [ ] **Step 1: Write the failing tests.**
  - Use a temp `dataDir` (`mkdtemp`), a clock `let t = Date.parse('2026-10-17T00:00:00Z')`, and fake timers that
    record callbacks.
  - The fake explore `{ news: async q => ({ articles: feed[q] || [] }), topic: async qid => topics[qid] }` can be told to
    answer `{ busy: true }`, to throw (`Object.assign(new Error('x'), { status: 404 })`), or to return
    `{ ...topic, errors: { labels: 'timeout' } }`.

  ```js
  test('adding watches: validation, duplicates and the limit', async () => {
    // add({ kind: 'keyword', label: 'Sudan ceasefire' }) → query defaults to label
    // the same query again → status 409; add({ kind: 'entity', label: 'X', qid: 'Q1' }) twice → 409; qid 'X1' → 400; label '' → 400
    // 100 watches then one more → 409 with 'at most 100 watches'
  });
  test('a round makes a baseline first, then news and Wikidata alerts', async () => {
    // entity watch Q1 + keyword watch; check(); await idle() → no alerts, lastCheckedAt set
    // feed adds an article and topic Q1 gains P570 → check(); await idle()
    // → alerts: one news alert (watchId, news.url) and one wikidata alert (change.text 'date of death added: 2011-05-02'); summary().unseen === 2
  });
  test('failures leave the state alone and are reported', async () => {
    // after a baseline: news answers { busy: true } → watch.lastError === 'GDELT is limiting requests; will retry next round', seenUrls unchanged,
    //   and the next watch in the same round does not call news at all (count calls)
    // topic throws a 502 → snapshot unchanged, lastError mentions Wikidata; topic with errors {labels} → no alerts, snapshot unchanged
    // a later success clears lastError
  });
  test('missing and merged Wikidata items', async () => {
    // topic throws status 404 → one alert 'Wikidata item Q1 no longer exists'; the next round makes no topic call for it
    // topic returns { ...t, redirectedTo: 'Q2' } → alert text 'Wikidata item Q1 was merged into Q2'; the watch's qid becomes 'Q2'
  });
  test('editing the phrase restarts the baseline; paused watches are skipped', async () => { /* update(id, { query: 'new' }) → next round makes no alerts; paused → no news call */ });
  test('check during a round, removal during a round', async () => {
    // a news fake that waits on a promise you release; check() twice → second { started: false, reason: 'already checking' }
    // remove the second watch while the first is pending, release → the file read back has no watch with that id and no alerts for it
  });
  test('alert cap and marking seen', async () => {
    // seed 510 alerts (some seen) through rounds or a pre-written watch.json → list().alerts.length === 500, the dropped ones were the oldest seen
    // markSeen({ watchId }) / ({ ids }) / ({ all: true }) → unseen counts 
  });
  test('schedule: overdue on start, interval and manual-only', async () => {
    // start() with no lastRoundAt → the `after` callback at 30000 ms runs a round
    // after a round, advance the clock 5 h and fire `every` → no round; 6 h → round
    // setSettings({ intervalHours: 0 }) → ticks never start a round; setSettings({ intervalHours: 5 }) → 400
  });
  test('the file survives a restart, and a corrupt file is set aside', async () => {
    // a second createWatch on the same dataDir lists the same watches and alerts
    // write 'not json' to watch.json → init() works, list().watches is empty, a watch.json.corrupt-* file exists
  });
  ```

- [ ] **Step 2:** Run `node --test tests/watch.test.mjs`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - **Shared state:** one in-memory state object. `save()` writes it with `writeAtomic` and runs after every change, and
    after each watch in a round.
  - **A round** takes the list of ids at its start. For each id it re-reads the watch from state (skipping removed or
    paused ones), checks it, then saves.
  - **News then Wikidata,** as in the spec:
    - `newsBlocked` is set for the rest of the round after the first busy answer;
    - a 404 sets `wikidataGone`;
    - a non-empty `topic.errors` is a soft failure (*Wikidata answered only in part; will retry*).
  - **Alerts:** `{ id: crypto.randomUUID(), watchId, at, kind, news | change, seen: false }`. Wikidata change alerts
    also carry `qid`.
  - **Cap:** after a round or a removal, cut to 500. Drop seen alerts oldest first, then unseen oldest first.
  - **`update`:** a changed `query` or `englishOnly` clears `seenUrls` and `newsBaselined`.
  - **`tick()`:** start a round if `intervalHours > 0`, nothing is running, and the round is overdue
    (`now - lastRoundAt >= intervalHours * 3600000`, or `lastRoundAt` is missing).
  - **`start()`:** `timers.every(tick, 60000)` and `timers.after(tick, startDelayMs)`.

- [ ] **Step 4:** Run `node --test tests/watch.test.mjs`. Expected: PASS.

### Task 3: Host API

**Files:**
- Modify: `server/host.mjs`:
  - create the service with `createWatch({ dataDir, explore })`, then call `init()` and `start()` after
    `store.init()`;
  - add the routes;
  - the export gains `watch`;
  - `VERSION` becomes 0.8.0.
- Test: `tests/host.test.mjs`

**Interfaces:**
- Consumes: the Task 2 service.
- Produces: the routes in the spec's API table, with exactly those status codes. The body for `/api/watch/seen` is
  validated as one of the three shapes.

- [ ] **Step 1: Write the failing test** `test('watch routes keep the access checks and validate input', …)`. Start the
  host with `ATLAS_EXPLORE_FAKE`, then:
  - `POST /api/watch` with `{ kind: 'keyword', label: 'Sudan ceasefire' }` → 201;
  - the same again → 409;
  - `{ kind: 'entity', label: 'x', qid: 'nope' }` → 400;
  - `GET /api/watch` → one watch with `unseen: 0`;
  - `PUT /api/watch/settings` with `{ intervalHours: 5 }` → 400, and with `{ intervalHours: 24 }` → 200;
  - `POST /api/watch/check` → 202, then poll `GET /api/watch` until `status.running` is false (up to 15 s) and
    `watches[0].lastCheckedAt` is set;
  - `POST /api/watch/seen` with `{ all: true }` → 200 `{ unseen: 0 }`;
  - `DELETE /api/watch/<id>` → 200, and again → 404;
  - `GET /api/watch` with `x-forwarded-for: 192.168.1.50` → 401;
  - `GET /api/export` → its body has `watch.watches`.
- [ ] **Step 2:** Run `node --test tests/host.test.mjs`. Expected: the new test FAILs.
- [ ] **Step 3:** Implement `watchRequest(req, res, url)`, routed like `exploreRequest`. Errors with `.status` map to
  JSON `{ error }`.
- [ ] **Step 4:** Run `npm.cmd test`. Expected: all tests pass.

### Task 4: Watchlist page, badge and Watch buttons

**Files:**
- Create: `src/watch.ts`:
  - types `Watch`, `Alert`, `WatchList`, `WatchSummary`, `WatchStatus`;
  - `findWatch(watched, { qid?, query? })`;
  - `alertDay(at, now)` returns *Today*, *Yesterday* or a date;
  - `ago(at, now)` returns e.g. *2 h ago*.
- Modify: `src/api.ts`: `getWatchList`, `getWatchSummary`, `addWatch`, `updateWatch`, `removeWatch`, `checkWatches`,
  `markWatchSeen`, `setWatchSettings`. Each throws `Error(data.error)` when the answer isn't 2xx, and `AccessRequired`
  on 401.
- Modify: `src/explore.ts`: `saveLinks(board, topicLabel, links, folderName = \`Explore: ${topicLabel}\`)`.
- Create: `src/components/WatchlistView.tsx`, lazy.
- Modify:
  - `src/ctx.ts`: `View` gains `'Watchlist'`; `Ctx` gains `watch: WatchSummary` and `refreshWatch(): void`.
  - `src/main.tsx`: poll `getWatchSummary` every 60 s and on window focus; a badge on the menu item (hidden at 0,
    capped at *99+*); a lazy route.
  - `src/components/InvestigateView.tsx`: a **Watch**/**Watching** button.
  - `src/components/ExploreView.tsx`: a **Watch**/**Watching** button next to **Add to graph**.
  - `src/components.css`: a block of classes prefixed `wl-`.
- Test: `tests/watch.test.mjs`, which imports `../src/watch.ts`.

**Interfaces:**
- Consumes: the Task 3 API.
- Produces: `findWatch` matches by `qid` when one is given, else by the normalised query; `ago` and `alertDay` take ISO
  strings and a `now` number.

- [ ] **Step 1: Failing test.**

  ```js
  test('client helpers', () => {
    assert.equal(findWatch([{ id: 'a', qid: 'Q1', query: 'x', label: 'x' }], { qid: 'Q1' }).id, 'a');
    assert.equal(findWatch([{ id: 'b', query: 'Sudan  ceasefire', label: 's' }], { query: 'sudan ceasefire' }).id, 'b');
    assert.equal(ago('2026-10-17T10:00:00Z', Date.parse('2026-10-17T12:05:00Z')), '2 h ago');
    assert.equal(alertDay('2026-10-16T09:00:00Z', Date.parse('2026-10-17T12:00:00Z')), 'Yesterday');
  });
  ```

- [ ] **Step 2:** Implement the helpers, then run `node --test tests/watch.test.mjs`. Expected: PASS.
- [ ] **Step 3: Build the page** as described in the spec's *Client* section.
  - **Watch editing:** inline in the left panel, with label, phrase, English-only, Pause and Remove (with a confirm).
  - **Seen state:** opening a watch calls `markWatchSeen({ watchId })` once its alerts have shown.
  - **News Save to board** uses
    `ctx.patchBoard(b => saveLinks(b, w.label, newsToLinks([alert.news]), \`Watch: ${w.label}\`).board)`.
  - **Read-only devices** get disabled controls.
  - **Refresh:** after every action, call `ctx.refreshWatch()`. While `status.running` is true, refetch the list every
    3 s.
- [ ] **Step 4: Watch buttons.**
  - **Investigate:**
    `addWatch({ kind: 'entity', label: entity.name, qid: entity.qids[0], projectId: project.id, entityKey: entity.key })`.
  - **Explore:** `addWatch({ kind: 'entity', label: topic.label, qid: topic.id })`.
  - When `findWatch(ctx.watch.watched, …)` finds a watch, the button reads **Watching** and opens the Watchlist.
- [ ] **Step 5:** Run `npm.cmd run build`. Expected: `✓ built`, with a `WatchlistView-*.js` chunk.

### Task 5: Browser check, README, version

**Files:**
- Modify: `README.md`, `package.json`, `package-lock.json`, `server/host.mjs` (version)
- Scratchpad only (not in the project): a fake that wraps `tests/fixtures/explore/fake-fetch.mjs` and adds one new
  GDELT article per call, so alerts appear in the browser.

- [ ] **Step 1: Test host.** Copy `data/projects.json`, `data/boards` and `data/watch.json` (if present) into
  `<scratchpad>/checkdata`. Start the host on port 4191 with `ATLAS_EXPLORE_FAKE=<scratchpad fake>`.
- [ ] **Step 2: Browser check:**
  - the **Watch** button on Investigate and on Explore;
  - **Check now** twice, which shows alerts;
  - the badge count;
  - opening a watch marks it seen;
  - **Save to board** creates the *Watch: …* folder;
  - **Edit**, **Pause**, **Remove** and the schedule select;
  - 375 px width without sideways scrolling.
  - Then restart the host without the fake for one real **Check now** on a keyword watch, and confirm a baseline with
    no errors.
- [ ] **Step 3: README:**
  - a *Watchlist* subsection in section 4;
  - limits in section 6;
  - a file-table row for `server/watch.mjs`, `src/watch.ts` and `src/components/WatchlistView.tsx`;
  - *Changes in 0.8.0*;
  - the sample output shows 0.8.0.
  - Then bump the version to 0.8.0 everywhere listed in Global Constraints.
- [ ] **Step 4:** Run `npm.cmd test` (all pass) and `npm.cmd run build` (✓ built).
- [ ] **Step 5: Clean up.** Reset the viewport, close the tab, and stop port 4191.
