import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, Compass, ExternalLink, FolderPlus, Globe2, Loader2, MapPin, Network, Newspaper, Plus, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import type { Ctx } from '../ctx.ts';
import { AccessRequired, getEvents, getNews, getTopic, searchTopics } from '../api.ts';
import { eventToRecord, findDuplicate, newsToLinks, saveLinks, topicToNode, topicToRecord, workspaceMatches, type Candidate, type NewsArticle, type Topic, type TopicEvent, type TopicLink, type WorkspaceMatch } from '../explore.ts';
import { formatDateRange, matchesQuery, today, uid } from '../model.ts';
import InteractiveMap, { type BasemapMode } from '../InteractiveMap.tsx';
import { usePersisted } from '../usePersisted.ts';
import WatchButton from './WatchButton.tsx';

type LinkTab = 'references' | 'databases' | 'languages' | 'news';
type NewsState = { status: 'idle' | 'loading' | 'done' | 'busy' | 'error'; articles: NewsArticle[]; message: string; more: boolean };
const NEWS_PAGE = 75, FACTS_SHOWN = 12, LINKS_SHOWN = 200;
const errorText = (e: unknown) => (e instanceof AccessRequired ? 'This device needs the access code again. Reload the page.' : (e as Error)?.message || 'The Windows host did not answer.');
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;

/** Global search: Wikipedia, Wikidata and GDELT, looked up live by the Windows host. Nothing is saved until the user chooses. */
export default function ExploreView({ ctx, openMatch, request }: { ctx: Ctx; openMatch: (m: WorkspaceMatch) => void; request?: { q: string; n: number } | null }) {
  // Remembered per device, so leaving Explore (to check the map, say) and coming back reopens the same topic.
  const [last, setLast] = usePersisted<{ query: string; topicId: string }>('atlas.explore', { query: '', topicId: '' });
  const [query, setQuery] = useState(last.query);
  const [searched, setSearched] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [boardId, setBoardId] = useState(ctx.board.id);
  const [allFacts, setAllFacts] = useState(false);
  const [tab, setTab] = useState<LinkTab>('references');
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(LINKS_SHOWN);
  const [news, setNews] = useState<NewsState>({ status: 'idle', articles: [], message: '', more: false });
  const [focus, setFocus] = useState<{ lng: number; lat: number; n: number }>();
  const [basemap] = usePersisted<BasemapMode>('atlas.basemap', 'online');
  const newsFor = useRef('');
  const target = ctx.project.boards.find(b => b.id === boardId) || ctx.board;

  const runSearch = async (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    if (/^Q\d{1,12}$/i.test(q)) return openTopic(q.toUpperCase());
    setBusy('search'); setError(''); setTopic(null); setSearched(q); setLast({ query: q, topicId: '' });
    try { setCandidates(await searchTopics(q)); } catch (e) { setCandidates(null); setError(errorText(e)); } finally { setBusy(''); }
  };
  const openTopic = async (qid: string) => {
    setBusy(qid); setError('');
    try {
      const t = await getTopic(qid);
      setTopic(t); setLast(l => ({ ...l, topicId: qid })); setAllFacts(false); setTab('references'); setFilter(''); setLimit(LINKS_SHOWN); setFocus(undefined);
      window.scrollTo?.(0, 0);
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const loadNews = async (q: string, before?: string) => {
    newsFor.current = q;
    setNews(n => ({ ...n, status: 'loading', message: '', articles: before ? n.articles : [] }));
    try {
      const r = await getNews(q, before);
      if (newsFor.current !== q) return;
      if (r.busy) setNews(n => ({ ...n, status: 'busy', message: `GDELT is limiting requests. Try again in ${r.retryAfter || 30} seconds.` }));
      else if (r.error) setNews(n => ({ ...n, status: 'error', message: r.error || '' }));
      else setNews(n => {
        const seen = new Set(n.articles.map(a => a.url));
        return { status: 'done', message: '', more: r.articles.length >= NEWS_PAGE, articles: before ? [...n.articles, ...r.articles.filter(a => !seen.has(a.url))] : r.articles };
      });
    } catch (e) { if (newsFor.current === q) setNews(n => ({ ...n, status: 'error', message: errorText(e) })); }
  };
  // Related events come separately: for a big topic (a country) Wikidata can take a while, and the page should not wait.
  const [events, setEvents] = useState<{ status: 'loading' | 'done' | 'error'; list: TopicEvent[]; message: string }>({ status: 'loading', list: [], message: '' });
  const eventsFor = useRef('');
  const loadEvents = async (qid: string) => {
    eventsFor.current = qid;
    setEvents({ status: 'loading', list: [], message: '' });
    try { const list = await getEvents(qid); if (eventsFor.current === qid) setEvents({ status: 'done', list, message: '' }); }
    catch (e) { if (eventsFor.current === qid) setEvents({ status: 'error', list: [], message: errorText(e) }); }
  };
  useEffect(() => { if (topic) { loadNews(topic.label); loadEvents(topic.id); } }, [topic?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // A search handed over from another view (World search + Enter) wins over the remembered topic.
  useEffect(() => { if (request?.q) { setQuery(request.q); runSearch(request.q); } else if (last.topicId) openTopic(last.topicId); else if (last.query) runSearch(last.query); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- derived ----------
  const accessed = today();
  const eventRecords = useMemo(() => (topic ? events.list.filter(e => e.coord).map(e => ({ ...eventToRecord(e, topic, accessed), id: e.id })) : []), [topic, events.list, accessed]);
  const matches = useMemo(() => workspaceMatches(ctx.projects, topic?.label || searched), [ctx.projects, topic?.label, searched]);
  const tabLinks: Record<LinkTab, TopicLink[]> = {
    references: topic?.links.references || [], databases: topic?.links.databases || [], languages: topic?.links.languages || [], news: newsToLinks(news.articles),
  };
  const shownLinks = tabLinks[tab].filter(l => matchesQuery(`${l.label} ${l.note} ${l.url}`, filter));
  const folder = topic ? target.folders.find(f => f.name === `Explore: ${topic.label}`) : undefined;
  const savedUrls = new Set(folder?.items.map(i => i.url) || []);
  const topicRecord = topic ? findDuplicate(target, topic.id) : undefined;
  const topicNode = topic ? target.nodes.some(n => (n.data as Record<string, unknown>)?.wikidata === topic.id) : false;

  // ---------- saving (through patchBoard, so per-board saving and conflicts apply) ----------
  const saveTopicRecord = () => {
    if (!topic || topicRecord) return;
    ctx.patchBoard(b => ({ ...b, events: [...b.events, topicToRecord(topic, accessed)] }), target.id);
    ctx.notify(`Saved “${topic.label}” as an unverified record on “${target.name}”.`);
  };
  const saveEvent = (ev: TopicEvent) => {
    if (!topic || findDuplicate(target, ev.id)) return;
    ctx.patchBoard(b => ({ ...b, events: [...b.events, eventToRecord(ev, topic, accessed)] }), target.id);
    ctx.notify(`Saved “${ev.label}” as an unverified record on “${target.name}”.`);
  };
  const saveNode = () => {
    if (!topic || topicNode) return;
    const node = topicToNode(topic, uid(), 120 + Math.random() * 280, 100 + Math.random() * 240);
    ctx.patchBoard(b => ({ ...b, nodes: [...b.nodes, node] }), target.id);
    ctx.notify(`Added “${topic.label}” to the graph of “${target.name}”.`);
  };
  const saveLinkList = (links: TopicLink[]) => {
    if (!topic) return;
    const { added } = saveLinks(target, topic.label, links);
    if (!added) { ctx.notify('Those links are already in the folder.'); return; }
    ctx.patchBoard(b => saveLinks(b, topic.label, links).board, target.id);
    ctx.notify(`Saved ${plural(added, 'link')} to the folder “Explore: ${topic.label}” on “${target.name}”.`);
  };

  const ro = ctx.readOnly;
  return <section className="content explore">
    <div className="view-heading">
      <div><div className="eyebrow">GLOBAL SEARCH · WIKIPEDIA · WIKIDATA · GDELT NEWS</div><h1>Explore</h1>
        <p>Look up people, organisations, places and events in free public sources. Nothing is added to your workspace until you save it.</p></div>
    </div>
    <form className="explore-search" onSubmit={e => { e.preventDefault(); runSearch(query); }}>
      <div className="searchbox"><Search size={14} /><input aria-label="Search public sources" placeholder="Name, place, organisation or event (e.g. osama bin laden)" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <button className="button primary" type="submit" disabled={!!busy || !query.trim()}>{busy === 'search' ? <Loader2 size={14} className="spin" /> : <Compass size={14} />} Search</button>
    </form>
    {error && <div className="explore-warn" role="alert"><TriangleAlert size={14} />{error}</div>}

    {!topic && candidates && <div className="explore-candidates">
      {candidates.length ? candidates.map(c => <button key={c.id} onClick={() => openTopic(c.id)} disabled={!!busy}>
        {busy === c.id ? <Loader2 size={15} className="spin" /> : <Globe2 size={15} />}
        <span><b>{c.label}</b><small>{c.description || 'No description'}</small></span>
        <i>{c.wikipediaTitle ? 'Wikipedia article' : 'Wikidata only'} · {c.id}</i>
      </button>) : <p className="explore-note">Wikipedia and Wikidata have nothing for “{searched}”. Try another spelling or a fuller name.</p>}
    </div>}

    {topic && <>
      <div className="panel explore-head">
        <div>
          <button className="text-button" onClick={() => { setTopic(null); setLast(l => ({ ...l, topicId: '' })); if (!candidates && query.trim()) runSearch(query); }}>← Back to results</button>
          <h2>{topic.label}</h2>
          <p>{topic.description}{topic.aliases.length ? ` · also known as ${topic.aliases.slice(0, 4).join(', ')}` : ''}</p>
          <p className="explore-note">
            {topic.wikipedia && <a href={topic.wikipedia.url} target="_blank" rel="noreferrer noopener">Wikipedia article <ExternalLink size={10} /></a>}{' '}
            <a href={`https://www.wikidata.org/wiki/${topic.id}`} target="_blank" rel="noreferrer noopener">Wikidata {topic.id} <ExternalLink size={10} /></a>
          </p>
        </div>
        <div className="explore-save">
          <label className="explore-note" htmlFor="explore-board">Save to</label>
          <select id="explore-board" value={target.id} onChange={e => setBoardId(e.target.value)}>{ctx.project.boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <button className="button primary" disabled={ro || !!topicRecord} onClick={saveTopicRecord}>{topicRecord ? <><Check size={13} /> On this board</> : <><Plus size={13} /> Save as record</>}</button>
          <button className="button subtle" disabled={ro || topicNode} onClick={saveNode}>{topicNode ? <><Check size={13} /> In the graph</> : <><Network size={13} /> Add to graph</>}</button>
          <WatchButton ctx={ctx} watch={{ kind: 'entity', label: topic.label, qid: topic.id }} />
        </div>
      </div>
      {Object.keys(topic.errors).length > 0 && <div className="explore-warn" role="status"><TriangleAlert size={14} />Some parts could not be loaded ({Object.entries(topic.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}).<button className="button subtle" onClick={() => openTopic(topic.id)}><RefreshCw size={12} /> Try again</button></div>}

      <div className="explore-grid">
        <div className="explore-col">
          <section className="panel explore-summary">
            <div className="panel-head"><div><h2>Summary</h2><p>{topic.wikipedia ? 'From the English Wikipedia article' : 'No English Wikipedia article'}</p></div><BookOpen size={15} /></div>
            {topic.wikipedia ? <><p>{topic.wikipedia.extract}</p><small className="explore-attrib">Text: Wikipedia, CC BY-SA 4.0 · <a href={topic.wikipedia.url} target="_blank" rel="noreferrer noopener">read the full article</a></small></>
              : <p>The facts and links below come from Wikidata.</p>}
          </section>
          <section className="panel">
            <div className="panel-head"><div><h2>Key facts</h2><p>{plural(topic.facts.length, 'property', 'properties')} from Wikidata · click a linked value to explore it</p></div></div>
            <table className="fact-table"><tbody>{(allFacts ? topic.facts : topic.facts.slice(0, FACTS_SHOWN)).map(f => <tr key={f.property}><th>{f.label}</th><td>{f.values.map((v, i) => <span key={i}>{i > 0 && ', '}{v.id ? <button className="text-button" onClick={() => openTopic(v.id!)}>{v.text}</button> : v.text}{v.coord && <MapPin size={10} className="fact-pin" />}</span>)}</td></tr>)}</tbody></table>
            {topic.facts.length > FACTS_SHOWN && <button className="text-button" onClick={() => setAllFacts(x => !x)}>{allFacts ? 'Show fewer' : `Show all ${topic.facts.length} properties`}</button>}
          </section>
        </div>
        <div className="explore-col">
          <section className="panel explore-events">
            <div className="panel-head"><div><h2>Related events</h2><p>{events.status === 'loading' ? 'Looking up related events in Wikidata…'
              : events.status === 'error' ? 'Could not load related events'
              : events.list.length ? `${plural(events.list.length, 'dated item')}, ${eventRecords.length} with a map position` : 'Wikidata lists no dated events for this topic'}</p></div>
              {events.status === 'loading' && <Loader2 size={15} className="spin" />}</div>
            {events.status === 'error' && <div className="explore-news-state explore-note"><TriangleAlert size={13} /> {events.message} <button className="button subtle small" onClick={() => loadEvents(topic.id)}><RefreshCw size={12} /> Try again</button></div>}
            {eventRecords.length > 0 && <div className="explore-map"><div className="map-host">
              <InteractiveMap events={eventRecords} similarIds={[]} focus={focus} showCountries showCasualties={false} basemap={basemap} pickMode={false}
                onSelect={() => {}} onOpen={id => document.getElementById(`explore-ev-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
                onAddAt={(lng, lat) => ctx.newRecord({ longitude: lng, latitude: lat, locationPrecision: 'Unknown' })} onPick={() => {}} onStatus={() => {}} />
            </div></div>}
            {events.list.map(ev => {
              const saved = !!findDuplicate(target, ev.id);
              return <div className="event-row" id={`explore-ev-${ev.id}`} key={ev.id}>
                <i style={{ background: ev.coord ? '#e7b76e' : '#56647a' }} />
                <span><b>{ev.label}</b><small>{formatDateRange({ date: ev.date, endDate: ev.endDate })}{ev.place ? ` · ${ev.place}` : ''}{ev.coord ? ' · on map' : ''}</small></span>
                {ev.coord && <button className="icon-action" aria-label={`Show ${ev.label} on the map`} onClick={() => setFocus({ lng: ev.coord![0], lat: ev.coord![1], n: Date.now() })}><MapPin size={13} /></button>}
                <button className="icon-action" aria-label={`Explore ${ev.label}`} onClick={() => openTopic(ev.id)}><Compass size={13} /></button>
                <button className="button subtle small" disabled={ro || saved} onClick={() => saveEvent(ev)}>{saved ? 'On this board' : 'Save'}</button>
              </div>;
            })}
          </section>
          <section className="panel">
            <div className="panel-head"><div><h2>In your workspace</h2><p>{matches.length ? `${plural(matches.length, 'match', 'matches')} for “${topic.label}”` : `Nothing in your workspace matches “${topic.label}” yet`}</p></div></div>
            {matches.map(m => <button className="event-row" key={`${m.kind}-${m.id}`} onClick={() => openMatch(m)}><i /><span><b>{m.label}</b><small>{m.where}</small></span></button>)}
          </section>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><div><h2>All links</h2><p>Every source the article cites, database and official pages, other languages and news</p></div></div>
        <div className="explore-tabs" role="tablist">
          {([['references', 'Wikipedia sources'], ['databases', 'Databases & official'], ['languages', 'Other languages'], ['news', 'News (GDELT)']] as [LinkTab, string][]).map(([k, label]) =>
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setLimit(LINKS_SHOWN); }}>{label} ({k === 'news' && news.status === 'loading' ? '…' : tabLinks[k].length.toLocaleString()})</button>)}
        </div>
        <div className="explore-link-tools">
          <div className="searchbox"><Search size={13} /><input aria-label="Filter links" placeholder="Filter these links" value={filter} onChange={e => setFilter(e.target.value)} /></div>
          <button className="button subtle" disabled={ro || !shownLinks.length} onClick={() => saveLinkList(shownLinks)}><FolderPlus size={13} /> Save {shownLinks.length === tabLinks[tab].length ? 'all' : `these ${shownLinks.length.toLocaleString()}`} to a folder</button>
        </div>
        {tab === 'news' && news.status !== 'done' && <div className="explore-note explore-news-state">
          {news.status === 'loading' ? <><Loader2 size={13} className="spin" /> Asking GDELT for news (one request every 5 seconds)…</>
            : news.status === 'idle' ? null
            : <><Newspaper size={13} /> {news.message} <button className="button subtle small" onClick={() => topic && loadNews(topic.label)}><RefreshCw size={12} /> Retry</button></>}
        </div>}
        <div className="explore-links">
          {shownLinks.slice(0, limit).map(l => <div className="explore-link" key={l.url}>
            <span><a href={l.url} target="_blank" rel="noreferrer noopener">{l.label}</a><small>{l.note ? `${l.note} · ` : ''}{l.url}</small></span>
            <button className="button subtle small" disabled={ro || savedUrls.has(l.url)} onClick={() => saveLinkList([l])}>{savedUrls.has(l.url) ? 'Saved' : 'Save'}</button>
          </div>)}
          {!shownLinks.length && !(tab === 'news' && news.status !== 'done') && <p className="explore-note">{tabLinks[tab].length ? 'No links match the filter.' : 'This source has no links here.'}</p>}
        </div>
        {shownLinks.length > limit && <button className="text-button" onClick={() => setLimit(n => n + LINKS_SHOWN * 2)}>Show more ({(shownLinks.length - limit).toLocaleString()} remaining)</button>}
        {tab === 'news' && news.status === 'done' && news.more && <button className="text-button" onClick={() => { const oldest = news.articles[news.articles.length - 1]?.date; if (topic && oldest) loadNews(topic.label, `${oldest.replace(/-/g, '')}000000`); }}>Load older news</button>}
      </section>
      <p className="explore-note">{topic.attribution} Looked up {new Date(topic.fetchedAt).toLocaleString()}. Wikipedia and Wikidata are edited by volunteers and can be wrong or incomplete, so saved items start as “Unverified”: check important facts in the cited sources.</p>
    </>}
  </section>;
}
