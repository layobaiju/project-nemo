// Copies the MapLibre worker that matches the installed maplibre-gl version into public/assets,
// so the build always serves it locally from the Windows host (no CDN, no version drift).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-worker.mjs');
const dest = path.join(root, 'public', 'assets', 'maplibre-gl-worker.mjs');
await fs.mkdir(path.dirname(dest), { recursive: true });
const [a, b] = await Promise.all([fs.readFile(src), fs.readFile(dest).catch(() => null)]);
if (b && a.equals(b)) console.log('MapLibre worker already up to date.');
else { await fs.writeFile(dest, a); console.log('Copied MapLibre worker to public/assets/maplibre-gl-worker.mjs'); }
