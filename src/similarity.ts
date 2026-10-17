import type { EventItem } from './types.ts';
import { dateSpan, hasCoords, haversineKm, normalizeName, normalizeUrl, tokens } from './model.ts';

export type FactorKey = 'category' | 'classification' | 'time' | 'distance' | 'countries' | 'actors' | 'sources' | 'equipment' | 'text';
export const FACTORS: { key: FactorKey; label: string; weight: number }[] = [
  { key: 'time', label: 'Time proximity', weight: 20 },
  { key: 'distance', label: 'Location distance', weight: 20 },
  { key: 'actors', label: 'Overlapping actors (as recorded)', weight: 15 },
  { key: 'category', label: 'Event category', weight: 10 },
  { key: 'classification', label: 'Classification / conflict name', weight: 10 },
  { key: 'countries', label: 'Shared countries / regions', weight: 10 },
  { key: 'sources', label: 'Shared sources', weight: 8 },
  { key: 'equipment', label: 'Shared equipment references', weight: 4 },
  { key: 'text', label: 'Similar wording (title/description)', weight: 3 },
];
export const DEFAULT_FACTORS = FACTORS.map(f => f.key);

export type FactorResult = { key: FactorKey; label: string; weight: number; points: number; compared: boolean; detail: string };
export type Match = { event: EventItem; score: number; coverage: number; factors: FactorResult[]; reasons: string[] };

const DAY = 86_400_000;
const jaccard = (a: Set<string>, b: Set<string>) => {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
};
const shared = (a: Set<string>, b: Set<string>) => [...a].filter(x => b.has(x));
const APPROX = new Set(['Country only', 'Approximate area / linear feature', 'Province (1st-level admin)', 'International waters / airspace']);

/** Days between two (possibly partial / ranged) dates; 0 when the spans overlap. */
export function gapDays(a: EventItem, b: EventItem): number | null {
  const sa = dateSpan(a.date, a.endDate), sb = dateSpan(b.date, b.endDate);
  if (!sa || !sb) return null;
  if (sa[1] >= sb[0] && sb[1] >= sa[0]) return 0;
  // Spans end at 23:59:59.999, so consecutive calendar days give a gap of 1.
  return Math.ceil((Math.max(sa[0], sb[0]) - Math.min(sa[1], sb[1])) / DAY);
}
/** 1 within a day, ~0.72 at 10 days, ~0.28 at a year, 0 beyond ~10 years. */
export const timeSimilarity = (gap: number) => (gap <= 1 ? 1 : Math.max(0, 1 - Math.log10(gap) / Math.log10(3650)));
/** 1 within ~1 km, ~0.7 at 25 km, ~0.49 at 100 km, 0 beyond 2,000 km. */
export const distanceSimilarity = (km: number) => (km <= 1 ? 1 : Math.max(0, 1 - Math.log10(1 + km / 5) / Math.log10(1 + 2000 / 5)));

function factor(key: FactorKey, a: EventItem, b: EventItem): { s: number | null; detail: string } {
  switch (key) {
    case 'category':
      return a.category === b.category ? { s: 1, detail: `both “${a.category}”` } : { s: 0, detail: `${a.category} vs ${b.category}` };
    case 'classification': {
      const ca = a.classification, cb = b.classification, na = normalizeName(a.conflictName), nb = normalizeName(b.conflictName);
      if (!(ca && cb) && !(na && nb)) return { s: null, detail: 'not recorded on both records' };
      if (na && nb && na === nb) return { s: 1, detail: `same conflict name “${a.conflictName}”` };
      if (ca && cb && ca === cb) return { s: 0.7, detail: `both “${ca}”` };
      return { s: 0, detail: 'different classification' };
    }
    case 'time': {
      const g = gapDays(a, b);
      if (g == null) return { s: null, detail: 'one or both undated' };
      return { s: timeSimilarity(g), detail: g === 0 ? 'dates overlap' : `${g.toLocaleString('en-US')} day${g === 1 ? '' : 's'} apart` };
    }
    case 'distance': {
      if (!hasCoords(a) || !hasCoords(b)) return { s: null, detail: 'coordinates missing on one or both' };
      const km = haversineKm([a.longitude, a.latitude], [b.longitude, b.latitude]);
      const approx = APPROX.has(a.locationPrecision) || APPROX.has(b.locationPrecision);
      const s = distanceSimilarity(km);
      return { s: approx ? Math.min(s, 0.5) : s, detail: `${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString('en-US')} km apart${approx ? ' (approximate coordinates; capped)' : ''}` };
    }
    case 'countries': {
      const ca = new Set(a.countries.map(normalizeName)), cb = new Set(b.countries.map(normalizeName));
      if (!ca.size || !cb.size) return { s: null, detail: 'not recorded on both records' };
      const sh = a.countries.filter(c => cb.has(normalizeName(c)));
      return { s: jaccard(ca, cb), detail: sh.length ? `shared: ${sh.join(', ')}` : 'no shared countries' };
    }
    case 'actors': {
      const ma = new Map(a.actors.filter(x => x.name).map(x => [normalizeName(x.name), x]));
      const mb = new Map(b.actors.filter(x => x.name).map(x => [normalizeName(x.name), x]));
      if (!ma.size || !mb.size) return { s: null, detail: 'actors not recorded on both records' };
      const sh = shared(new Set(ma.keys()), new Set(mb.keys()));
      if (!sh.length) return { s: 0, detail: 'no overlapping actor names' };
      const names = sh.map(k => `${ma.get(k)!.name} (${ma.get(k)!.attribution} / ${mb.get(k)!.attribution})`);
      return { s: jaccard(new Set(ma.keys()), new Set(mb.keys())), detail: `same actor name recorded: ${names.join(', ')}` };
    }
    case 'sources': {
      const key = (s: EventItem['evidence'][number]) => (s.url ? normalizeUrl(s.url) : normalizeName(s.title));
      const sa = new Set(a.evidence.map(key).filter(Boolean)), sb = new Set(b.evidence.map(key).filter(Boolean));
      if (!sa.size || !sb.size) return { s: null, detail: 'sources missing on one or both' };
      const sh = shared(sa, sb);
      return sh.length ? { s: 0.5 + 0.5 * jaccard(sa, sb), detail: `${sh.length} shared source${sh.length > 1 ? 's' : ''} (a report may cover several events)` } : { s: 0, detail: 'no shared sources' };
    }
    case 'equipment': {
      const ea = new Set(a.equipment.map(x => normalizeName(x.name)).filter(Boolean)), eb = new Set(b.equipment.map(x => normalizeName(x.name)).filter(Boolean));
      if (!ea.size || !eb.size) return { s: null, detail: 'not recorded on both records' };
      const sh = shared(ea, eb);
      return { s: jaccard(ea, eb), detail: sh.length ? `shared: ${sh.join(', ')}` : 'no shared references' };
    }
    case 'text': {
      const ta = tokens(`${a.name} ${a.description}`), tb = tokens(`${b.name} ${b.description}`);
      if (ta.size < 2 || tb.size < 2) return { s: null, detail: 'too little text to compare' };
      const sh = shared(ta, tb);
      return { s: jaccard(ta, tb), detail: sh.length ? `common words: ${sh.slice(0, 6).join(', ')}` : 'no common words' };
    }
  }
}

/**
 * Conservative, explainable score: missing data never raises similarity.
 * score = sum(weight * similarity) / sum(weight of selected factors) * 100.
 * coverage = share of selected weight that could actually be compared.
 */
export function compareRecords(a: EventItem, b: EventItem, selected: FactorKey[] = DEFAULT_FACTORS): Omit<Match, 'event'> {
  const defs = FACTORS.filter(f => selected.includes(f.key));
  const total = defs.reduce((n, f) => n + f.weight, 0) || 1;
  let earned = 0, comparable = 0;
  const factors = defs.map(f => {
    const { s, detail } = factor(f.key, a, b);
    const points = s == null ? 0 : Math.round(f.weight * s * 10) / 10;
    if (s != null) comparable += f.weight;
    earned += points;
    return { key: f.key, label: f.label, weight: f.weight, points, compared: s != null, detail };
  });
  const reasons = factors.filter(f => f.compared && f.points > 0).sort((x, y) => y.points - x.points).map(f => `${f.label}: ${f.detail} (+${f.points}/${f.weight})`);
  return { score: Math.round((earned / total) * 100), coverage: Math.round((comparable / total) * 100), factors, reasons };
}

export function findSimilar(target: EventItem, pool: EventItem[], selected: FactorKey[], threshold: number, limit = 25): Match[] {
  return pool
    .filter(e => e.id !== target.id)
    .map(e => ({ event: e, ...compareRecords(target, e, selected) }))
    .filter(m => m.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}

export const SIMILARITY_CAVEAT = 'Similarity is a research lead only. It does not show coordination, shared responsibility, causation, or a common actor.';
