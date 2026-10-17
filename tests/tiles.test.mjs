// Satellite imagery tile addresses (the host proxies them). Run with: npm.cmd test
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAT_ATTRIBUTION, satTileUrl } from '../server/tiles.mjs';

test('tile addresses are validated before anything is fetched', () => {
  assert.equal(satTileUrl('esri', 17, 93202, 52284), 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/52284/93202');
  assert.equal(satTileUrl('eox', 15, 23300, 13071), 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/15/13071/23300.jpg');
  assert.equal(satTileUrl('esri', '3', '4', '2'), 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/4', 'route parameters arrive as strings');
  for (const [p, z, x, y] of [['eox', 16, 0, 0], ['esri', 20, 0, 0], ['esri', 2, 4, 0], ['esri', 2, 0, -1], ['esri', 2, 1.5, 0], ['esri', '2x', 0, 0], ['nope', 1, 0, 0], ['esri', -1, 0, 0]]) {
    assert.equal(satTileUrl(p, z, x, y), null, `${p} ${z}/${x}/${y}`);
  }
  assert.match(SAT_ATTRIBUTION.esri, /Esri/);
  assert.match(SAT_ATTRIBUTION.eox, /Sentinel-2 cloudless/);
});
