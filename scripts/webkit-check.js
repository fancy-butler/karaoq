#!/usr/bin/env node
'use strict';
// iPhone stand-in: drives the phone page in WebKit (Safari's engine) with iPhone screen/touch emulation.
// Not a real iPhone — but it catches Safari-only JavaScript/CSS breakage before an iPhone user at a party does.
//   npx playwright install --with-deps webkit && node scripts/webkit-check.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-webkit-'));
const SHOTS = process.env.SHOTS || path.join(ROOT, 'webkit-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };

(async () => {
  const { webkit, devices } = require('playwright');
  fs.mkdirSync(SHOTS, { recursive: true });
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, MOCK: '1', TUNNEL: '0', PORT: String(PORT), DATA_DIR: DATA }, stdio: 'ignore' });
  process.on('exit', () => { try { srv.kill(); } catch { } });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/about')).ok) break; } catch { } await sleep(250); }
  console.log('KARAO-Q on WebKit (iPhone emulation)');
  const browser = await webkit.launch();
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 15'] });
    await ctx.addInitScript(() => { try { if (!localStorage.getItem('kq.name')) localStorage.setItem('kq.name', 'Safari Sam'); } catch { } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    await page.goto(BASE + '/');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, '1-home.png') });
    // search and add (name is preset, as if they joined before)
    await page.fill('#q', 'total eclipse of the heart');
    await page.evaluate(() => document.querySelector('#searchForm').requestSubmit());
    await page.waitForSelector('#results .item', { timeout: 15000 });
    await page.screenshot({ path: path.join(SHOTS, '2-search.png') });
    await page.locator('#results .item button[data-add]').first().tap();
    await page.waitForTimeout(1500);
    const st = await (await fetch(BASE + '/api/about')).ok;
    const queued = await page.evaluate(() => (KQ.state.queue || []).concat(KQ.state.current ? [KQ.state.current] : []).some(i => i.singer === 'Safari Sam'));
    ok(queued, 'iPhone can join, search and add a song');
    // tabs render
    for (const t of ['queue', 'faves', 'done', 'search']) {
      await page.evaluate(t => document.querySelector(`[data-tab="${t}"]`)?.click(), t);
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(SHOTS, '3-tabs.png') });
    // night recap card draws in Safari's canvas
    const size = await page.evaluate(async () => { const b = await KQRecap.render(KQ.state); return b ? b.size : 0; });
    ok(size > 10000, `recap card renders in WebKit (${Math.round(size / 1024)} KB)`);
    // the TV page in Safari (a Mac or iPad as the screen)
    const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    tv.on('pageerror', e => errors.push('TV: ' + e.message));
    await tv.goto(BASE + '/stage'); await tv.waitForTimeout(2000);
    await tv.screenshot({ path: path.join(SHOTS, '4-tv.png') });
    ok(st, 'server reachable');
    ok(errors.length === 0, `no JavaScript errors in WebKit${errors.length ? ':\n      ' + errors.join('\n      ') : ''}`);
  } catch (e) { failures++; console.error('  ✗', e.message); }
  await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll good on WebKit 🍎');
  process.exit(failures ? 1 : 0);
})();
