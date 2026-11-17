(() => {
  const { act, esc, clean, thumb, dlLabel, toast, now, send, who, keyLabel, gColor, genreChip, mixHtml, avatar, avatars } = KQ;
  const $ = s => document.querySelector(s);
  const app = $('#app'), vid = $('#vid');
  let loaded = null;          // item id currently loaded in the <video>
  let sidePinned = false, drawerOpen = false, joinHidden = false, nextHidden = false; // sidebar shows between songs; Q pins it during songs
  let tagTimer = null, skipArmed = 0;
  let audioCtx = null;
  // shared with stage-panels.js (pre-party check, mics, library, lyrics, restart-to-update)
  window.KQStage = { $, app, vid, toast, unlockAudio: () => unlockAudio(), get audioCtx() { return audioCtx; }, get keyCtx() { return keyCtx; }, panels: null };

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
  fetch('/api/about').then(r => r.json()).then(j => {
    $('#ver').textContent = `v${j.version} · github.com/fancy-butler/karaoq`;
    // Say so when an update has just installed
    let prev = null; try { prev = localStorage.getItem('kq.ver'); localStorage.setItem('kq.ver', j.version); } catch { }
    if (prev && prev !== j.version) {
      const b = document.createElement('div'); b.id = 'updated';
      b.innerHTML = `✨ KARAO-Q updated to <b>v${esc(j.version)}</b><a href="https://github.com/fancy-butler/karaoq/releases/tag/v${esc(j.version)}" target="_blank">what's new</a>`;
      app.appendChild(b); setTimeout(() => b.classList.add('gone'), 9000); setTimeout(() => b.remove(), 10000);
    }
  }).catch(() => { });

  // ---------- player ----------
  function syncPlayer(st) {
    const cur = st.current;
    if ((st.phase === 'playing' || st.phase === 'paused') && cur) {
      // which file: vocals-removed copy if asked for and ready; a live stream if the download isn't done; else the download
      const want = cur.novox && cur.nv && cur.nv.state === 'ready' ? `/media/${cur.videoId}.nv.mp4`
        : cur.stream ? `/stream/${cur.videoId}` : `/media/${cur.videoId}.mp4`;
      if (loaded !== cur.id) {
        loaded = cur.id;
        if (st.settings.introCard !== false) showIntro(cur);
        vid.src = want;
        vid.currentTime = 0;
        flashNowTag();
      } else if (vid.getAttribute('src') !== want && !cur.stream) {
        // vocals switched on/off mid-song: swap files at the same spot
        const t = vid.currentTime, wasPaused = vid.paused;
        vid.src = want;
        vid.addEventListener('loadedmetadata', () => { vid.currentTime = t; if (!wasPaused) tryPlay(); }, { once: true });
        toast(cur.novox ? '🎤✂ Vocals removed' : '🎤 Vocals back');
      }
      if (st.phase === 'playing' && vid.paused) tryPlay();
      if (st.phase === 'paused' && !vid.paused) vid.pause();
    } else if (loaded) {
      loaded = null;
      app.classList.remove('intro', 'showtag');
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
  vid.addEventListener('error', () => { if (loaded && vid.getAttribute('src')) { send({ type: 'playerError', itemId: loaded, message: vid.error ? `media error ${vid.error.code}` : 'error' }); if (!(KQ.state && KQ.state.current && KQ.state.current.stream)) toast("That video wouldn't play — skipping", 'bad'); } });
  setInterval(() => { if (loaded && !vid.paused) send({ type: 'progress', itemId: loaded, t: vid.currentTime, d: vid.duration || 0 }); }, 1000);

  function showAwards(list) {
    if (!list.length) return toast('No awards yet — somebody sing something!', 'bad');
    const n = KQ.state && KQ.state.night;
    $('#awardsSub').innerHTML = n ? `<b>${KQ.dur((KQ.now() - n.partyStart) / 1000)}</b> of party · <b>${n.songs}</b> songs · <b>${n.singers}</b> singers · <b>${KQ.dur(n.singSecs)}</b> of singing · <b>${n.reacts}</b> 🔥` : '';
    $('#awardsGrid').innerHTML = list.map((x, i) => `<div class="acard" style="animation-delay:${i * 0.35}s"><div class="aic">${x.icon}</div>${avatar(x.name.split(' & ')[0], 'l')}<h3>${esc(x.title)}</h3><b>${esc(x.name)}</b><span>${esc(x.why)}</span></div>`).join('');
    app.classList.add('awards'); tada();
    clearTimeout(showAwards.t); showAwards.t = setTimeout(() => app.classList.remove('awards'), 60000);
  }
  $('#awardsShow').onclick = () => app.classList.remove('awards');

  function showIntro(it) {
    $('#introAv').innerHTML = avatars(it, 'xl');
    $('#introName').textContent = who(it);
    $('#introSong').textContent = clean(it.title);
    $('#introGenre').innerHTML = genreChip(it);
    app.classList.add('intro'); tada();
    clearTimeout(showIntro.t); showIntro.t = setTimeout(() => app.classList.remove('intro'), 3500);
  }
  // little "ta-da" for the title card
  function tada() {
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime;
    [[523, 0], [659, .09], [784, .18], [1047, .3]].forEach(([f, dt], i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = i === 3 ? 'triangle' : 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(i === 3 ? 0.12 : 0.05, t0 + dt + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + (i === 3 ? 0.9 : 0.15));
      o.connect(g).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 1);
    });
  }

  function flashNowTag() {
    app.classList.add('showtag');
    clearTimeout(tagTimer); tagTimer = setTimeout(() => app.classList.remove('showtag'), 7000);
  }

  // A little two-note chime when the next singer is called
  function unlockAudio() { try { if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (window.KQMic && KQMic.cfg.out && audioCtx.setSinkId) audioCtx.setSinkId(KQMic.cfg.out).catch(() => { }); } audioCtx.resume(); } catch { } }
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
      if (window.KQMic && KQMic.cfg.out && keyCtx.setSinkId) keyCtx.setSinkId(KQMic.cfg.out).catch(() => { });
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
  KQ.on('react', m => { floatReaction(m.emoji); judge(); });
  // Dance Stage skin: every reaction from the crowd is a "step" — judgement, combo, score
  let judgeT = null, combo = 0, score = 0, lastSongKey = '';
  function showCombo() {
    const c = $('#skinCombo'); if (c) { c.innerHTML = combo > 1 ? `<b>${combo}</b><small>COMBO</small>` : ''; c.classList.remove('bump'); void c.offsetWidth; if (combo > 1) c.classList.add('bump'); }
    const sc = $('#skinScore'); if (sc) sc.textContent = String(score).padStart(7, '0');
    const hi = $('#skinHits'); if (hi) hi.textContent = String(Math.min(999, combo)).padStart(3, '0');
  }
  // other skins answer a reaction in their own chrome (LED panel, vest HUD, diner bell)
  const FLASH = { hall: ['1UP', 'HI', 'b0nUS'], laser: ['HIT!', 'DIRECT HIT!', 'TAGGED!'], diner: ['DING! ORDER UP', 'ENCORE!', 'ORDER UP!'] };
  let flashT = null;
  function skinFlash() {
    const words = FLASH[document.body.dataset.theme]; if (!words) return;
    combo++; showCombo();
    const w = words[Math.floor(Math.random() * words.length)];
    document.querySelectorAll('#skin [data-flash]').forEach(el => { if (!el.dataset.keep) el.dataset.keep = el.textContent; el.textContent = w; });
    document.body.classList.add('kqhit');
    clearTimeout(flashT); flashT = setTimeout(() => {
      document.body.classList.remove('kqhit');
      document.querySelectorAll('#skin [data-flash]').forEach(el => { el.textContent = el.dataset.keep || ''; delete el.dataset.keep; });
      if (KQ.state) render(KQ.state);
    }, 1100);
  }
  function judge() {
    skinFlash();
    const j = $('#skinJudge'); if (!j || document.body.dataset.theme !== 'rhythm') return;
    const r = Math.random();
    const [w, c, pts] = r < .2 ? ['MARVELOUS', 'm', 3000] : r < .65 ? ['PERFECT', 'p', 2000] : ['GREAT', 'g', 1000];
    combo++; score = Math.min(9999999, score + pts + combo * 10); showCombo();
    j.textContent = w; j.className = 'judge ' + c; void j.offsetWidth; j.classList.add('hit');
    clearTimeout(judgeT); judgeT = setTimeout(() => j.classList.remove('hit'), 900);
  }

  KQ.on('cmd', m => {
    if (m.cmd === 'restart') { vid.currentTime = 0; flashNowTag(); }
    if (m.cmd === 'chime') chime();
    if (m.cmd === 'toast') toast(m.text);
    if (m.cmd === 'awards') showAwards(m.awards || []);
  });

  const sungBy = (st, name) => ((st.stats || []).find(x => x.singer.toLowerCase() === String(name).trim().toLowerCase()) || {}).sung || 0;

  // ---------- render ----------
  function render(st) {
    if (st.netUrl !== joinNet) { joinNet = st.netUrl; loadJoin(); }
    app.classList.remove('idle', 'upnext', 'playing', 'paused');
    app.classList.add(st.phase);
    app.classList.toggle('side', st.phase === 'upnext' || sidePinned);
    syncPlayer(st);
    if (st.current) { $('#nowAv').innerHTML = avatars(st.current, 'l'); $('#nowSinger').textContent = who(st.current); $('#nowKey').textContent = st.current.key ? `key ${keyLabel(st.current.key)}` : ''; }
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
      $('#upAvatar').innerHTML = avatars(head, 'xl');
      $('#upSinger').textContent = who(head);
      $('#upSinger').classList.toggle('long', who(head).length > 12);
      $('#upSong').textContent = clean(head.title);
      $('.bgthumb').style.backgroundImage = `url("${thumb(head)}")`;
      const after = st.queue[1];
      $('#upAfter').innerHTML = after ? `then <b>${esc(who(after))}</b> — ${esc(clean(after.title))}` : '';
    }

    // ticker (during song)
    const next = st.queue[0];
    $('#tickSinger').textContent = next ? who(next) : '';
    $('#tickAv').innerHTML = next ? avatars(next, 'm') : '';
    $('#tickSong').textContent = next ? clean(next.title) : '';

    // sidebar
    $('#sideCount').textContent = st.queue.length ? `· ${st.queue.length}` : '';
    $('#sideList').innerHTML = st.queue.length ? st.queue.map((it, i) => {
      const up = i === 0 && st.phase === 'upnext';
      const tint = st.settings.genreRows !== false && it.genre;
      return `<li class="${up ? 'up' : ''} ${tint ? 'tinted' : ''}" style="--g:${it.genre ? gColor(it.genre) : 'transparent'}"><span class="n">${up ? '★' : i + 1}</span><span class="w">${avatars(it, 's')} ${esc(who(it))}${it.key ? `<span class="k">${keyLabel(it.key)}</span>` : ''}${sungBy(st, it.singer) ? `<span class="c">🎤${sungBy(st, it.singer)}</span>` : ''}${it.dl?.state !== 'ready' ? dlLabel(it.dl) : ''}</span><span class="t">${esc(clean(it.title))}</span></li>`;
    }).join('') : '<li><span class="empty">Nobody in line. Scan the code below!</span></li>';
    $('#sideHeld').textContent = st.held.length ? `🚪 Stepped out: ${st.held.map(h => who(h)).join(', ')}` : '';

    // the screen takes on the colour of the song's genre
    const accentFrom = (st.phase === 'playing' || st.phase === 'paused') ? st.current : st.phase === 'upnext' ? st.queue[0] : null;
    app.style.setProperty('--accent', accentFrom && accentFrom.genre ? gColor(accentFrom.genre) : '#ff3d9a');
    $('#upGenre').innerHTML = st.phase === 'upnext' && st.queue[0] ? genreChip(st.queue[0]) : '';
    const mixH = mixHtml(st.mix);
    $('#sideMix').innerHTML = mixH;

    document.body.dataset.theme = st.settings.theme || 'neon';
    document.body.dataset.phase = st.phase;
    document.body.dataset.fx = st.settings.skinFx === false ? '0' : '1';
    // Desktop '95 taskbar: what's on
    const nowTxt = st.current ? `🎤 ${who(st.current)} — ${clean(st.current.title)}` : st.queue[0] ? `⏭ Up next: ${who(st.queue[0])}` : '🎤 KARAO-Q';
    const dmdTxt = st.current ? `NOW SINGING: ${who(st.current)}` : st.queue[0] ? `UP NEXT: ${who(st.queue[0])}` : 'INSERT COIN';
    document.querySelectorAll('#skin .skinnow').forEach(el => { const t = el.closest('.dmd') ? dmdTxt.toUpperCase() : nowTxt; if (el.textContent !== t) el.textContent = t; });
    const songKey = st.current ? st.current.id + '|' + st.current.singer : '';
    if (songKey !== lastSongKey) { lastSongKey = songKey; combo = 0; showCombo(); }
    const cr = $('#skinCredit'); if (cr && !document.body.classList.contains('kqhit')) cr.textContent = String(Math.min(99, st.queue.length)).padStart(2, '0');
    renderAttract(st);

    // songs sung tonight
    const statsHtml = (st.stats || []).map((x, i) => `<span class="st ${i === 0 && x.sung > 1 ? 'top' : ''}">${avatar(x.singer, 's')} ${i === 0 && x.sung > 1 ? '👑 ' : ''}${esc(x.singer)}<i>${x.sung}</i></span>`).join('');
    $('#sideStats').innerHTML = statsHtml;
    const phones = st.phones ? `📱 ${st.phones} connected` : '';
    $('#phonesSide').textContent = phones; $('#phonesCorner').textContent = phones;
    app.classList.toggle('showjoin', st.phase === 'playing' && st.settings.showQr !== false && !joinHidden);
  }

  // ---------- attract mode: the idle screen rotates through what's going on tonight ----------
  const TIPS = [
    "Tap 🙋 <b>Not here</b> if someone's missing — they keep their spot",
    'Tap ☆ on a song to save it to your <b>Faves</b>',
    'Too high? Too low? Use <b>Key − / +</b> on your phone while you sing',
    'Tap 👤 when adding a song to queue it for a friend — or a <b>duet</b>',
    'Mash 🔥 👏 😂 on your phone while someone sings',
  ];
  let attractPanels = [], attractI = 0;
  function renderAttract(st) {
    const panels = [];
    if ((st.stats || []).length) panels.push(`<div class="stats">${(st.stats || []).map((x, i) => `<span class="st ${i === 0 && x.sung > 1 ? 'top' : ''}">${avatar(x.singer, 's')} ${i === 0 && x.sung > 1 ? '👑 ' : ''}${esc(x.singer)}<i>${x.sung}</i></span>`).join('')}</div>`);
    if (st.night && st.night.songs) panels.push(KQ.nightHtml(st.night));
    if (st.mix && st.mix.genres && st.mix.genres.length) panels.push(mixHtml(st.mix));
    const sung = new Set((st.stats || []).map(x => x.singer.toLowerCase()));
    const notYet = Object.values(st.people || {}).filter(p => p.seen >= st.nightStartedAt && !sung.has(p.name.toLowerCase())).slice(0, 10);
    if (notYet.length) panels.push(`<div class="notyet"><h3>Haven't sung yet 👀</h3><div>${notYet.map(p => `<span>${avatar(p.name, 'm')}<b>${esc(p.name)}</b></span>`).join('')}</div></div>`);
    TIPS.forEach(t => panels.push(`<div class="tip">💡 ${t}</div>`));
    attractPanels = panels;
    if (attractI >= panels.length) attractI = 0;
    $('#attract').innerHTML = panels[attractI] || '';
  }
  setInterval(() => {
    if (!KQ.state || KQ.state.phase !== 'idle' || !attractPanels.length) return;
    const el = $('#attract'); el.classList.add('fade');
    setTimeout(() => { attractI = (attractI + 1) % attractPanels.length; el.innerHTML = attractPanels[attractI]; el.classList.remove('fade'); }, 500);
  }, 8000);

  // ---------- OLED care: overlays drift a few pixels; a dark screensaver after 5 idle minutes ----------
  let lastWake = Date.now(), lastSig = '';
  const wake = () => { lastWake = Date.now(); app.classList.remove('saver'); };
  document.addEventListener('mousemove', wake); document.addEventListener('keydown', wake);
  KQ.on('state', st => { const sig = st.phase + st.queue.length + (st.current ? st.current.id : ''); if (sig !== lastSig) { lastSig = sig; wake(); } });
  setInterval(() => {
    const st = KQ.state; if (!st) return;
    const care = st.settings.oledCare !== false;
    app.style.setProperty('--px', care ? `${Math.round(Math.random() * 12 - 6)}px` : '0px');
    app.style.setProperty('--py', care ? `${Math.round(Math.random() * 12 - 6)}px` : '0px');
  }, 90000);
  setInterval(() => {
    const st = KQ.state; if (!st) return;
    if (st.settings.oledCare !== false && st.phase === 'idle' && Date.now() - lastWake > 5 * 60 * 1000) {
      app.classList.add('saver');
      const c = $('#saverCard');
      c.style.left = `${5 + Math.random() * 70}vw`; c.style.top = `${5 + Math.random() * 70}vh`;
    }
  }, 20000);

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
      else if (!st.countdownEndsAt && st.resumeHold) msg = 'Welcome back! Songs from last time are still in line — press Enter (or ▶ Start on a phone) when you\'re ready';
      else if (!st.countdownEndsAt) msg = 'Press Enter when they have the mic';
      $('#upStatus').textContent = msg;
    }
    // "Next up" card stays up the whole song (U or the phone setting hides it)
    const showTicker = (st.phase === 'playing' || st.phase === 'paused') && st.queue.length && st.settings.showNext !== false && !nextHidden;
    app.classList.toggle('showticker', !!showTicker && !app.classList.contains('side'));
  }, 250);

  // Mouse moves → cursor + ☰ Menu appear; both hide again after 3 s still (unless the menu is open)
  let mouseT;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('hidecursor'); app.classList.add('mouse');
    clearTimeout(mouseT);
    mouseT = setTimeout(() => { if (!app.classList.contains('menu')) { document.body.classList.add('hidecursor'); app.classList.remove('mouse'); } }, 3000);
  });
  function setMenu(open) { app.classList.toggle('menu', open); document.body.classList.toggle('menuopen', open); if (open) $('#menuPanel button').focus(); }
  // skin chrome: the arcade "1P START" and the desktop "Start" button open the menu
  document.querySelectorAll('#skin [data-skin="menu"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); setMenu(!app.classList.contains('menu')); }));
  // desktop skins: menu-bar items run the matching menu entry
  document.querySelectorAll('#skin [data-skin-m]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); const t = $(`#menuPanel [data-m="${b.dataset.skinM}"]`); if (t) t.click(); }));
  const clockTick = () => {
    const now = new Date(); const c = $('#skinClock'); if (c) c.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const dc = $('#skin .dclock'); if (dc) { dc.style.setProperty('--h', (now.getHours() % 12) * 30 + now.getMinutes() / 2 + 'deg'); dc.style.setProperty('--m', now.getMinutes() * 6 + 'deg'); }
  };
  clockTick(); setInterval(clockTick, 15000);
  $('#menuPill').onclick = e => { e.stopPropagation(); setMenu(!app.classList.contains('menu')); };
  document.addEventListener('click', e => { if (!e.target.closest('#menuPanel, #menuPill')) setMenu(false); });
  function openDrawerAt(hash) {
    const f = $('#drawerFrame');
    const url = '/?embed=1' + (hash || '');
    if (!f.src || !f.src.endsWith(url)) f.src = url;
    else if (hash) { try { f.contentWindow.location.hash = ''; f.contentWindow.location.hash = hash; } catch { } }
    setDrawer(true);
  }
  $('#menuPanel').onclick = e => {
    const m = e.target.closest('[data-m]')?.dataset.m; if (!m) return;
    setMenu(false);
    const st = KQ.state;
    if (m === 'add') openDrawerAt('');
    if (m === 'awards') showAwards((KQ.state && KQ.state.awards) || []);
    if (m === 'settings') openDrawerAt('#settings');
    if (m === 'queue') { sidePinned = !sidePinned; if (st) render(st); }
    if (m === 'help') { if (!$('#helpAbout').innerHTML) KQ.aboutHtml().then(h => { $('#helpAbout').innerHTML = h; }); app.classList.add('help'); }
    if (m === 'about') { KQ.aboutHtml().then(h => { $('#helpAbout').innerHTML = h; app.classList.add('help'); setTimeout(() => $('#helpAbout').scrollIntoView({ behavior: 'smooth' }), 50); }); }
    if (m === 'full') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => { });
    if (KQStage.panels && KQStage.panels.open(m)) return; // update / library / mics / pre-party check (stage-panels.js)
    if (m === 'quit') { if (confirm('Quit KARAO-Q? The queue is saved.')) window.close(); }
  };

  // ---------- keyboard ----------
  function setDrawer(open) {
    drawerOpen = open;
    if (open && !$('#drawerFrame').getAttribute('src')) $('#drawerFrame').src = '/?embed=1';
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
    // Screen keys (menu, help, fullscreen…) always work — even while the app is still starting up and
    // hasn't heard from the party server yet. Only the queue keys below need the party state.
    const st = KQ.state || { phase: 'idle', queue: [], held: [] };
    const k = e.key;
    if (KQStage.panels && KQStage.panels.onKey(k)) return;
    if (k === 'Escape') { app.classList.remove('pf'); app.classList.remove('mics'); app.classList.remove('lib'); app.classList.remove('awards'); setDrawer(false); setMenu(false); app.classList.remove('help'); return; }
    if (k === 'm' || k === 'M') { setMenu(!app.classList.contains('menu')); return; }
    if (k === 'a' || k === 'A' || k === '/') { e.preventDefault(); setDrawer(!drawerOpen); return; }
    if (k === 'q' || k === 'Q') { sidePinned = !sidePinned; if (KQ.state) render(st); toast(sidePinned ? 'Queue pinned' : 'Queue hides during songs'); return; }
    if (k === '?') { if (!$('#helpAbout').innerHTML) KQ.aboutHtml().then(h => { $('#helpAbout').innerHTML = h; }); app.classList.toggle('help'); return; }
    if (k === 'u' || k === 'U') { nextHidden = !nextHidden; toast(nextHidden ? '"Next up" hidden' : '"Next up" showing'); return; }
    if (k === 'j' || k === 'J') { joinHidden = !joinHidden; if (KQ.state) render(st); toast(joinHidden ? 'Join code hidden' : 'Join code showing'); return; }
    if (k === 'f' || k === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => { }); return; }
    if (!KQ.state) return toast('Still starting up — one moment…');
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
