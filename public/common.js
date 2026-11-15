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

  Object.assign(api, { who, keyLabel, connect, act, send, now, esc, fmt, clean, thumb, dlLabel, toast });
  return api;
})();
