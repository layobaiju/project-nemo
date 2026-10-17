// Distances, areas and label positions on a sphere (accurate to about 0.5 %). Coordinates are [longitude, latitude].
export type LngLat = [number, number];
const R = 6371.0088, rad = Math.PI / 180;

function segmentKm(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function lineKm(coords: LngLat[]): number {
  let km = 0;
  for (let i = 1; i < coords.length; i++) km += segmentKm(coords[i - 1], coords[i]);
  return km;
}
/** Area of a ring on the sphere; works whether or not the ring repeats its first point. */
export function polygonKm2(ring: LngLat[]): number {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % pts.length];
    total += (p2[0] - p1[0]) * rad * (2 + Math.sin(p1[1] * rad) + Math.sin(p2[1] * rad));
  }
  return Math.abs(total) * R * R / 2;
}
const thousands = (n: number) => Math.round(n).toLocaleString('en-US');
export const formatDistance = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : km < 100 ? `${km.toFixed(1)} km` : `${thousands(km)} km`);
export const formatArea = (km2: number) => (km2 < 0.1 ? `${thousands(km2 * 1e6)} m²` : km2 < 100 ? `${km2.toFixed(1)} km²` : `${thousands(km2)} km²`);

/** The point halfway along a line, by length. */
export function lineMidpoint(coords: LngLat[]): LngLat {
  if (coords.length < 2) return coords[0];
  let left = lineKm(coords) / 2;
  for (let i = 1; i < coords.length; i++) {
    const seg = segmentKm(coords[i - 1], coords[i]);
    if (left <= seg || i === coords.length - 1) {
      const t = seg ? Math.min(1, left / seg) : 0, [a, b] = [coords[i - 1], coords[i]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    left -= seg;
  }
  return coords[coords.length - 1];
}
/** Average of a ring's corners (good enough to place a caption). */
export function polygonCenter(ring: LngLat[]): LngLat {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  const sum = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
  return [sum[0] / pts.length, sum[1] / pts.length];
}
/** Compass bearing from a to b, 0–360° clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * rad, φ2 = b[1] * rad, Δλ = (b[0] - a[0]) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2), x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** A place from place search (OpenStreetMap Nominatim, through the host). bbox is [west, south, east, north]. */
export type Place = { id: string; name: string; type: string; region: string; lng: number; lat: number; bbox: [number, number, number, number] | null };

/** Bounds to frame a place: its extent, or a small box around a point (about 2 km) when it has none. */
export function placeBounds(p: Pick<Place, 'lng' | 'lat' | 'bbox'>): [LngLat, LngLat] {
  if (p.bbox && p.bbox[2] > p.bbox[0] && p.bbox[3] > p.bbox[1]) return [[p.bbox[0], p.bbox[1]], [p.bbox[2], p.bbox[3]]];
  const d = 0.01;
  return [[p.lng - d, p.lat - d], [p.lng + d, p.lat + d]];
}
