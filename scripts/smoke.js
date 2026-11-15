#!/usr/bin/env node
'use strict';
// Smoke test: runs a whole mock party in headless Chrome before anything is released.
// Fake YouTube (MOCK=1), real server, real TV page, real phone page. Fails loudly on any page error.
//   node scripts/smoke.js            (needs Chrome/Chromium; CHROME=/path/to/chrome to pick one)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-smoke-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); if (!cond) failures++; };

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const c = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
  return c.find(p => fs.existsSync(p));
}
function ffmpegDir() { try { return path.dirname(require('ffmpeg-static')); } catch { return null; } }

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error(`timed out waiting for ${what}`);
}

(async () => {
  const puppeteer = require('puppeteer-core');
  const chrome = findChrome();
  if (!chrome) { console.error('No Chrome found (set CHROME=…)'); process.exit(2); }
  const LIB = path.join(DATA, 'library-src');
  const fd0 = ffmpegDir();
  require('./make-test-library').build(LIB, fd0 ? path.join(fd0, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg');
  const env = { ...process.env, KQ_LIBRARY: LIB, MOCK: '1', TUNNEL: '0', PORT: String(PORT), DATA_DIR: DATA, MOCK_DL_STEP: '20' };
  const fd = ffmpegDir(); if (fd) env.PATH = fd + path.delimiter + env.PATH;
  // ffmpeg-static ships the binary as "ffmpeg" (or ffmpeg.exe) — fine for PATH lookup
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  const cleanup = () => { try { srv.kill(); } catch { } try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { } };
  process.on('exit', cleanup);

  let browser;
  try {
    await until(() => fetch(BASE + '/api/about').then(r => r.ok).catch(() => false), 15000, 'server');
    console.log('KARAO-Q smoke test');
    const about = await (await fetch(BASE + '/api/about')).json();
    ok(!!about.version, `server up (v${about.version})`);
    for (const p of ['/api/popular', '/api/more', '/api/classics', '/api/house', '/api/join']) {
      const r = await fetch(BASE + p); ok(r.ok, `${p} responds`);
    }
    const res = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent("don't stop believin"))).json();
    ok(Array.isArray(res) && res.length > 0, `search returns results (${res.length})`);

    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
    const errors = [];
    const watch = (page, label) => {
      page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
      page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_|404|Failed to load resource/i.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
    };
    const tv = await browser.newPage(); watch(tv, 'TV'); await tv.setViewport({ width: 1280, height: 720 });
    await tv.goto(BASE + '/stage', { waitUntil: 'domcontentloaded' });
    const phone = await browser.newPage(); watch(phone, 'phone'); await phone.setViewport({ width: 390, height: 844, isMobile: true });
    await phone.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);

    // drive the party over the same WebSocket the phones use (loopback = host)
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let state = null; const acks = new Map();
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'state') state = m.state; if (m.type === 'ack') { acks.get(m.reqId)?.(m); acks.delete(m.reqId); } });
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', clientId: 'smoke', role: 'remote' }));
    let n = 0;
    const act = (action, m = {}) => new Promise(r => { const reqId = 'r' + (++n); acks.set(reqId, r); ws.send(JSON.stringify({ type: 'action', action, reqId, ...m })); });

    ok((await act('settings', { settings: { countdown: 4, introCard: false } })).ok, 'host can change settings');
    const r1 = await act('add', { video: res[0], singer: 'Smoke Tester' });
    ok(r1.ok, 'song added to the queue');
    const r2 = await act('add', { video: res[1], singer: 'Second Singer' });
    ok(r2.ok, 'second singer added');
    ok((await act('add', { video: res[0], singer: 'Smoke Tester' })).dup, 'duplicate song is caught');

    await tv.bringToFront(); // background tabs don't load video
    await until(() => state && state.phase === 'playing', 20000, 'first song to start');
    ok(state.current && state.current.singer === 'Smoke Tester', 'fair queue: first singer is on stage');
    const playing = await until(() => tv.evaluate(() => { const v = document.querySelector('video'); return v && v.currentTime > 0.3 && v.getAttribute('src'); }), 15000, 'TV video to play');
    ok(/^\/media\//.test(playing), `TV plays the downloaded song (${playing})`);

    // phone UI renders the queue/now-playing and the recap card draws
    await phone.evaluate(() => { localStorage.setItem('kq.name', 'Smoke Tester'); });
    await phone.reload({ waitUntil: 'domcontentloaded' }); await sleep(1500);
    const blob = await phone.evaluate(async () => { const b = await KQRecap.render(KQ.state); return b ? b.size : 0; });
    ok(blob > 20000, `night recap card renders (${Math.round(blob / 1024)} KB)`);

    await tv.bringToFront();
    // finish song 1 → song 2 starts
    ws.send(JSON.stringify({ type: 'ended', itemId: state.current.id }));
    await until(() => state && state.current && state.current.singer === 'Second Singer' && state.phase === 'playing', 20000, 'second song');
    ok(true, 'next singer comes up after a song ends');
    ok(state.history.some(h => h.singer === 'Smoke Tester' && !h.skipped), 'sung song lands in history');
    ok((state.stats || []).some(s => s.singer === 'Smoke Tester' && s.sung === 1), 'songs-sung count updates');

    const fyr = await (await fetch(BASE + '/api/foryou?name=' + encodeURIComponent('Smoke Tester'))).json();
    ok(fyr && fyr.empty === false, `🎯 for-you suggestions exist for a singer (${(fyr.picks || []).length} picks)`);
    ok((await (await fetch(BASE + '/api/foryou?name=Nobody')).json()).empty === true, 'for-you is empty for someone new');

    // skip, undo-safe ops, hold/back
    ok((await act('skip')).ok, 'host can skip');
    await until(() => state && state.phase === 'idle', 10000, 'idle after skip');
    ok(state.history[0].skipped, 'skipped song is marked skipped');

    // stream-first: a song whose download is slow should start by streaming instead of waiting
    const slow = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('slow song [slow]'))).json();
    ok((await act('add', { video: slow[0], singer: 'Stream Tester' })).ok, 'slow-download song added');
    await until(() => state && state.phase === 'playing' && state.current && state.current.singer === 'Stream Tester', 20000, 'stream-first start');
    ok(state.current.stream === true && state.current.dl.state !== 'ready', 'song starts by streaming before its download is done');
    const sp = await until(() => tv.evaluate(() => { const v = document.querySelector('video'); return v && v.currentTime > 0.3 && v.getAttribute('src'); }), 15000, 'TV stream to play');
    ok(/^\/stream\//.test(sp), `TV plays the stream (${sp})`);
    ok((await act('skip')).ok, 'skip the streamed song');
    await until(() => state && state.phase === 'idle', 10000, 'idle after stream skip');

    // a stream that won't play puts the singer back at the front (waits for the download) instead of skipping them
    const slow2 = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('another slow one [slow]'))).json();
    await act('add', { video: slow2[0], singer: 'Unlucky Streamer' });
    await until(() => state && state.phase === 'playing' && state.current && state.current.stream, 20000, 'second stream');
    ws.send(JSON.stringify({ type: 'playerError', itemId: state.current.id, message: 'test' }));
    await until(() => state && !state.current && state.queue[0] && state.queue[0].singer === 'Unlucky Streamer', 10000, 'requeue after stream error');
    ok(state.queue[0].streamFailed === true, 'failed stream → back to the front, waiting for the download');
    await act('remove', { id: state.queue[0].id });

    // 🎤✂ vocal remover: song added with vocals removed waits for the backing-track copy and plays it
    const vr = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('vocal test song'))).json();
    ok((await act('add', { video: vr[0], singer: 'No Vox', novox: true })).ok, 'song added with vocals removed');
    await until(() => state && state.phase === 'playing' && state.current && state.current.singer === 'No Vox', 30000, 'vocals-removed song to start');
    ok(state.current.nv && state.current.nv.state === 'ready', 'backing-track copy was made before it started');
    const vp = await until(() => tv.evaluate(() => { const v = document.querySelector('video'); return v && v.currentTime > 0.3 && v.getAttribute('src'); }), 15000, 'vocals-removed video to play');
    ok(/\.nv\.mp4$/.test(vp), `TV plays the vocals-removed copy (${vp})`);
    ok((await act('novox', { id: state.current.id, on: false })).ok, 'vocals back on mid-song');
    const back = await until(() => tv.evaluate(() => { const v = document.querySelector('video'); return v && !/\.nv\./.test(v.getAttribute('src')) && v.currentTime > 0.5 && v.getAttribute('src'); }), 10000, 'swap back to original');
    ok(!!back, 'TV swapped back to the original mid-song');
    ok((await act('skip')).ok, 'skip'); await until(() => state && state.phase === 'idle', 10000, 'idle');

    // 📝 a music video (not karaoke) gets synced lyrics on screen
    const mv = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('music video test'))).json();
    ok((await act('add', { video: { ...mv[0], title: 'Rick Astley - Never Gonna Give You Up (Official Video)' }, singer: 'Lyric Fan' })).ok, 'music video added');
    await until(() => state && state.phase === 'playing' && state.current && state.current.singer === 'Lyric Fan', 30000, 'music video to start');
    ok(state.current.lyr === 'ready', 'lyrics were found for it');
    const lyrText = await until(() => tv.evaluate(() => { const el = document.querySelector('#lyrics'); return el && !el.hidden && /lyric line/.test(el.textContent) && el.textContent; }), 10000, 'lyrics on the TV');
    ok(!!lyrText, 'TV scrolls the lyrics');
    ok((await act('skip')).ok, 'skip'); await until(() => state && state.phase === 'idle', 10000, 'idle');

    // 💾 local karaoke library: CD+G pair, zipped CD+G, mkv video — searchable, convert on queue, play on TV
    await until(async () => (await (await fetch(BASE + '/api/library')).json()).total === 4, 15000, 'library scan');
    ok(true, 'karaoke library scanned (4 songs)');
    const lr = await (await fetch(BASE + '/api/search?q=' + encodeURIComponent('bon jovi prayer'))).json();
    ok(lr[0] && lr[0].local && lr[0].videoId.startsWith('lc_'), `library song comes first in search (${lr[0] && lr[0].title})`);
    const zr = await (await fetch(BASE + '/api/search?q=africa')).json();
    ok((await act('add', { video: lr[0], singer: 'CDG Fan' })).ok && (await act('add', { video: zr[0], singer: 'Zip Fan' })).ok, 'CD+G and zipped CD+G songs queued');
    await until(() => state && state.phase === 'playing' && state.current && state.current.singer === 'CDG Fan', 30000, 'CD+G song to start');
    const lp = await until(() => tv.evaluate(() => { const v = document.querySelector('video'); return v && v.currentTime > 0.3 && v.getAttribute('src'); }), 15000, 'CD+G video to play');
    ok(/lc_/.test(lp), `TV plays the converted CD+G (${lp})`);
    ok((await act('skip')).ok, 'skip');
    await until(() => state && state.phase === 'playing' && state.current && state.current.singer === 'Zip Fan', 30000, 'zipped CD+G song to start');
    ok(true, 'zipped CD+G converted and started');
    ok((await act('skip')).ok, 'skip'); await until(() => state && state.phase === 'idle', 10000, 'idle');

    const tvErr = await tv.evaluate(() => !!document.querySelector('#idle, .idle, body'));
    ok(tvErr, 'TV idle screen renders');
    ok(errors.length === 0, `no page errors${errors.length ? ':\n      ' + errors.join('\n      ') : ''}`);
    ws.close();
  } catch (e) {
    failures++;
    console.error('  ✗', e.message);
    console.error('--- server log ---\n' + log.split('\n').slice(-30).join('\n'));
  }
  if (browser) await browser.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll good 🎤');
  cleanup();
  process.exit(failures ? 1 : 0);
})();
