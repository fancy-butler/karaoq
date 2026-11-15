// Shared client bits: websocket w/ auto-reconnect, client identity, clock sync, helpers.
window.KQ = (() => {
  const ls = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  // crypto.randomUUID needs https; phones hit us over plain http on the LAN.
  let clientId = ls.get('kq.client');
  if (!clientId) { clientId = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join(''); ls.set('kq.client', clientId); }

  const handlers = {};
  const on = (t, fn) => { (handlers[t] ||= []).push(fn); };
  const emit = (t, d) => (handlers[t] || []).forEach(fn => fn(d));

  let ws = null, role = 'remote', offset = 0, reqN = 0;
  const pending = new Map();
  const api = { state: null, you: {}, clientId, ls, on };

  function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  function connect(r) {
    role = r || role;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => { send({ type: 'hello', clientId, role, pin: ls.get('kq.pin') || '' }); emit('conn', true); };
    ws.onclose = () => { emit('conn', false); setTimeout(() => connect(), 1200); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') {
        offset = m.serverNow - Date.now();
        api.state = m.state; api.you = m.you;
        emit('state', m.state);
      } else if (m.type === 'ack') {
        const p = pending.get(m.reqId);
        if (p) { pending.delete(m.reqId); p(m); }
      } else emit(m.type, m);
    };
  }

  function act(action, data = {}) {
    return new Promise(res => {
      if (!ws || ws.readyState !== 1) return res({ ok: false, error: 'Not connected — reconnecting…' });
      const reqId = ++reqN;
      pending.set(reqId, res);
      send({ ...data, type: 'action', action, reqId });
      setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); res({ ok: false, error: 'No response from the party box' }); } }, 8000);
    });
  }

  const now = () => Date.now() + offset;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = sec => { if (!sec && sec !== 0) return ''; sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; };
  // Strip the karaoke-channel noise so titles read like songs
  const clean = t => String(t || '').replace(/\s*[\(\[][^\)\]]*(karaoke|instrumental|lyrics|version|official)[^\)\]]*[\)\]]/gi, '').replace(/\s*[|–-]\s*(karaoke|sing king|karafun).*$/i, '').replace(/\bkaraoke\b/gi, '').replace(/\s{2,}/g, ' ').trim() || t;
  const thumb = it => it.thumb || (it.videoId ? `https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg` : '');

  function dlLabel(dl) {
    if (!dl) return '';
    if (dl.state === 'ready') return '<span class="dl ok">● ready</span>';
    if (dl.state === 'downloading') return `<span class="dl busy">↓ ${dl.pct || 0}%</span>`;
    if (dl.state === 'error') return '<span class="dl bad">✕ download failed</span>';
    return '<span class="dl wait">… queued</span>';
  }

  function toast(msg, kind = '') {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.className = 'show ' + kind;
    clearTimeout(el._t); el._t = setTimeout(() => { el.className = ''; }, 2600);
  }

  // "Stan" or "Stan & Priya" for duets
  const who = it => it ? (it.with ? `${it.singer} & ${it.with}` : it.singer) : '';
  const keyLabel = k => !k ? '' : (k > 0 ? `+${k}` : `−${-k}`);

  // About / credits, shared by the TV screen and the phones
  const CREDITS = [
    ['yt-dlp', 'https://github.com/yt-dlp/yt-dlp', 'fetches the songs', 'Unlicense'],
    ['FFmpeg', 'https://ffmpeg.org', 'video & audio processing', 'GPL — source at ffmpeg.org; static builds via the ffmpeg-static project'],
    ['Deno', 'https://deno.com', 'JavaScript runtime used by yt-dlp', 'MIT'],
    ['cloudflared', 'https://github.com/cloudflare/cloudflared', 'the “Can’t connect?” link', 'Apache-2.0'],
    ['Electron', 'https://www.electronjs.org', 'desktop app shell', 'MIT'],
    ['Node.js', 'https://nodejs.org', 'server runtime', 'MIT'],
    ['Express', 'https://expressjs.com', 'web server', 'MIT'],
    ['ws', 'https://github.com/websockets/ws', 'live sync between phones and TV', 'MIT'],
    ['node-qrcode', 'https://github.com/soldair/node-qrcode', 'QR codes', 'MIT'],
  ];
  async function aboutHtml() {
    let v = '';
    try { v = (await (await fetch('/api/about')).json()).version; } catch { }
    return `<div class="about">
      <h2>🎤 KARAO-<span>Q</span> <small>v${esc(v)}</small></h2>
      <p>Party karaoke with a shared queue from everyone's phones.<br>Made by <b>fancy-butler</b> · <a href="https://github.com/fancy-butler/karaoq" target="_blank" rel="noopener">github.com/fancy-butler/karaoq</a></p>
      <h3>Built on</h3>
      <ul>${CREDITS.map(([n, u, what, lic]) => `<li><a href="${u}" target="_blank" rel="noopener">${n}</a> — ${what} <i>(${esc(lic)})</i></li>`).join('')}</ul>
      <h3>Inspired by</h3>
      <p><a href="https://github.com/vicwomg/pikaraoke" target="_blank" rel="noopener">PiKaraoke</a> and <a href="https://github.com/Zeletochoy/yt-kara" target="_blank" rel="noopener">yt-kara</a>.</p>
      <p class="fine">KARAO-Q is free and open source (MIT). Videos come from YouTube via yt-dlp for private, at-home use; YouTube's terms apply.</p>
    </div>`;
  }

  Object.assign(api, { aboutHtml, who, keyLabel, connect, act, send, now, esc, fmt, clean, thumb, dlLabel, toast });
  return api;
})();
