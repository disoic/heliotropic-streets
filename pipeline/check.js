#!/usr/bin/env node
'use strict';
/* Opens the site in a real browser and runs the app's self-test before publishing.
   Publishing is blocked if the app doesn't start, the map doesn't appear, the page reports an error, or any
   calculation check fails. Checks that depend on outside services (the time-zone script, the elevation tiles)
   are reported as warnings: an outage elsewhere shouldn't stop an update.
   Usage: node pipeline/check.js <site folder>   (the app itself is taken from app/index.html) */
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

function serve(site) {
  return new Promise(res => {
    const srv = http.createServer((req, out) => {
      let p = decodeURIComponent(req.url.split(/[?#]/)[0]);
      p = (p === '/' || p === '/index.html') ? path.join(ROOT, 'app', 'index.html') : path.join(site, p);
      if (!p.startsWith(site) && !p.startsWith(ROOT)) { out.writeHead(403); return out.end(); }
      fs.readFile(p, (err, buf) => {
        if (err) { out.writeHead(404); return out.end(); }
        out.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); out.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function attempt(browser, base, setupPage) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (setupPage) await setupPage(page);
  // Zurich HB: inside the preloaded area once the streets have been built
  await page.goto(base + 'index.html?test#d=2026-05-28&ll=47.37790,8.54030&z=15', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__selftest || (document.getElementById('problem') && !document.getElementById('problem').hidden),
    null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({
    tests: window.__selftest || [], ready: !!window.__hsReady, map: !!document.querySelector('.maplibregl-canvas'),
    problem: document.getElementById('problem').hidden ? '' : document.getElementById('problem').textContent,
    covered: !!document.getElementById('covNote').textContent, runs: window.App ? App.runs.length : 0,
    upcoming: document.querySelectorAll('#upcoming .up').length
  }));
  await page.close();
  const problems = [], warnings = [];
  if (!st.ready) problems.push("the app didn't start");
  if (!st.map) problems.push("the map didn't appear");
  if (st.problem) problems.push('the app reported: ' + st.problem);
  if (errors.length) problems.push('script error: ' + errors.slice(0, 2).join(' | '));
  if (!st.tests.length) problems.push("the self-test didn't finish");
  for (const t of st.tests) if (!t.pass) (t.net ? warnings : problems).push(`${t.name} (${t.detail})`);
  if (st.covered && !st.runs) problems.push('no streets loaded from the preloaded squares');
  if (!st.covered) warnings.push('no preloaded streets found yet (they appear after the first build)');
  return { st, problems, warnings };
}

async function run({ setupPage, site = path.resolve(process.argv[2] || 'out') } = {}) {
  const { chromium } = require('playwright');
  const srv = await serve(site), base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  let r;
  try {
    r = await attempt(browser, base, setupPage);
    if (r.problems.length) { console.log('First attempt failed, trying once more:', r.problems.join('; ')); r = await attempt(browser, base, setupPage); }
  } finally { await browser.close(); srv.close(); }
  const lines = ['## Checks before publishing', '', '| | Check | Result |', '|---|---|---|'];
  for (const t of r.st.tests) lines.push(`| ${t.pass ? '✅' : t.net ? '⚠️' : '❌'} | ${t.name} | ${String(t.detail).replace(/\|/g, '/')} |`);
  lines.push('', `Streets loaded: ${r.st.runs}. Coming-up entries: ${r.st.upcoming}.`);
  if (r.warnings.length) lines.push('', '**Warnings** (not blocking): ' + r.warnings.join('; '));
  lines.push('', r.problems.length ? '**Not published:** ' + r.problems.join('; ') : '**All required checks passed.**');
  const text = lines.join('\n') + '\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
  return r;
}

module.exports = run;
if (require.main === module) run().then(r => process.exit(r.problems.length ? 1 : 0)).catch(e => { console.error(e); process.exit(1); });
