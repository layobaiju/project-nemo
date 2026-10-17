// Place search for the maps: cities, towns, villages and landmarks from OpenStreetMap (Nominatim, through the host).
// One search per press of Enter or Search: Nominatim's usage policy does not allow search-as-you-type.
import { useState } from 'react';
import { Loader2, MapPin, Search, X } from 'lucide-react';
import { AccessRequired, searchPlaces } from '../api.ts';
import type { Place } from '../geo.ts';

type State = { status: 'idle' | 'loading' | 'done' | 'error'; places: Place[]; message: string; attribution: string; asked: string };
const IDLE: State = { status: 'idle', places: [], message: '', attribution: '', asked: '' };

export default function PlaceSearch({ onPick, onClose, autoFocus, className = '' }: { onPick: (p: Place) => void; onClose?: () => void; autoFocus?: boolean; className?: string }) {
  const [q, setQ] = useState('');
  const [s, setS] = useState<State>(IDLE);
  const run = async () => {
    const query = q.trim();
    if (query.length < 2) { setS({ ...IDLE, status: 'error', message: 'Type at least 2 characters, then press Search.' }); return; }
    setS(x => ({ ...x, status: 'loading', message: '' }));
    try {
      const r = await searchPlaces(query);
      setS({ status: 'done', places: r.places, message: '', attribution: r.attribution, asked: query });
    } catch (e) {
      setS({ ...IDLE, status: 'error', message: e instanceof AccessRequired ? 'This device needs the access code again. Reload the page.' : (e as Error).message });
    }
  };
  const close = () => { setS(IDLE); setQ(''); onClose?.(); };
  return <div className={`place-search ${className}`}>
    <form role="search" onSubmit={e => { e.preventDefault(); run(); }}>
      <Search size={13} />
      <input aria-label="Find a place" placeholder="Find a city, town, village…" maxLength={200} value={q} autoFocus={autoFocus} onChange={e => setQ(e.target.value)} />
      <button className="button primary small" disabled={s.status === 'loading'} aria-label="Search for this place">{s.status === 'loading' ? <Loader2 size={12} className="spin" /> : 'Search'}</button>
      {(s.status !== 'idle' || q || onClose) && <button type="button" className="place-close" aria-label="Close place search" onClick={close}><X size={12} /></button>}
    </form>
    {(s.status === 'done' || s.status === 'error') && <div className="place-results" role="listbox" aria-label="Places found">
      {s.status === 'error' && <p className="place-msg">{s.message}</p>}
      {s.status === 'done' && !s.places.length && <p className="place-msg">No places found for “{s.asked}”. Try another spelling, or add the region or country.</p>}
      {s.places.map(p => <button key={p.id} role="option" aria-selected={false} onClick={() => { onPick(p); setS(x => ({ ...x, status: 'idle' })); }}>
        <MapPin size={12} /><span><b>{p.name}</b><small>{p.type}{p.region ? ` · ${p.region}` : ''}</small></span>
      </button>)}
      {s.status === 'done' && <small className="place-attrib">{s.attribution}</small>}
    </div>}
  </div>;
}
