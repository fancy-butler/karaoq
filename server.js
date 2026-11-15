'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { Party } = require('./lib/party');
const { YT } = require('./lib/yt');
const { Tunnel } = require('./lib/tunnel');
const { Genres } = require('./lib/genre');
const { People } = require('./lib/people');

const PORT = Number(process.env.PORT) || 8080;
const HOST_PIN = String(process.env.HOST_PIN || '').trim();   // empty = everyone can manage the queue
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MOCK = process.env.MOCK === '1';
const USE_TUNNEL = process.env.TUNNEL !== '0';   // TUNNEL=0 → Wi-Fi only

function lanAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal);
  // Prefer typical home-LAN ranges over VPN/docker bridges
  const pick = all.find(a => /^192\.168\./.test(a.address)) || all.find(a => /^10\./.test(a.address)) || all[0];
  return pick ? pick.address : 'localhost';
}
const BASE_URL = process.env.BASE_URL || `http://${lanAddress()}:${PORT}`;

const yt = new YT({ cacheDir: path.join(DATA_DIR, 'cache'), bin: process.env.YTDLP || 'yt-dlp', mock: MOCK });
const { Library } = require('./lib/library');
const library = new Library({ dataDir: DATA_DIR });
yt.library = library;
if (library.dirs.length) setTimeout(() => library.scan(), 2000).unref();
const genres = new Genres({ file: path.join(DATA_DIR, 'genres.json'), mock: MOCK });
const people = new People({ dir: DATA_DIR });
const { Vocals } = require('./lib/vocals');
const vocals = new Vocals({ cacheDir: path.join(DATA_DIR, 'cache') });
yt.on('pruned-nv', id => vocals.st.delete(id));
const { Lyrics } = require('./lib/lyrics');
const lyrics = new Lyrics({ cacheDir: path.join(DATA_DIR, 'cache'), mock: MOCK });
const party = new Party({ file: path.join(DATA_DIR, 'party.json'), yt, genres, people, vocals, lyrics });

const app = express();
const pub = path.join(__dirname, 'public');
const viaNet = req => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
// Over the internet link, guests get the phone remote and the search API — nothing else.
app.use((req, res, next) => {
  if (viaNet(req) && (req.path.startsWith('/media') || req.path.startsWith('/stream') || req.path.startsWith('/stage'))) return res.status(404).end();
  next();
});
app.get('/', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'remote.html')); });
app.get('/stage', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(pub, 'stage.html')); });
// no-cache = phones re-check files every load, so an updated KARAO-Q never runs with stale page code
app.use(express.static(pub, { index: false, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/media', express.static(yt.cacheDir, { fallthrough: false, maxAge: '1h' }));
// Stream-first playback: proxy YouTube's direct stream so the TV can start a song before its download is done.
// Same-origin keeps key change (WebAudio) working; Range requests pass through so seeking works.
const https = require('https');
app.get('/stream/:id', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).end();
  if (MOCK) { await yt.streamUrl(id); return res.sendFile(yt.mockClipFile()); }
  let url;
  try { url = await yt.streamUrl(id); } catch (e) { return res.status(502).end(); }
  const pipe = (u, hops = 0) => {
    const up = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', ...((yt.streamHeaders && yt.streamHeaders.get(id)) || {}), ...(req.headers.range ? { Range: req.headers.range } : {}) } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) { r.resume(); return pipe(r.headers.location, hops + 1); }
      if (r.statusCode >= 400) { yt.streams.delete(id); r.resume(); return res.status(502).end(); }
      res.status(r.statusCode);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers[h]) res.setHeader(h, r.headers[h]);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    req.on('close', () => up.destroy());
  };
  pipe(url);
});
app.use('/avatars', express.static(people.avatarDir, { fallthrough: false, maxAge: '1d' }));
// Selfie upload: the phone crops + shrinks it to a small JPEG first, so this stays tiny.
app.post('/api/avatar', express.json({ limit: '900kb' }), (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const m = String(req.body.data || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!name || !m) return res.status(400).json({ error: 'Bad photo' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 600 * 1024) return res.status(413).json({ error: 'Photo too big' });
  people.setPhoto(name, buf, String(req.body.clientId || '').slice(0, 64) || null);
  if (req.body.keep !== undefined) people.setKeep(name, !!req.body.keep);
  party._emit();
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json([]);
  const local = library.search(q); // 💾 songs from the karaoke library come first
  try { res.json([...local, ...await yt.search(q, req.query.karaoke !== '0')]); }
  catch (e) { local.length ? res.json(local) : res.status(502).json({ error: e.message }); }
});
app.get('/api/lookup', async (req, res) => {
  try { res.json(await yt.lookup(String(req.query.url || ''))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
const qr = url => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
let qrSvg = null, netUrl = null, netSvg = null;
const VERSION = require('./package.json').version;
app.get('/api/stats', (req, res) => res.json(party.personalStats(String(req.query.name || '').slice(0, 40))));
// 💾 karaoke library management. Adding/removing folders only from the TV machine itself (or KQ_LIBRARY in Docker).
const reqLocal = req => isLoopback(req.socket.remoteAddress) && !viaNet(req);
app.get('/api/library', (req, res) => res.json(library.info()));
app.post('/api/library/add', express.json(), async (req, res) => {
  if (!reqLocal(req)) return res.status(403).json({ error: 'Add folders from the TV computer' });
  const dir = String((req.body || {}).dir || '');
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'Folder not found' });
  library.addDir(dir); res.json(library.info());
});
app.post('/api/library/remove', express.json(), (req, res) => {
  if (!reqLocal(req)) return res.status(403).json({ error: 'Remove folders from the TV computer' });
  library.removeDir(String((req.body || {}).dir || '')); res.json(library.info());
});
app.post('/api/library/rescan', (req, res) => { if (viaNet(req)) return res.status(403).end(); library.scan(); res.json({ ok: true }); });
// ✅ Pre-party check: everything that can go wrong before guests arrive, with a one-line fix for each.
// (Phones / speakers / mics are checked live on the TV; this covers the computer's side.)
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took too long`)), ms))]);
app.get('/api/preflight', async (req, res) => {
  if (viaNet(req)) return res.status(403).end();
  const out = [];
  const add = (id, ok, title, detail = '', fix = '') => out.push({ id, ok, title, detail, fix });
  // network address phones will use
  const lan = BASE_URL.replace(/^https?:\/\//, '').split(':')[0];
  const lanOk = lan && !/^(127\.|localhost|0\.0\.0\.0)/.test(lan);
  add('wifi', lanOk ? 'wait' : false, 'Wi-Fi address for phones', lanOk ? `${BASE_URL} — scan the TV's QR with a phone; this turns green when a phone joins over Wi-Fi` : 'No network address found',
    lanOk ? 'If no phone can join over Wi-Fi: the router may keep devices apart (guest network / "AP isolation"), or a firewall is blocking port ' + PORT + ' — use the "Can\'t connect?" code instead.' : 'Connect this computer to the same Wi-Fi as the phones.');
  add('net', netUrl ? true : (USE_TUNNEL ? false : 'skip'), '"Can\'t connect?" internet link', netUrl || (USE_TUNNEL ? 'Not up yet' : 'Turned off (TUNNEL=0)'),
    netUrl ? '' : 'Usually means no internet, or it\'s still starting — wait 30 s and re-run.');
  const tasks = [
    (async () => {
      const v = await withTimeout(yt.version(), 20000, 'yt-dlp');
      const r = await withTimeout(yt.search('dancing queen abba', true), 30000, 'YouTube search');
      if (!r.length) throw new Error('no results');
      await withTimeout(yt.streamUrl(r[0].videoId), 45000, 'YouTube video check');
      add('youtube', true, 'YouTube search & playback', `yt-dlp ${v || '?'} · found "${r[0].title}" and got its video`);
    })().catch(e => add('youtube', false, 'YouTube search & playback', e.message, 'Check the internet connection. If it\'s fine, YouTube may have changed something: restart KARAO-Q (the downloader updates itself on start).')),
    (async () => {
      const { execFile } = require('child_process');
      const v = await withTimeout(new Promise((r, j) => execFile('ffmpeg', ['-hide_banner', '-version'], (e, so) => e ? j(e) : r(so.split('\n')[0]))), 10000, 'ffmpeg');
      add('ffmpeg', true, 'Audio/video tools', v.replace(/Copyright.*/, '').trim());
    })().catch(e => add('ffmpeg', false, 'Audio/video tools', e.message, 'Reinstall KARAO-Q — ffmpeg is missing.')),
    (async () => {
      const st = await fs.promises.statfs(path.join(DATA_DIR, 'cache'));
      const gb = st.bavail * st.bsize / 1e9;
      add('disk', gb > 2, 'Free disk space', `${gb.toFixed(1)} GB free`, gb > 2 ? '' : 'Free up a few GB, or lower "Space for downloaded songs" in settings.');
    })().catch(() => { }),
    (async () => {
      const q = [party.s.current, ...party.s.queue, ...party.s.held].filter(Boolean);
      const faves = Object.values(party.faves || {}).flatMap(f => f.songs || []);
      const ready = list => list.filter(i => yt.status(i.videoId).state === 'ready').length;
      add('songs', true, 'Songs downloaded ahead', `Queue: ${ready(q)}/${q.length} ready · Faves: ${ready(faves)}/${faves.length} ready`,
        faves.length && ready(faves) < faves.length ? 'Faves tab → "Download … faves now" so they start instantly.' : '');
    })().catch(() => { }),
  ];
  const lib = library.info();
  if (lib.dirs.length) {
    const missing = lib.dirs.filter(d => !d.ok);
    add('library', missing.length ? false : true, 'Karaoke library', `${lib.total.toLocaleString()} songs in ${lib.dirs.length} folder(s)${missing.length ? ` · missing: ${missing.map(d => d.dir).join(', ')}` : ''}`, missing.length ? 'Plug the drive in, then ☰ → Karaoke library → Rescan.' : '');
  }
  add('vocals', true, 'Vocal remover', vocals.engine === 'demucs' ? 'AI (Demucs) installed' : 'Quick (built in)', vocals.engine === 'demucs' ? '' : 'Optional: install Demucs for much better vocal removal (see README).');
  await Promise.all(tasks);
  const order = ['wifi', 'net', 'youtube', 'ffmpeg', 'disk', 'songs', 'library', 'vocals'];
  out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  res.json({ checks: out, version: VERSION, phones: phoneCounts() });
});
app.get('/api/foryou', (req, res) => res.json(party.forYou(String(req.query.name || '').slice(0, 40))));
app.get('/api/classics', (req, res) => res.json(require('./lib/classics.json')));
app.get('/api/house', (req, res) => res.json(party.houseFaves()));
app.get('/api/more', (req, res) => res.json(require('./lib/more.json')));
app.get('/api/popular', (req, res) => res.json(require('./lib/popular.json')));
app.get('/api/about', (req, res) => res.json({ version: VERSION, ytdlp: yt.ytVersion, vocals: vocals.info() }));
app.get('/api/join', async (req, res) => {
  if (!qrSvg) qrSvg = await qr(BASE_URL);
  res.json({ url: BASE_URL, svg: qrSvg, netUrl, netSvg });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const phoneCounts = () => { const w = new Set(), n = new Set(); for (const c of wss.clients) if (c.role === 'remote' && c.readyState === 1 && c.clientId && !c.local) (c.viaNet ? n : w).add(c.clientId); return { wifi: w.size, net: n.size }; };
const phones = () => new Set([...wss.clients].filter(c => c.role === 'remote' && c.readyState === 1 && c.clientId).map(c => c.clientId)).size;
// Host rights: the party computer always; a HOST_PIN if one is set; otherwise the party's host mode decides.
const isHost = ws => ws.local || (HOST_PIN ? !!ws.pinOk : party.isHostClient(ws.clientId, ws.viaNet));
const stateMsg = ws => ({ type: 'state', state: { ...party.publicState(), phones: phones(), phoneSplit: phoneCounts(), netUrl }, you: { isHost: isHost(ws), pinRequired: !!HOST_PIN, viaNet: ws.viaNet, hostMode: party.s.settings.hostMode }, serverNow: Date.now() });
const broadcast = () => { for (const c of wss.clients) send(c, stateMsg(c)); };

wss.on('connection', (ws, req) => {
  ws.viaNet = viaNet(req);                            // came in over the internet link (cloudflared connects from localhost!)
  ws.local = !ws.viaNet && isLoopback(req.socket.remoteAddress);   // the party box itself is always host
  ws.clientId = null;
  ws.role = 'remote';
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'hello':
        ws.clientId = String(m.clientId || '').slice(0, 64) || null;
        ws.role = m.role === 'stage' ? 'stage' : 'remote';
        if (HOST_PIN && m.pin === HOST_PIN) ws.pinOk = true;
        broadcast(); // phone count changed
        break;
      case 'pin': {
        const ok = HOST_PIN ? m.pin === HOST_PIN : false;
        if (ok) ws.pinOk = true;
        send(ws, { type: 'pinResult', ok });
        send(ws, stateMsg(ws));
        break;
      }
      case 'action': {
        const r = party.act(String(m.action || ''), m, { clientId: ws.clientId, isHost: isHost(ws), viaNet: ws.viaNet });
        if (m.reqId) send(ws, { type: 'ack', reqId: m.reqId, ...r });
        break;
      }
      case 'react': { // emoji reactions → float up on the TV. Light rate limit per phone.
        const now = Date.now();
        if (now - (ws.lastReact || 0) < 250) break;
        ws.lastReact = now;
        const emoji = ['🔥', '👏', '😂', '❤️', '🎉', '🤘', '😍', '😭', '🤯', '🙌', '💃', '🕺', '🎤', '⭐', '💯', '🍻', '🥂', '👑', '🦄', '💀'].includes(m.emoji) ? m.emoji : null;
        if (!emoji) break;
        party.react();
        for (const c of wss.clients) if (c.role === 'stage') send(c, { type: 'react', emoji });
        break;
      }
      case 'ended': party.ended(m.itemId); break;
      case 'playerError': party.playerError(m.itemId, m.message); break;
      case 'progress': {
        const msg = JSON.stringify({ type: 'progress', itemId: m.itemId, t: Number(m.t) || 0, d: Number(m.d) || 0 });
        for (const c of wss.clients) if (c !== ws && c.role === 'remote' && c.readyState === 1) c.send(msg);
        break;
      }
    }
  });
});

// AUTO_EXIT=1 (set by the launchers): shut down once the stage screen has been closed for 10 s.
// Tracks the stage page's own connection, so it works the same with any browser on any OS.
if (process.env.AUTO_EXIT === '1') {
  let seenStage = false, exitTimer = null;
  const stages = () => [...wss.clients].filter(c => c.role === 'stage' && c.readyState === 1).length;
  const check = () => {
    if (stages() > 0) { seenStage = true; clearTimeout(exitTimer); exitTimer = null; return; }
    if (seenStage && !exitTimer) {
      exitTimer = setTimeout(() => { if (stages() === 0) { console.log('  Stage closed — shutting down. Queue saved.'); shutdown(); } }, 10000);
    }
  };
  wss.on('connection', ws => { ws.on('message', () => setTimeout(check, 50)); ws.on('close', () => setTimeout(check, 50)); });
}

party.on('change', broadcast);
wss.on('connection', ws => ws.on('close', () => setTimeout(broadcast, 100)));
party.on('cmd', cmd => { for (const c of wss.clients) if (c.role === 'stage') send(c, { type: 'cmd', ...cmd }); });

// Keepalive so phones that dozed off get dropped and reconnect cleanly
setInterval(() => { for (const c of wss.clients) { if (c.alive === false) { c.terminate(); continue; } c.alive = false; c.ping(); } }, 30000).unref();
wss.on('connection', ws => { ws.alive = true; ws.on('pong', () => { ws.alive = true; }); });

if (USE_TUNNEL && (!MOCK || process.env.TUNNEL === '1')) {
  const tunnel = new Tunnel(PORT, process.env.CLOUDFLARED || 'cloudflared');
  tunnel.on('url', async u => {
    netUrl = u; netSvg = u ? await qr(u) : null;
    if (u) console.log(`      Internet link: ${u}`);
    broadcast();
  });
  setTimeout(() => tunnel.start(), 300);
  process.on('exit', () => tunnel.stop());
}

// Keep yt-dlp fresh: on startup and twice a day while running (YouTube changes break old versions).
yt.version();
setTimeout(() => yt.selfUpdate('startup'), 5000).unref();
setInterval(() => yt.selfUpdate('scheduled'), 12 * 3600 * 1000).unref();

server.listen(PORT, () => {
  console.log(`\n  🎤  KARAO-Q ${MOCK ? '(MOCK MODE) ' : ''}running`);
  console.log(`      TV / stage:   http://localhost:${PORT}/stage`);
  console.log(`      Phones join:  ${BASE_URL}`);
  console.log(`      Host PIN:     ${HOST_PIN ? 'set' : 'off (everyone can manage the queue)'}\n`);
});

function shutdown() { party.flush(); process.exit(0); }
// One bad request or a weird file shouldn't end the party: log it and keep going.
// (Startup problems like the port being taken still exit — that's what they should do.)
let started = false;
server.on('listening', () => { started = true; });
process.on('uncaughtException', e => {
  console.error('⚠ unexpected error (still running):', e && e.stack || e);
  if (!started) process.exit(1);
});
process.on('unhandledRejection', e => console.error('⚠ unhandled promise rejection (still running):', e && e.stack || e));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
