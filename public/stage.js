(() => {
  const { act, esc, clean, thumb, dlLabel, toast, now, send, who, keyLabel } = KQ;
  const $ = s => document.querySelector(s);
  const app = $('#app'), vid = $('#vid');
  let loaded = null;          // item id currently loaded in the <video>
  let sidePinned = false, drawerOpen = false, joinHidden = false, nextHidden = false; // sidebar shows between songs; Q pins it during songs
  let tagTimer = null, skipArmed = 0;
  let audioCtx = null;

  // ---------- join QR ----------
  let joinNet;
  function loadJoin() {
    fetch('/api/join').then(r => r.json()).then(j => {
      document.querySelectorAll('.qr').forEach(el => { el.innerHTML = j.svg; });
      document.querySelectorAll('.url').forEach(el => { el.textContent = j.url.replace(/^https?:\/\//, ''); });
      document.querySelectorAll('.netqr').forEach(el => { el.innerHTML = j.netSvg || ''; });
      app.classList.toggle('hasnet', !!j.netSvg);
    }).catch(() => { });
  }
  loadJoin();
  fetch('/api/about').then(r => r.json()).then(j => { $('#ver').textContent = `v${j.version} · github.com/fancy-butler/karaoq`; }).catch(() => { });

  // ---------- player ----------
  function syncPlayer(st) {
    const cur = st.current;
    if ((st.phase === 'playing' || st.phase === 'paused') && cur) {
      if (loaded !== cur.id) {
        loaded = cur.id;
        vid.src = `/media/${cur.videoId}.mp4`;
        vid.currentTime = 0;
        flashNowTag();
      }
      if (st.phase === 'playing' && vid.paused) tryPlay();
      if (st.phase === 'paused' && !vid.paused) vid.pause();
    } else if (loaded) {
      loaded = null;
      vid.pause(); vid.removeAttribute('src'); vid.load();
    }
  }
  function tryPlay() {
    vid.play().then(() => app.classList.remove('locked')).catch(err => {
      if (err.name === 'NotAllowedError') app.classList.add('locked');
    });
  }
  $('#unlock').onclick = () => { app.classList.remove('locked'); unlockAudio(); if (keyCtx) keyCtx.resume(); const st = KQ.state; if (st && st.phase === 'playing') tryPlay(); };
  vid.addEventListener('ended', () => { if (loaded) send({ type: 'ended', itemId: loaded }); });
  vid.addEventListener('error', () => { if (loaded && vid.getAttribute('src')) { send({ type: 'playerError', itemId: loaded, message: vid.error ? `media error ${vid.error.code}` : 'error' }); toast("That video wouldn't play — skipping", 'bad'); } });
  setInterval(() => { if (loaded && !vid.paused) send({ type: 'progress', itemId: loaded, t: vid.currentTime, d: vid.duration || 0 }); }, 1000);

  function flashNowTag() {
    app.classList.add('showtag');
    clearTimeout(tagTimer); tagTimer = setTimeout(() => app.classList.remove('showtag'), 7000);
  }

  // A little two-note chime when the next singer is called
  function unlockAudio() { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { } }
  function chime() {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [[660, 0], [990, 0.18]].forEach(([f, dt]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
      o.connect(g).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.7);
    });
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });

  // ---------- key change ----------
  // The audio graph is only built the first time someone changes key, so a plain night never touches WebAudio.
  let keyCtx = null, keyNode = null, keyBuilding = null, lastKey = 0;
  function buildKeyGraph() {
    if (keyBuilding) return keyBuilding;
    keyBuilding = (async () => {
      keyCtx = new (window.AudioContext || window.webkitAudioContext)();
      await keyCtx.audioWorklet.addModule('/pitch-worklet.js');
      const src = keyCtx.createMediaElementSource(vid);
      keyNode = new AudioWorkletNode(keyCtx, 'key-shift', { outputChannelCount: [2] });
      src.connect(keyNode).connect(keyCtx.destination);
    })().catch(e => { console.error(e); toast("Key change isn't supported in this browser", 'bad'); keyBuilding = null; throw e; });
    return keyBuilding;
  }
  async function applyKey(k) {
    if (k === lastKey && (keyNode || !k)) return;
    lastKey = k;
    if (!k && !keyNode) return;
    try { await buildKeyGraph(); } catch { return; }
    if (keyCtx.state !== 'running') { try { await keyCtx.resume(); } catch { } if (keyCtx.state !== 'running') app.classList.add('locked'); }
    keyNode.parameters.get('semitones').setValueAtTime(lastKey, keyCtx.currentTime);
  }

  // ---------- reactions ----------
  function floatReaction(emoji) {
    const el = document.createElement('div');
    el.className = 'react';
    el.textContent = emoji;
    el.style.left = `${70 + Math.random() * 24}vw`;
    el.style.setProperty('--drift', `${(Math.random() - 0.5) * 12}vw`);
    el.style.fontSize = `${48 + Math.random() * 40}px`;
    app.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  KQ.on('react', m => floatReaction(m.emoji));

  KQ.on('cmd', m => {
    if (m.cmd === 'restart') { vid.currentTime = 0; flashNowTag(); }
    if (m.cmd === 'chime') chime();
  });

  const sungBy = (st, name) => ((st.stats || []).find(x => x.singer.toLowerCase() === String(name).trim().toLowerCase()) || {}).sung || 0;

  // ---------- render ----------
  function render(st) {
    if (st.netUrl !== joinNet) { joinNet = st.netUrl; loadJoin(); }
    app.classList.remove('idle', 'upnext', 'playing', 'paused');
    app.classList.add(st.phase);
    app.classList.toggle('side', st.phase === 'upnext' || sidePinned);
    syncPlayer(st);
    if (st.current) { $('#nowSinger').textContent = who(st.current); $('#nowKey').textContent = st.current.key ? `key ${keyLabel(st.current.key)}` : ''; }
    applyKey(st.current && (st.phase === 'playing' || st.phase === 'paused') ? st.current.key || 0 : 0);

    // idle
    $('#idleHeld').textContent = st.held.length ? `${st.held.length} song${st.held.length > 1 ? 's' : ''} parked in "Stepped out"` : '';

    // up next
    const head = st.queue[0];
    if (st.phase === 'upnext' && head) {
      if ($('#upSinger').dataset.id !== head.id) {
        $('#upSinger').dataset.id = head.id;
        const el = $('#upSinger'); el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      }
      $('#upSinger').textContent = who(head);
      $('#upSong').textContent = clean(head.title);
      $('.bgthumb').style.backgroundImage = `url("${thumb(head)}")`;
      const after = st.queue[1];
      $('#upAfter').innerHTML = after ? `then <b>${esc(who(after))}</b> — ${esc(clean(after.title))}` : '';
    }

    // ticker (during song)
    const next = st.queue[0];
    $('#tickSinger').textContent = next ? who(next) : '';
    $('#tickSong').textContent = next ? clean(next.title) : '';

    // sidebar
    $('#sideCount').textContent = st.queue.length ? `· ${st.queue.length}` : '';
    $('#sideList').innerHTML = st.queue.length ? st.queue.map((it, i) => {
      const up = i === 0 && st.phase === 'upnext';
      return `<li class="${up ? 'up' : ''}"><span class="n">${up ? '★' : i + 1}</span><span class="w">${esc(who(it))}${it.key ? `<span class="k">${keyLabel(it.key)}</span>` : ''}${sungBy(st, it.singer) ? `<span class="c">🎤${sungBy(st, it.singer)}</span>` : ''}${it.dl?.state !== 'ready' ? dlLabel(it.dl) : ''}</span><span class="t">${esc(clean(it.title))}</span></li>`;
    }).join('') : '<li><span class="empty">Nobody in line. Scan the code below!</span></li>';
    $('#sideHeld').textContent = st.held.length ? `🚪 Stepped out: ${st.held.map(h => who(h)).join(', ')}` : '';

    // songs sung tonight
    const statsHtml = (st.stats || []).map((x, i) => `<span class="st ${i === 0 && x.sung > 1 ? 'top' : ''}">${i === 0 && x.sung > 1 ? '👑 ' : ''}${esc(x.singer)}<i>${x.sung}</i></span>`).join('');
    $('#idleStats').innerHTML = statsHtml; $('#sideStats').innerHTML = statsHtml;
    const phones = st.phones ? `📱 ${st.phones} connected` : '';
    $('#phonesSide').textContent = phones; $('#phonesCorner').textContent = phones;
    app.classList.toggle('showjoin', st.phase === 'playing' && st.settings.showQr !== false && !joinHidden);
  }

  // Countdown ring + ticker timing, ~4×/s
  setInterval(() => {
    const st = KQ.state; if (!st) return;
    if (st.phase === 'upnext') {
      const head = st.queue[0];
      const total = (st.settings.countdown || 0) * 1000;
      const left = st.countdownEndsAt ? st.countdownEndsAt - now() : null;
      const ring = $('#ring');
      ring.classList.toggle('hide', !st.countdownEndsAt || left <= 0);
      if (left !== null && left > 0) { ring.style.setProperty('--p', String(1 - left / total)); $('#ringNum').textContent = Math.ceil(left / 1000); }
      let msg = '';
      if (head && head.dl?.state !== 'ready') msg = head.dl?.state === 'downloading' ? `Loading video… ${head.dl.pct || 0}%` : head.dl?.state === 'error' ? '⚠ This video failed to download — remove it or pick another version' : 'Waiting for download…';
      else if (!st.countdownEndsAt) msg = 'Press Enter when they have the mic';
      $('#upStatus').textContent = msg;
    }
    // "Next up" card stays up the whole song (U or the phone setting hides it)
    const showTicker = (st.phase === 'playing' || st.phase === 'paused') && st.queue.length && st.settings.showNext !== false && !nextHidden;
    app.classList.toggle('showticker', !!showTicker && !app.classList.contains('side'));
  }, 250);

  // Hide mouse cursor when idle
  let mouseT; document.addEventListener('mousemove', () => { document.body.classList.remove('hidecursor'); clearTimeout(mouseT); mouseT = setTimeout(() => document.body.classList.add('hidecursor'), 2500); });

  // ---------- keyboard ----------
  function setDrawer(open) {
    drawerOpen = open;
    if (open && !$('#drawerFrame').src) $('#drawerFrame').src = '/?embed=1';
    app.classList.toggle('drawer', open);
    if (open) setTimeout(() => { try { $('#drawerFrame').contentWindow.focus(); $('#drawerFrame').contentDocument.querySelector('#q')?.focus(); } catch { } }, 350);
  }
  async function doAct(a, data, ok) { const r = await act(a, data); if (!r.ok) toast(r.error, 'bad'); else if (r.note) toast(r.note); else if (ok) toast(ok); }

  // Keys typed inside the drawer iframe don't reach us; Escape from inside is forwarded below.
  window.addEventListener('message', e => { if (e.data === 'kq:close-drawer') setDrawer(false); });
  $('#drawerFrame').addEventListener('load', () => {
    try { $('#drawerFrame').contentWindow.addEventListener('keydown', e => { if (e.key === 'Escape') { setDrawer(false); window.focus(); } }); } catch { }
  });

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const st = KQ.state; if (!st) return;
    const k = e.key;
    if (k === 'Escape') { setDrawer(false); app.classList.remove('help'); return; }
    if (k === 'a' || k === 'A' || k === '/') { e.preventDefault(); setDrawer(!drawerOpen); return; }
    if (k === 'q' || k === 'Q') { sidePinned = !sidePinned; render(st); toast(sidePinned ? 'Queue pinned' : 'Queue hides during songs'); return; }
    if (k === '?') { if (!$('#helpAbout').innerHTML) KQ.aboutHtml().then(h => { $('#helpAbout').innerHTML = h; }); app.classList.toggle('help'); return; }
    if (k === 'u' || k === 'U') { nextHidden = !nextHidden; toast(nextHidden ? '"Next up" hidden' : '"Next up" showing'); return; }
    if (k === 'j' || k === 'J') { joinHidden = !joinHidden; render(st); toast(joinHidden ? 'Join code hidden' : 'Join code showing'); return; }
    if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => { }); return; }
    if (k === 'Enter') return doAct('startNow');
    if (k === 'n' || k === 'N') return doAct('defer', {}, 'Not here — next person is up');
    if (k === 'h' || k === 'H') return doAct('hold', {}, 'Moved to Stepped out');
    if (k === 'z' || k === 'Z') return doAct('undo', {}, 'Undone');
    if (k === ' ') { e.preventDefault(); return doAct(st.phase === 'paused' ? 'resume' : 'pause'); }
    if (k === 'r' || k === 'R') return doAct('restart');
    if (k === 'ArrowRight' && loaded) { vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 10); return; }
    if (k === 'ArrowLeft' && loaded) { vid.currentTime = Math.max(0, vid.currentTime - 10); return; }
    if (k === 's' || k === 'S') {
      if (!st.current) return;
      if (Date.now() - skipArmed < 2000) { skipArmed = 0; return doAct('skip', {}, 'Skipped'); }
      skipArmed = Date.now(); toast(`Press S again to skip ${who(st.current)}`);
    }
  });

  KQ.on('state', render);
  KQ.on('conn', up => app.classList.toggle('offline', !up));
  KQ.connect('stage');
})();
