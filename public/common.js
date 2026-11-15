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
    if (!msg) return;
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg; el.className = 'show ' + kind;
    clearTimeout(el._t); el._t = setTimeout(() => { el.className = ''; }, 2600);
  }

  // "Stan" or "Stan & Priya" for duets
  const who = it => it ? (it.with ? `${it.singer} & ${it.with}` : it.singer) : '';
  const keyLabel = k => !k ? '' : (k > 0 ? `+${k}` : `−${-k}`);

  // ---------- avatars ----------
  const PRESETS = ['🦊', '🐙', '🦄', '🐸', '🐼', '🦁', '🐯', '🐨', '🐵', '🐧', '🐱', '🐶', '🦉', '🐝', '👽', '🤖', '👻', '🦖', '🎸', '🎤', '🍕', '🌮', '🌈', '⭐'];
  const AV_COLORS = ['#ff3d9a', '#29e0ff', '#ffd23f', '#a66bff', '#4dff9c', '#ff7a3d', '#3b82ff', '#ff4b4b'];
  const nkey = n => String(n || '').trim().toLowerCase();
  const person = name => (api.state && api.state.people || {})[nkey(name)] || null;
  function avColor(name) { let h = 0; for (const c of nkey(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return AV_COLORS[h % AV_COLORS.length]; }
  function initials(name) { const w = String(name || '?').trim().split(/\s+/); return (w[0][0] + (w[1] ? w[1][0] : '')).toUpperCase(); }
  // size: s 28px · m 44px · l 72px · xl (TV up-next)
  function avatar(name, size = 'm') {
    const p = person(name);
    if (p && p.photo) return `<img class="av av-${size}" src="${esc(p.photo)}" alt="">`;
    if (p && p.preset) return `<span class="av av-${size} emo" style="--avc:${avColor(name)}">${p.preset}</span>`;
    return `<span class="av av-${size}" style="--avc:${avColor(name)}">${esc(initials(name))}</span>`;
  }
  const avatars = (it, size) => it ? (it.with ? `<span class="avpair">${avatar(it.singer, size)}${avatar(it.with, size)}</span>` : avatar(it.singer, size)) : '';
  const isHostName = name => !!(person(name) || {}).host;

  // ---------- genres ----------
  const GENRES = {
    pop: ['Pop', '#ff4fa3'], rock: ['Rock', '#ff4b4b'], metal: ['Metal', '#8f9bb3'], punk: ['Punk', '#b6ff3b'],
    hiphop: ['Hip-hop', '#ffae2b'], rnb: ['R&B / Soul', '#a66bff'], disco: ['Disco / Funk', '#ffd23f'],
    country: ['Country', '#c8925a'], electronic: ['Electronic', '#29e0ff'], latin: ['Latin', '#ff7a3d'],
    jazz: ['Jazz / Blues', '#3b82ff'], folk: ['Folk', '#5fd38d'], musical: ['Musicals', '#e0b3ff'], kpop: ['K-pop / J-pop', '#40f0c0'],
  };
  const gColor = g => (GENRES[g] || [])[1] || '#ff3d9a';
  const genreChip = it => it && it.genre && GENRES[it.genre] ? `<span class="gchip" style="--g:${GENRES[it.genre][1]}">${esc(GENRES[it.genre][0])}${it.year ? ` · ’${String(Math.floor(it.year / 10) * 10).slice(2)}s` : ''}</span>` : '';
  // stacked colour bar + legend for tonight's genre mix
  function mixHtml(mix) {
    if (!mix || !mix.genres || !mix.genres.length) return '';
    const total = mix.genres.reduce((a, x) => a + x.n, 0);
    const pct = n => Math.round((n / total) * 100);
    return `<div class="mix"><div class="mixbar">${mix.genres.map(x => `<i style="flex:${x.n};background:${gColor(x.k)}" title="${esc((GENRES[x.k] || [x.k])[0])}"></i>`).join('')}</div>
      <div class="mixlegend">${mix.genres.slice(0, 6).map(x => `<span><b style="background:${gColor(x.k)}"></b>${pct(x.n)}% ${esc((GENRES[x.k] || [x.k])[0])}</span>`).join('')}</div>
      ${mix.decades && mix.decades.length ? `<div class="mixdec">${mix.decades.slice(0, 5).map(d => `${esc(d.k)} <em>${pct(d.n)}%</em>`).join(' · ')}</div>` : ''}</div>`;
  }

  // ---------- tonight in numbers ----------
  const dur = secs => { secs = Math.max(0, Math.round(secs)); const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; };
  function nightHtml(n) {
    if (!n) return '';
    const partySecs = (now() - n.partyStart) / 1000;
    const perHour = partySecs > 600 ? (n.songs / (partySecs / 3600)).toFixed(1) : '–';
    const tile = (icon, val, label) => `<div class="nt"><i>${icon}</i><b>${val}</b><span>${label}</span></div>`;
    return `<div class="night">
      <div class="ntiles">
        ${tile('⏱️', `<span data-since="${n.partyStart}">${dur(partySecs)}</span>`, 'party time')}
        ${tile('🎤', n.songs, `song${n.songs === 1 ? '' : 's'} sung`)}
        ${tile('🧑‍🎤', n.singers, `singer${n.singers === 1 ? '' : 's'}`)}
        ${tile('🎶', dur(n.singSecs), 'of singing')}
        ${tile('📈', perHour, 'songs / hour')}
        ${tile('🔥', n.reacts, 'reactions')}
        ${tile('⏳', n.queueSongs ? dur(n.queueSecs) : '—', `in line${n.queueSongs ? ` (${n.queueSongs})` : ''}`)}
        ${n.skipped ? tile('⏭️', n.skipped, 'skipped') : ''}
      </div>
      ${n.longest ? `<p class="nlong">Longest: <b>${esc(clean(n.longest.title))}</b> — ${esc(n.longest.who)} (${dur(n.longest.secs)})</p>` : ''}
    </div>`;
  }
  // keep "party time" ticking without a full re-render
  setInterval(() => document.querySelectorAll('[data-since]').forEach(el => { el.textContent = dur((now() - Number(el.dataset.since)) / 1000); }), 20000);

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
    let v = '', yd = '';
    try { const j = await (await fetch('/api/about')).json(); v = j.version; yd = j.ytdlp || ''; } catch { }
    return `<div class="about">
      <h2>🎤 KARAO-<span>Q</span> <small>v${esc(v)}</small></h2>${yd ? `<p class="fine">YouTube downloader (yt-dlp) ${esc(yd)} — keeps itself up to date</p>` : ''}
      <p>Party karaoke with a shared queue from everyone's phones.<br>Made by <b>fancy-butler</b> · <a href="https://github.com/fancy-butler/karaoq" target="_blank" rel="noopener">github.com/fancy-butler/karaoq</a></p>
      <h3>Built on</h3>
      <ul>${CREDITS.map(([n, u, what, lic]) => `<li><a href="${u}" target="_blank" rel="noopener">${n}</a> — ${what} <i>(${esc(lic)})</i></li>`).join('')}</ul>
      <h3>Inspired by</h3>
      <p><a href="https://github.com/vicwomg/pikaraoke" target="_blank" rel="noopener">PiKaraoke</a> and <a href="https://github.com/Zeletochoy/yt-kara" target="_blank" rel="noopener">yt-kara</a>.</p>
      <p class="fine">KARAO-Q is free and open source (MIT). Videos come from YouTube via yt-dlp for private, at-home use; YouTube's terms apply.</p>
    </div>`;
  }

  Object.assign(api, { dur, nightHtml, PRESETS, avatar, avatars, person, isHostName, GENRES, gColor, genreChip, mixHtml, aboutHtml, who, keyLabel, connect, act, send, now, esc, fmt, clean, thumb, dlLabel, toast });
  return api;
})();
