'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { Party } = require('./lib/party');
const { YT } = require('./lib/yt');
const { Tunnel } = require('./lib/tunnel');
const { Genres } = require('./lib/genre');

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
const genres = new Genres({ file: path.join(DATA_DIR, 'genres.json'), mock: MOCK });
const party = new Party({ file: path.join(DATA_DIR, 'party.json'), yt, genres });

const app = express();
const pub = path.join(__dirname, 'public');
const viaNet = req => !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
// Over the internet link, guests get the phone remote and the search API — nothing else.
app.use((req, res, next) => {
  if (viaNet(req) && (req.path.startsWith('/media') || req.path.startsWith('/stage'))) return res.status(404).end();
  next();
});
app.get('/', (req, res) => res.sendFile(path.join(pub, 'remote.html')));
app.get('/stage', (req, res) => res.sendFile(path.join(pub, 'stage.html')));
app.use(express.static(pub, { index: false }));
app.use('/media', express.static(yt.cacheDir, { fallthrough: false, maxAge: '1h' }));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json([]);
  try { res.json(await yt.search(q, req.query.karaoke !== '0')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/lookup', async (req, res) => {
  try { res.json(await yt.lookup(String(req.query.url || ''))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
const qr = url => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
let qrSvg = null, netUrl = null, netSvg = null;
const VERSION = require('./package.json').version;
app.get('/api/about', (req, res) => res.json({ version: VERSION }));
app.get('/api/join', async (req, res) => {
  if (!qrSvg) qrSvg = await qr(BASE_URL);
  res.json({ url: BASE_URL, svg: qrSvg, netUrl, netSvg });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const phones = () => new Set([...wss.clients].filter(c => c.role === 'remote' && c.readyState === 1 && c.clientId).map(c => c.clientId)).size;
const stateMsg = ws => ({ type: 'state', state: { ...party.publicState(), phones: phones(), netUrl }, you: { isHost: ws.isHost, pinRequired: !!HOST_PIN, viaNet: ws.viaNet }, serverNow: Date.now() });
const broadcast = () => { for (const c of wss.clients) send(c, stateMsg(c)); };

wss.on('connection', (ws, req) => {
  ws.viaNet = viaNet(req);                            // came in over the internet link (cloudflared connects from localhost!)
  ws.local = !ws.viaNet && isLoopback(req.socket.remoteAddress);   // the party box itself is always host
  ws.isHost = ws.local || (!HOST_PIN && !ws.viaNet);  // internet guests are never host without the PIN
  ws.clientId = null;
  ws.role = 'remote';
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'hello':
        ws.clientId = String(m.clientId || '').slice(0, 64) || null;
        ws.role = m.role === 'stage' ? 'stage' : 'remote';
        if (HOST_PIN && m.pin === HOST_PIN) ws.isHost = true;
        broadcast(); // phone count changed
        break;
      case 'pin': {
        const ok = HOST_PIN ? m.pin === HOST_PIN : !ws.viaNet;
        if (ok) ws.isHost = true;
        send(ws, { type: 'pinResult', ok });
        send(ws, stateMsg(ws));
        break;
      }
      case 'action': {
        const r = party.act(String(m.action || ''), m, { clientId: ws.clientId, isHost: ws.isHost });
        if (m.reqId) send(ws, { type: 'ack', reqId: m.reqId, ...r });
        break;
      }
      case 'react': { // emoji reactions → float up on the TV. Light rate limit per phone.
        const now = Date.now();
        if (now - (ws.lastReact || 0) < 350) break;
        ws.lastReact = now;
        const emoji = ['🔥', '👏', '😂', '❤️', '🎉', '🤘'].includes(m.emoji) ? m.emoji : null;
        if (!emoji) break;
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

server.listen(PORT, () => {
  console.log(`\n  🎤  KARAO-Q ${MOCK ? '(MOCK MODE) ' : ''}running`);
  console.log(`      TV / stage:   http://localhost:${PORT}/stage`);
  console.log(`      Phones join:  ${BASE_URL}`);
  console.log(`      Host PIN:     ${HOST_PIN ? 'set' : 'off (everyone can manage the queue)'}\n`);
});

function shutdown() { party.flush(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
