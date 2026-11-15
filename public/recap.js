'use strict';
// Night recap card: a shareable 1080×1350 image (Instagram portrait) of tonight's stats, awards, singers and mix.
// Drawn on a canvas in the phone's browser, then shared with the phone's share sheet (or downloaded).
(() => {
  const W = 1080, H = 1350;
  const loadImg = src => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  const nkey = n => String(n || '').trim().toLowerCase();
  const COLORS = ['#ff3d9a', '#29e0ff', '#ffd23f', '#a66bff', '#4dff9c', '#ff7a3d', '#3b82ff', '#ff4b4b'];
  const avColor = name => { let h = 0; for (const c of nkey(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
  const initials = n => { const w = String(n || '?').trim().split(/\s+/); return (w[0][0] + (w[1] ? w[1][0] : '')).toUpperCase(); };
  const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
  const EMOJI = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  function fit(ctx, text, maxW, size, weight = 700, min = 18) {
    let s = size;
    do { ctx.font = `${weight} ${s}px ${FONT}`; if (ctx.measureText(text).width <= maxW) return text; s -= 2; } while (s > min);
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }
  function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }

  async function drawAvatar(ctx, name, people, cx, cy, r) {
    const p = people[nkey(name)] || {};
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath();
    if (p.photo) {
      const img = await loadImg(p.photo);
      if (img) {
        ctx.clip();
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, cx - r, cy - r, r * 2, r * 2);
        ctx.restore();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.lineWidth = 4; ctx.strokeStyle = avColor(name); ctx.stroke();
        return;
      }
    }
    ctx.fillStyle = avColor(name); ctx.fill();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (p.preset) { ctx.font = `${Math.round(r * 1.15)}px ${EMOJI}`; ctx.fillText(p.preset, cx, cy + r * 0.06); }
    else { ctx.fillStyle = '#14081f'; ctx.font = `800 ${Math.round(r * 0.8)}px ${FONT}`; ctx.fillText(initials(name), cx, cy + 2); }
    ctx.restore();
  }

  async function render(st) {
    const n = st.night || {};
    const people = st.people || {};
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');

    // background
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#2a0b4a'); bg.addColorStop(0.55, '#140726'); bg.addColorStop(1, '#06101f');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (const [x, y, r, col] of [[120, 90, 380, 'rgba(255,61,154,.28)'], [980, 1250, 460, 'rgba(41,224,255,.18)'], [940, 160, 260, 'rgba(166,107,255,.22)']]) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    // header
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.font = `900 92px ${FONT}`;
    const tg = ctx.createLinearGradient(60, 0, 620, 0); tg.addColorStop(0, '#ff3d9a'); tg.addColorStop(1, '#29e0ff');
    ctx.fillStyle = tg; ctx.shadowColor = 'rgba(255,61,154,.6)'; ctx.shadowBlur = 24;
    ctx.fillText('KARAO-Q', 60, 130); ctx.shadowBlur = 0;
    const start = new Date(n.partyStart || Date.now());
    ctx.fillStyle = '#e9dcff'; ctx.font = `600 34px ${FONT}`;
    ctx.fillText(`🎤 Night recap · ${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`, 64, 186);

    // stat tiles
    const secs = n.singSecs || 0;
    const t = secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m` : `${Math.round(secs / 60)}m`;
    const tiles = [[n.songs || 0, 'songs sung'], [n.singers || 0, 'singers'], [t, 'on the mic'], [n.reacts || 0, 'reactions']];
    const tw = (W - 120 - 3 * 20) / 4;
    tiles.forEach(([v, l], i) => {
      const x = 60 + i * (tw + 20), y = 225;
      rrect(ctx, x, y, tw, 150, 22); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = COLORS[i];
      ctx.fillText(fit(ctx, String(v), tw - 20, 66, 900), x + tw / 2, y + 88);
      ctx.fillStyle = '#c9b8e8'; ctx.font = `600 26px ${FONT}`; ctx.fillText(l, x + tw / 2, y + 128);
    });

    // awards
    let y = 440;
    const aw = (st.awards || []).slice(0, 5);
    ctx.textAlign = 'left';
    if (aw.length) {
      ctx.fillStyle = '#fff'; ctx.font = `800 40px ${FONT}`; ctx.fillText('🏆 Awards', 60, y); y += 26;
      for (const a of aw) {
        rrect(ctx, 60, y, W - 120, 104, 20); ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `52px ${EMOJI}`; ctx.textBaseline = 'middle'; ctx.fillText(a.icon, 84, y + 54);
        await drawAvatar(ctx, a.name.split(' & ')[0], people, 196, y + 52, 38);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#ffd23f'; ctx.fillText(fit(ctx, a.title, 700, 34, 800), 252, y + 46);
        ctx.fillStyle = '#e9dcff'; ctx.fillText(fit(ctx, `${a.name} · ${a.why}`, 760, 28, 500), 252, y + 84);
        y += 118;
      }
      y += 20;
    }

    // singers
    const all = st.stats || [];
    const maxRows = Math.max(1, Math.floor((H - 300 - (y + 50)) / 196)); // leave room for the mix + footer
    const singers = all.slice(0, Math.min(8, maxRows * 4));
    if (singers.length) {
      ctx.fillStyle = '#fff'; ctx.font = `800 40px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText('🎙️ Who sang', 60, y + 10); y += 50;
      const per = Math.min(4, singers.length), cw = (W - 120) / per;
      for (let i = 0; i < singers.length; i++) {
        const s = singers[i], col = i % per, row = Math.floor(i / per);
        const inRow = Math.min(per, singers.length - row * per), off = (per - inRow) * cw / 2; // centre a short last row
        const cx = 60 + off + cw * col + cw / 2, cy = y + 60 + row * 196;
        await drawAvatar(ctx, s.singer, people, cx, cy, 50);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#fff'; ctx.fillText(fit(ctx, (i === 0 && s.sung > 1 ? '👑 ' : '') + s.singer, cw - 16, 28, 700), cx, cy + 86);
        ctx.fillStyle = '#c9b8e8'; ctx.font = `600 24px ${FONT}`; ctx.fillText(`${s.sung} song${s.sung === 1 ? '' : 's'}`, cx, cy + 116);
      }
      y += Math.ceil(singers.length / per) * 196 + 20;
      if (all.length > singers.length) { ctx.textAlign = 'center'; ctx.fillStyle = '#c9b8e8'; ctx.font = `600 26px ${FONT}`; ctx.fillText(`+ ${all.length - singers.length} more singer${all.length - singers.length === 1 ? '' : 's'}`, W / 2, y); y += 50; }
      else y += 20;
    }

    // genre mix bar
    const gm = (st.mix && st.mix.genres) || [];
    if (gm.length && y < H - 200) {
      const total = gm.reduce((a, g) => a + g.n, 0);
      ctx.fillStyle = '#fff'; ctx.font = `800 34px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText("🎨 Tonight's mix", 60, y + 10);
      y += 34;
      let x = 60; const bw = W - 120;
      rrect(ctx, 60, y, bw, 34, 17); ctx.save(); ctx.clip();
      for (const g of gm) { const w = bw * g.n / total; ctx.fillStyle = KQ.gColor(g.k); ctx.fillRect(x, y, w + 1, 34); x += w; }
      ctx.restore();
      ctx.font = `600 24px ${FONT}`; x = 60; y += 70;
      for (const g of gm.slice(0, 5)) {
        const label = `${(KQ.GENRES[g.k] || [g.k])[0]} ${Math.round(100 * g.n / total)}%`;
        ctx.fillStyle = KQ.gColor(g.k); ctx.beginPath(); ctx.arc(x + 10, y - 8, 10, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#e9dcff'; ctx.fillText(label, x + 28, y);
        x += ctx.measureText(label).width + 60;
        if (x > W - 200) break;
      }
    }

    // footer
    ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(233,220,255,.55)'; ctx.font = `600 24px ${FONT}`;
    const longest = n.longest ? `Longest on stage: ${n.longest.who} — ${KQ.clean ? KQ.clean(n.longest.title) : n.longest.title}` : '';
    if (longest) ctx.fillText(fit(ctx, longest, W - 120, 24, 600), W / 2, H - 78);
    ctx.fillStyle = 'rgba(233,220,255,.4)'; ctx.font = `600 22px ${FONT}`;
    ctx.fillText('made with KARAO-Q · github.com/fancy-butler/karaoq', W / 2, H - 38);

    return new Promise(res => c.toBlob(res, 'image/png'));
  }

  // Render, then share (phone share sheet) or fall back to a preview with a download link.
  async function share(st) {
    const blob = await render(st);
    const name = `karaoq-night-${new Date((st.night || {}).partyStart || Date.now()).toISOString().slice(0, 10)}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'KARAO-Q night recap' }); return 'shared'; }
      catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
    }
    return { url: URL.createObjectURL(blob), name };
  }

  window.KQRecap = { render, share };
})();
