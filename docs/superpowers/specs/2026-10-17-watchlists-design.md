# Watchlists and alerts: design

Date: 2026-10-17 · Status: design approved in chat, part by part; this written spec awaits review · Atlas 0.7.0 → 0.8.0

## Goal

Follow people, groups, places, events and topics. The Windows host checks news (GDELT) and Wikidata on a schedule.
Atlas shows what is new since you last looked: a badge in the menu and a Watchlist page.

## Decisions made with the user

- **What can be watched:**
  - **Entity watch:** an Investigate entity or an Explore topic. It gets news, plus Wikidata changes when it has a
    Wikidata ID.
  - **Keyword watch:** a phrase. It gets news only.
- **Schedule:** every 6 hours by default; hourly, daily or manual-only can be chosen. **Check now** is always there.
- **Seen state:** shared across devices. An alert read on one device is read everywhere.
- **Approach:** a watch service on the host with its own file, `data/watch.json`. Alerts never touch projects or boards,
  so they cause no saves and no sync conflicts.
- **Out of scope:**
  - email, phone or push notifications;
  - social media;
  - alert rules or filters beyond English-only;
  - automatically adding records;
  - watching private individuals.

## Watches

- **Shape:**

  ```
  { id, kind: 'entity' | 'keyword', label, query, qid?, projectId?, entityKey?,
    englishOnly: boolean, paused: boolean, createdAt,
    lastCheckedAt?, lastError?, seenUrls: string[], snapshot?: Snapshot }
  ```

- **Fields:**
  - `query` is the news phrase. It defaults to the label and can be edited (1–200 characters).
  - `label` is 1–200 characters. `qid` matches `^Q\d{1,12}$`.
- **Limits:**
  - at most 100 watches;
  - a second watch with the same `qid`, or the same normalised `query` with no `qid`, is refused (409, "already
    watched").
- **Workspace-wide:** watches don't belong to a project. `projectId` and `entityKey` only remember where a watch came
  from, so it can open Investigate there.

## What counts as new

- **News:**
  - Each check calls `explore.news(query, undefined, { fresh: true })`.
  - With `englishOnly`, articles whose `language` isn't English are dropped.
  - Articles whose URL is not in `seenUrls` become news alerts, at most 50 per check, newest first.
  - All returned URLs are then added to `seenUrls`, keeping the newest 1,000.
  - On the first successful check, all articles go into `seenUrls` and no alerts are made.
  - Changing the phrase or English-only clears `seenUrls` and starts a new baseline, so the edit doesn't flood the
    feed.
  - **Partial answers:** a Wikidata answer that came back only in part (`topic.errors` not empty) isn't compared.
    Labels missing from it would look like changes.
- **Wikidata (entity watches with a `qid`):**
  - Each check calls `explore.topic(qid, { fresh: true })` and builds a snapshot:

    ```
    Snapshot = { label, description, aliases: string[], facts: { [property]: { label, values: string[] } } }
    ```

    Values are the fact texts, sorted.
  - It is compared with the stored snapshot. Each difference becomes one alert:
    - label changed;
    - description changed;
    - aliases added or removed;
    - per property: values added or removed, e.g. *date of death added: 2011-05-02*, or *member of: removed X, added Y*.
  - **Ignored properties** change constantly and are not news:
    - P8687, social media followers;
    - P3744, number of subscribers;
    - P373, Commons category;
    - P18, image.
  - The first successful check stores the snapshot and makes no alerts.
  - **Missing item:** if the item no longer exists (404), one alert says so and Wikidata checks stop for that watch.
    The watch stays, with `lastError`.
  - **Redirected item:** if Wikidata returns a different ID, one alert says *merged into Q…*, and the watch's `qid` is
    updated.
- **Alert shape:**

  ```
  { id, watchId, at, kind: 'news' | 'wikidata',
    news?: { title, url, domain, date, language },
    change?: { property?, label, added: string[], removed: string[], text },
    seen: boolean }
  ```

- **Storage:** the newest 500 alerts are kept. When there are more, the oldest seen alerts go first, then the oldest
  unseen.

## Failures

- **No partial updates:** a source that fails (network error, timeout, GDELT busy, Wikidata 5xx) leaves that watch's
  `seenUrls` and `snapshot` unchanged. `lastError` says what happened (e.g. *GDELT is limiting requests; will retry next
  round*). A later success clears it.
- **GDELT busy:** the rest of the round skips news (not Wikidata) rather than queueing behind the back-off.
- **Paused watches** are skipped.

## Host

- **`server/watch.mjs`:**
  - **Pure functions:**
    - `snapshotOf(topic)`;
    - `diffSnapshots(prev, next)` returns the changes;
    - `pickNewArticles(seenUrls, articles, { englishOnly, max })` returns `{ fresh, seenUrls }`;
    - `normalizeWatchFile(raw)`.
  - **Service:** `createWatch({ dataDir, explore, now, setTimer, log })` returns:
    - `list()`, `summary()`;
    - `add(input)`, `update(id, patch)`, `remove(id)`;
    - `check(id?)`, `markSeen({ ids?, watchId?, all? })`;
    - `setSettings({ intervalHours })`, `status()`;
    - `start()`, `stop()`.
- **File:** `data/watch.json` = `{ format: 'atlas-watch', version: 1, settings: { intervalHours: 6, lastRoundAt? }, watches,
  alerts }`.
  - Written with `writeAtomic` from `store.mjs` after every change and after each watch in a round.
  - A missing file starts empty. A corrupt file is renamed to `watch.json.corrupt-<stamp>` and the service starts empty.
- **Schedule:**
  - `intervalHours` is 1, 6, 24 or 0 (manual only).
  - A one-minute timer starts a round when `now - lastRoundAt >= interval`.
  - On `start()`, an overdue round begins after 30 s.
  - One round at a time, one watch at a time. A **Check now** during a round is ignored and reported as *already
    checking*.
- **Explore changes:** `topic(qid, { fresh })` and `news(q, before, { fresh })` skip the cache read when `fresh` is set.
  They still write the cache. News stays in the same single GDELT queue (one request ≥ 5.5 s apart), so a user's own
  Explore search waits at most one turn.
- **API**, behind the existing access-code, private-network and host/origin checks:

  | Method and path | Body | Answer |
  |---|---|---|
  | `GET /api/watch` | — | `{ settings, status, watches (without seenUrls/snapshot, with unseen counts), alerts (newest first) }` |
  | `GET /api/watch/summary` | — | `{ unseen, running }` |
  | `POST /api/watch` | `{ kind, label, query?, qid?, projectId?, entityKey?, englishOnly? }` | 201 with the watch; 400 invalid; 409 duplicate or limit |
  | `PUT /api/watch/:id` | `{ label?, query?, englishOnly?, paused? }` | 200; 404 |
  | `DELETE /api/watch/:id` | — | 200 (removes its alerts); 404 |
  | `POST /api/watch/check` | `{ id? }` | 202 `{ started }` or 200 `{ started: false, reason: 'already checking' }` |
  | `POST /api/watch/seen` | `{ ids? } \| { watchId } \| { all: true }` | 200 `{ unseen }` |
  | `PUT /api/watch/settings` | `{ intervalHours }` | 200; 400 unless 0, 1, 6 or 24 |

- **Export:** `/api/export` gains `watch: { settings, watches }`, without alerts, seen URLs or snapshots.
- **Version:** 0.8.0.

## Client

- **`src/watch.ts`:** API calls and types, plus `findWatch(watches, { qid?, query? })` for the Watch buttons.
- **`src/components/WatchlistView.tsx`**, lazy-loaded:
  - **Top:**
    - **Check now**;
    - **Add keyword watch** (a phrase, English-only);
    - the schedule select: *Every hour / Every 6 hours / Every day / Only when I press Check now*;
    - a status line: *Next check at 18:00*, *Checking 3 of 12…*, or *Last checked 2 h ago*.
  - **Left: watch list.**
    - Each watch shows a kind icon, its label, its new count, its last check and an error marker.
    - **Edit** changes the label, phrase, English-only and Pause. **Remove** asks first.
    - **All watches** is at the top.
  - **Main: alert feed.**
    - Shows the selected watch, or all, newest first, grouped by day, with new alerts marked.
    - Opening a watch marks its alerts seen. **Mark all seen** clears all of them.
    - **News alert:** the title opens the article in a new tab, with its site, date and language.
      - **Save to board** adds the link to the folder *Watch: \<label\>* on the current board, through `newsToLinks` and
        `saveLinks` (`src/explore.ts`).
      - **Explore** opens the topic (`ctx.searchWorld`).
    - **Wikidata alert:** the change text and an *unverified* tag, with a link to
      `https://www.wikidata.org/w/index.php?title=<QID>&action=history`.
  - **iPad and phone:** the watch list stacks above the feed.
- **Menu:** **Watchlist** after Investigate.
  - The badge shows `summary().unseen`. The shell polls it every 60 s and after any watch action.
  - It is hidden at 0 and capped as *99+*.
- **Watch buttons** on the Investigate profile and the Explore topic page.
  - They add an entity watch: label = name, qid, projectId, entityKey.
  - Once watched, the button reads **Watching** and opens the Watchlist.
- **Read-only previews** see the list but can't add, edit, check or mark.

## Testing

- **`tests/watch.test.mjs`**, with a fake Explore and a fake clock:
  - `snapshotOf` and `diffSnapshots`:
    - added, removed and changed values;
    - label, description and alias changes;
    - ignored properties;
    - value order doesn't matter.
  - `pickNewArticles`:
    - the first-check baseline;
    - English-only;
    - the cap of 50 per check and of 1,000 seen URLs.
  - **Service:**
    - add, the duplicate check and the limit of 100;
    - a full round producing news and Wikidata alerts;
    - GDELT busy and Wikidata failing leave the state unchanged and set `lastError`;
    - a missing and a redirected item;
    - paused watches skipped;
    - the 500-alert cap, oldest seen first;
    - `markSeen` by ids, by watch and all;
    - an overdue round on `start()`;
    - a reload from `watch.json`;
    - a corrupt file set aside.
- **`tests/host.test.mjs`:**
  - the routes and status codes;
  - LAN without an access code gets 401;
  - validation errors.
- **Browser check** on copied data, on the test host at port 4191:
  - with `ATLAS_EXPLORE_FAKE`: the Watch buttons, the badge, the feed, Save to board, Edit, Remove and Mark all seen;
  - one real check against live GDELT and Wikidata;
  - phone width.
- **Full run:** `npm.cmd test` and `npm.cmd run build`.

## Limits (README)

- **When checks run:** only while the Windows host is running. An overdue check starts shortly after the host starts.
- **News coverage:** GDELT covers news from 2017 and matches by phrase. Common names catch unrelated people; sharpen the
  phrase in **Edit**.
- **News alerts are leads, not verified facts.** The articles belong to their publishers; Atlas keeps titles and links
  only.
- **Wikidata changes** can be mistakes or vandalism, so those alerts are marked unverified. Check the item's history.
- **Notifications:** none by email or phone; alerts appear inside Atlas only.
- **Size:** at most 100 watches. A round with many watches takes several minutes, because GDELT allows one request
  every 5 seconds.
