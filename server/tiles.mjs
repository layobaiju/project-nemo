// Satellite imagery for the Map workspace, fetched by the host so Macs and iPads only ever talk to the Windows PC.
// Only these two upstream tile servers are used, and only for tile addresses that exist.

const PROVIDERS = {
  // Detailed imagery; attribution required. Check Esri's terms before any commercial use.
  esri: { maxZoom: 19, url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
  // 10 m Sentinel-2 mosaic, CC BY-NC-SA 4.0. Deeper zoom levels are enlarged in the browser.
  eox: { maxZoom: 15, url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/${z}/${y}/${x}.jpg` },
};
export const SAT_ATTRIBUTION = {
  esri: 'Imagery © Esri, Maxar, Earthstar Geographics',
  eox: 'Sentinel-2 cloudless 2023 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023), CC BY-NC-SA 4.0',
};
export const SAT_MAX_ZOOM = { esri: PROVIDERS.esri.maxZoom, eox: PROVIDERS.eox.maxZoom };

const int = v => (typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : NaN);
/** The upstream URL for a tile, or null when the provider is unknown or the address is out of range. */
export function satTileUrl(provider, z, x, y) {
  const p = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  const [zz, xx, yy] = [int(z), int(x), int(y)];
  if (!p || ![zz, xx, yy].every(Number.isInteger) || zz < 0 || zz > p.maxZoom) return null;
  const n = 2 ** zz;
  if (xx < 0 || yy < 0 || xx >= n || yy >= n) return null;
  return p.url(zz, xx, yy);
}
