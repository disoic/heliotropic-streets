#!/usr/bin/env node
'use strict';
/* Builds the preloaded squares for Heliotropic Streets.
   For every country: the streets become straight stretches, the hills are measured in both directions of each
   stretch, stretches that can never frame the low sun are left out, and each map square (Web Mercator zoom 13,
   about 3.3 km) gets one small JSON file. A coverage list tells the app which squares are preloaded.
   Usage: node pipeline/build.js <folder with CODE.geojsonseq files> <output folder> */
const fs = require('fs'), path = require('path'), readline = require('readline');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const WORK = process.argv[2] || 'work', OUT = process.argv[3] || 'out';
const COUNTRIES = JSON.parse(fs.readFileSync(process.env.COUNTRIES_FILE || path.join(__dirname, 'countries.json'), 'utf8'));
const TILE_Z = 13, MIN_LEN = 50;
const DEM_URL = process.env.DEM_URL_TEMPLATE || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_DIR = path.join(ROOT, '.dem-cache'), DEM_KEEP = 1500;
const t0 = Date.now(), log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s]`, ...a);

// The app's own core, read from the app file, so the build and the app can never measure differently.
const html = fs.readFileSync(path.join(ROOT, 'app', 'index.html'), 'utf8');
const core = /<script id="hs-core">([\s\S]*?)<\/script>/.exec(html);
if (!core) throw new Error('app/index.html has no <script id="hs-core"> block');
const mod = { exports: {} }; new Function('module', core[1])(mod);
const HS = mod.exports;

/* ---------- map squares (same formulas as the app) ---------- */
const N2 = Math.pow(2, TILE_Z);
const lon2x = lon => (lon + 180) / 360 * N2;
const lat2y = lat => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N2; };
const squareOf = (lon, lat) => [((Math.floor(lon2x(lon)) % N2) + N2) % N2, Math.floor(lat2y(lat))];
const tileBBox = (x, y) => ({
  w: x / N2 * 360 - 180, e: (x + 1) / N2 * 360 - 180,
  n: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N2))) * 180 / Math.PI, s: Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / N2))) * 180 / Math.PI
});

/* ---------- elevation tiles: disk cache, download, decode ---------- */
const demMem = new Map(), demMissing = new Set(), TERR = HS.makeTerrain(k => demMem.get(k));
const stats = { demDownloaded: 0, demFromCache: 0, demMissing: 0 };
async function download(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url);
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      if (r.status === 403 || r.status === 404) return null;           // no tile there (open sea)
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 1000 * (a + 1)));
  }
  throw new Error('could not download ' + url);
}
function decode(buf) {
  const png = PNG.sync.read(buf), d = png.data, el = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) el[i] = HS.terrarium(d[4 * i], d[4 * i + 1], d[4 * i + 2]);
  return el;
}
async function loadDem(key) {
  if (demMem.has(key) || demMissing.has(key)) return;
  const name = TERR.keyName(key), file = path.join(DEM_DIR, name + '.png');
  let buf = null;
  if (fs.existsSync(file)) { buf = fs.readFileSync(file); stats.demFromCache++; }
  else {
    const [z, x, y] = name.split('/');
    buf = await download(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    if (!buf) { demMissing.add(key); stats.demMissing++; return; }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); stats.demDownloaded++;
  }
  try { demMem.set(key, decode(buf)); } catch (e) { demMissing.add(key); stats.demMissing++; return; }
  while (demMem.size > DEM_KEEP) demMem.delete(demMem.keys().next().value);
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
const ensure = keys => pool([...keys].filter(k => !demMem.has(k) && !demMissing.has(k)), 16, loadDem);

/* ---------- streets ---------- */
async function readCountry(code) {
  const ways = [], cover = new Set();
  let features = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(WORK, `${code}.geojsonseq`)), crlfDelay: Infinity });
  for await (let line of rl) {
    if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
    if (!line.trim()) continue;
    const f = JSON.parse(line), g = f.geometry;
    if (!g || g.type !== 'LineString' || !g.coordinates || g.coordinates.length < 2) continue;
    features++;
    const co = g.coordinates, tg = f.properties || {};
    for (const p of co) { const s = squareOf(p[0], p[1]); cover.add(s[0] * 100000 + s[1]); }   // every street counts for coverage
    if (!HS.keepWay(tg)) continue;
    const c = new Int32Array(co.length * 2);
    for (let i = 0; i < co.length; i++) { c[2 * i] = Math.round(co[i][0] * 1e7); c[2 * i + 1] = Math.round(co[i][1] * 1e7); }
    ways.push({ id: ways.length + 1, hw: tg.highway, name: tg.name || tg.ref || '', ids: null, c, group: HS.classify(tg.highway) });
  }
  return { ways, cover, features };
}

/* ---------- hills for every stretch, in batches of nearby stretches ---------- */
async function measure(runs) {
  runs.sort((a, b) => (Math.floor(a.lat * 40) - Math.floor(b.lat * 40)) || (a.lon - b.lon));
  let i = 0, done = 0, next = 100000;
  while (i < runs.length) {
    const need = new Set(), chunk = [];
    while (i < runs.length && need.size < 400) {
      const r = runs[i++]; chunk.push(r);
      for (const k of [0, 1]) { const o = HS.obsOf(r, k); need.add(TERR.tileKeyAt(o.lat, o.lon, 12)); TERR.rayTiles(o.lat, o.lon, o.look, need); }
    }
    await ensure(need);
    for (const r of chunk) {
      const a = HS.obsOf(r, 0), b = HS.obsOf(r, 1), ha = TERR.horizonAt(a.lat, a.lon, a.look), hb = TERR.horizonAt(b.lat, b.lon, b.look);
      if (ha && hb) { r.tsky = [ha.ang, hb.ang]; r.tdist = [ha.dist, hb.dist]; } else r.tsky = null;
    }
    done += chunk.length;
    if (done >= next) { log(`  hills measured for ${done.toLocaleString('en')} of ${runs.length.toLocaleString('en')} stretches`); next += 100000; }
  }
}
// Left out: stretches whose two directions can never meet the low sun under any setting the app offers
// (skyline -1° to 8°, low-sun limit up to 10° above the skyline, or the measured hills).
function canEverAlign(r) {
  for (const k of [0, 1]) {
    const s = r.tsky ? r.tsky[k] : 0;
    if (HS.canAlign(r, k, HS.app2true(Math.min(s, -1) - HS.SD), HS.app2true(Math.max(s, 8) + 10))) return true;
  }
  return false;
}
/* ---------- output ---------- */
const HW_ROAD = HS.HW_LIST.indexOf('road');
function writeSquare(sq) {
  const bb = tileBBox(sq.x, sq.y), names = [], nameIx = new Map(), rows = [];
  sq.runs.sort((a, b) => a.lon1 - b.lon1 || a.lat1 - b.lat1 || a.lon2 - b.lon2 || a.lat2 - b.lat2);
  for (const r of sq.runs) {
    let ni = -1;
    if (r.name) { ni = nameIx.get(r.name); if (ni === undefined) { ni = names.length; names.push(r.name); nameIx.set(r.name, ni); } }
    let hi = HS.HW_LIST.indexOf(r.hw); if (hi < 0) hi = HW_ROAD;
    const row = [Math.round((r.lon1 - bb.w) * 1e6), Math.round((bb.n - r.lat1) * 1e6), Math.round((r.lon2 - bb.w) * 1e6), Math.round((bb.n - r.lat2) * 1e6), hi, ni];
    if (r.tsky) row.push(Math.round(r.tsky[0] * 100), Math.round(r.tsky[1] * 100), Math.round(r.tdist[0] / 10), Math.round(r.tdist[1] / 10));
    rows.push(row);
  }
  const dir = path.join(OUT, 'data', 'v1', 's', String(sq.x));
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ v: 1, x: sq.x, y: sq.y, n: names, r: rows });
  fs.writeFileSync(path.join(dir, `${sq.y}.json`), body);
  return body.length;
}

(async () => {
  const squares = new Map(), cover = new Set(), seen = new Set(), report = { countries: [] };
  for (const c of COUNTRIES) {
    log(`${c.name}: reading streets`);
    const { ways, cover: cov, features } = await readCountry(c.code);
    for (const k of cov) cover.add(k);
    log(`${c.name}: ${features.toLocaleString('en')} street lines, ${ways.length.toLocaleString('en')} kept (no paths, tracks, footways, tunnels)`);
    HS.resetRunCache();
    const runs = HS.buildRuns(ways, { minKeep: MIN_LEN });
    ways.length = 0; HS.resetRunCache();
    log(`${c.name}: ${runs.length.toLocaleString('en')} straight stretches of ${MIN_LEN} m or more; measuring hills`);
    await measure(runs);
    let kept = 0, never = 0, noHills = 0;
    for (const r of runs) {
      if (!canEverAlign(r)) { never++; continue; }
      if (!r.tsky) noHills++;
      const id = `${Math.round(r.lon1 * 1e6)},${Math.round(r.lat1 * 1e6)},${Math.round(r.lon2 * 1e6)},${Math.round(r.lat2 * 1e6)}`;
      if (seen.has(id)) continue;                      // the same street from a neighbouring country's download
      seen.add(id);
      const [x, y] = squareOf(r.lon, r.lat), key = x * 100000 + y;
      let sq = squares.get(key); if (!sq) squares.set(key, sq = { x, y, runs: [] });
      sq.runs.push(r); kept++;
    }
    report.countries.push({ code: c.code, name: c.name, streetLines: features, stretches: runs.length, kept, neverAligned: never, withoutHills: noHills });
    log(`${c.name}: ${kept.toLocaleString('en')} stretches kept, ${never.toLocaleString('en')} left out because they can never frame the low sun`);
  }
  log('writing squares');
  fs.rmSync(path.join(OUT, 'data'), { recursive: true, force: true });
  let bytes = 0;
  for (const sq of squares.values()) bytes += writeSquare(sq);
  const t = {};
  for (const k of [...cover].sort((a, b) => a - b)) {
    const x = Math.floor(k / 100000), y = k % 100000, sq = squares.get(k);
    t[`${x}/${y}`] = sq ? sq.runs.length : 0;
  }
  const built = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, 'data', 'v1', 'coverage.json'), JSON.stringify({ v: 1, z: TILE_Z, built, countries: COUNTRIES.map(c => c.code), t }));
  Object.assign(report, { built, squaresCovered: cover.size, squaresWithStreets: squares.size, megabytes: +(bytes / 1e6).toFixed(1), ...stats, minutes: +((Date.now() - t0) / 60000).toFixed(1) });
  fs.writeFileSync(path.join(OUT, 'data', 'v1', 'report.json'), JSON.stringify(report, null, 1));
  log(`done: ${squares.size.toLocaleString('en')} square files, ${report.megabytes} MB before compression; elevation tiles ${stats.demDownloaded} downloaded, ${stats.demFromCache} from cache`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Preloaded streets', '', '| Country | Street lines | Straight stretches | Kept | Never frame the low sun |', '|---|---:|---:|---:|---:|'];
    for (const c of report.countries) lines.push(`| ${c.name} | ${c.streetLines.toLocaleString('en')} | ${c.stretches.toLocaleString('en')} | ${c.kept.toLocaleString('en')} | ${c.neverAligned.toLocaleString('en')} |`);
    lines.push('', `${report.squaresWithStreets.toLocaleString('en')} square files, ${report.megabytes} MB before compression. Elevation tiles: ${stats.demDownloaded} downloaded, ${stats.demFromCache} from the cache. Build time ${report.minutes} min.`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
})().catch(e => { console.error(e); process.exit(1); });
